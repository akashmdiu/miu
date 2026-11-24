import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
const roles = {
  free: { repo: 'WPDevelopers/xspeed', word: 'Free' },
  pro: { repo: 'WPDevelopers/xspeed-pro', word: 'Pro' },
  hub: { repo: 'WPDevelopers/xspeed-hub', word: 'Hub' },
};
const repos = {
  [roles.free.repo]: [
    { number: 896, head: { ref: 'shared' } },
    { number: 897, head: { ref: 'explicit' } },
  ],
  [roles.pro.repo]: [{ number: 366, head: { ref: 'shared' } }],
};
mock.module('../lib/project.mjs', { namedExports: { roles: () => roles } });
mock.module('../lib/github.mjs', {
  namedExports: {
    validRepo: (repo) => Object.values(roles).some((role) => role.repo === repo),
    restAll: async (path) => repos[path.split('/').slice(1, 3).join('/')] ?? [],
  },
});
const { findPartners, testTogether } = await import('../lib/pairs.mjs');
const hub = { number: 711, headRefName: 'shared' };

test('a body without a "Test together" heading keeps the old pairing', () => {
  assert.equal(testTogether('Fixes #1\n\n## Related PRs\n\n| xspeed | #896 |'), null);
  assert.equal(testTogether(''), null);
  assert.equal(testTogether(undefined), null);
});

test('the "Test together" section ends at the next heading of its level or higher', () => {
  const body = ['Intro names Pro #9.', '', '## Test together', '', '- WPDevelopers/xspeed#896', '### Why', 'Free first.', '', '## Related PRs', '', '| WPDevelopers/xspeed-pro | #366 |'].join('\n');
  const s = testTogether(body);
  assert.match(s, /xspeed#896/);
  assert.match(s, /Free first/);
  assert.doesNotMatch(s, /#366/);
  assert.doesNotMatch(s, /Pro #9/);
});

test('an empty "Test together" section is an empty list, not a missing one', () => {
  assert.equal(testTogether('## Test together\n\nNone.\n\n## Related PRs\n\n| xspeed | #896 |').trim(), 'None.');
});

test('an explicit None prevents pairing even when branches match', async () => {
  const body = '## Test together\nNone.\n## Stack\nHub #710\n## Related PRs\nFree #896, Pro #366';
  assert.deepEqual(await findPartners(roles.hub.repo, { ...hub, body }), {});
});

test('an explicit list wins over matching branches and related links', async () => {
  const body = '## Test together\nFree #897\n## Stack\nHub #710\n## Related PRs\nFree #896, Pro #366';
  const partners = await findPartners(roles.hub.repo, { ...hub, body });
  assert.deepEqual(Object.keys(partners), ['free']);
  assert.equal(partners.free.number, 897);
});

test('a PR without an explicit list still pairs by matching branch', async () => {
  const partners = await findPartners(roles.hub.repo, { ...hub, body: '' });
  assert.equal(partners.free.number, 896);
  assert.equal(partners.pro.number, 366);
});
