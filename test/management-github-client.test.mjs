import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const installationCalls = [];
const secretReads = [];

mock.module('../lib/ghapp.mjs', {
  exports: {
    installationToken: async (owner, options) => {
      installationCalls.push({ owner, options });
      return `${owner}-${options?.repositories?.[0] ?? 'all'}-app-token`;
    },
  },
});
mock.module('../lib/connections.mjs', {
  exports: {
    readSecret: (...args) => {
      secretReads.push(args);
      return null;
    },
  },
});

const { rest, restAll } = await import('../lib/github.mjs');
const { withGitHubPolicy } = await import('../lib/github-policy.mjs');
const policy = { mode: 'app-only', repositories: ['team/one', 'team/two'] };

function resetCalls() {
  installationCalls.length = 0;
  secretReads.length = 0;
}

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return handler(String(url), options);
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const response = (status, body = '{}') => new Response(body, { status });

test('managed REST requests ask for a repository-scoped installation token per allowed repo', async () => {
  resetCalls();
  await withFetch(() => response(200), async (requests) => {
    await withGitHubPolicy(policy, async () => {
      await rest('GET', 'repos/team/one/issues/1');
      await rest('GET', 'repos/team/two/issues/2');
    });
    assert.deepEqual(installationCalls, [
      { owner: 'team', options: { repositories: ['one'] } },
      { owner: 'team', options: { repositories: ['two'] } },
    ]);
    assert.deepEqual(requests.map(({ url, options }) => ({
      url,
      tokenMatchesRepo: options.headers.Authorization === `Bearer team-${url.includes('/one/') ? 'one' : 'two'}-app-token`,
    })), [
      { url: 'https://api.github.com/repos/team/one/issues/1', tokenMatchesRepo: true },
      { url: 'https://api.github.com/repos/team/two/issues/2', tokenMatchesRepo: true },
    ]);
    assert.equal(secretReads.length, 0);
  });
});

for (const status of [403, 404]) {
  test(`managed REST does not fall back after HTTP ${status}`, async () => {
    resetCalls();
    await withFetch(() => response(status), async (requests) => {
      await withGitHubPolicy(policy, async () => {
        await assert.rejects(rest('GET', 'repos/team/one/issues/1'), (error) => error.message.includes(`HTTP ${status}`));
      });
      assert.equal(requests.length, 1);
      assert.equal(installationCalls.length, 1);
      assert.equal(secretReads.length, 0);
    });
  });
}

test('managed REST does not retry after a transport error or HTTP 502', async () => {
  for (const fail of [
    () => { throw new Error('synthetic transport failure'); },
    () => response(502),
  ]) {
    resetCalls();
    await withFetch(fail, async (requests) => {
      await withGitHubPolicy(policy, async () => {
        await assert.rejects(rest('GET', 'repos/team/one/issues/1'));
      });
      assert.equal(requests.length, 1);
      assert.equal(installationCalls.length, 1);
      assert.equal(secretReads.length, 0);
    });
  }
});

test('managed REST refuses fallback and caller tokens before making a request', async () => {
  resetCalls();
  await withFetch(() => response(200), async (requests) => {
    await withGitHubPolicy(policy, async () => {
      await assert.rejects(rest('GET', 'repos/team/one/issues/1', { fallback: true }), { code: 'identity_unavailable' });
      await assert.rejects(rest('GET', 'repos/team/one/issues/1', { token: 'synthetic-personal-token' }), { code: 'identity_unavailable' });
    });
    assert.equal(requests.length, 0);
    assert.equal(installationCalls.length, 0);
    assert.equal(secretReads.length, 0);
  });
});

test('disallowed managed repository is rejected before token lookup', async () => {
  resetCalls();
  await withFetch(() => response(200), async (requests) => {
    await withGitHubPolicy(policy, async () => {
      assert.throws(() => rest('GET', 'repos/team/three/issues/1'), { code: 'repository_not_allowed' });
    });
    assert.equal(requests.length, 0);
    assert.equal(installationCalls.length, 0);
    assert.equal(secretReads.length, 0);
  });
});

test('managed pagination cannot forward credentials to another origin or follow redirects', async () => {
  resetCalls();
  let fetches = 0;
  await withFetch((_url, options) => {
    assert.equal(++fetches, 1);
    assert.equal(options.redirect, 'error');
    return new Response('[]', { headers: { Link: '<https://outside.invalid/graphql>; rel="next"' } });
  }, async (requests) => {
    await withGitHubPolicy(policy, async () => {
      await assert.rejects(restAll('repos/team/one/issues'), { code: 'repository_not_allowed' });
    });
    assert.equal(requests.length, 1);
    assert.equal(installationCalls.length, 1);
  });
});

test('managed provider output is bounded without retrying or exposing its body', async () => {
  await withFetch(() => new Response('x'.repeat(8 * 1024 * 1024 + 1)), async (requests) => {
    await withGitHubPolicy(policy, async () => {
      await assert.rejects(rest('GET', 'repos/team/one/issues/1'), { code: 'effect_unknown' });
    });
    assert.equal(requests.length, 1);
  });
});
