import test from 'node:test';
import assert from 'node:assert/strict';
import { currentGitHubPolicy, configureGitHubPolicy, withGitHubPolicy, assertGitHubRepository } from '../lib/github-policy.mjs';

test('scoped policy freezes repositories and enforces exact app-only allowlist', async () => {
  const policy = { mode: 'app-only', repositories: ['owner/repo'] };
  await withGitHubPolicy(policy, async () => {
    assert.deepEqual(currentGitHubPolicy(), { mode: 'app-only', repositories: ['owner/repo'] });
    assert.equal(Object.isFrozen(currentGitHubPolicy()), true);
    assert.equal(assertGitHubRepository('owner/repo'), 'owner/repo');
    assert.throws(() => assertGitHubRepository('owner/other'), { code: 'repository_not_allowed' });
    assert.equal(assertGitHubRepository('OWNER/REPO'), 'OWNER/REPO');
    assert.throws(() => withGitHubPolicy({ mode: 'app-only', repositories: ['owner/other'] }, () => {}),
      { code: 'policy_downgrade' });
  });
  assert.deepEqual(currentGitHubPolicy(), { mode: 'legacy' });
});

test('scoped policy cannot downgrade an irreversible process policy', () => {
  configureGitHubPolicy({ mode: 'app-only', repositories: ['owner/repo'] });
  assert.throws(() => withGitHubPolicy({ mode: 'legacy' }, () => assert.fail('must reject')),
    { code: 'policy_downgrade' });
});
