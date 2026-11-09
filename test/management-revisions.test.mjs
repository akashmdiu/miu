import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { currentGitHubPolicy } from '../lib/github-policy.mjs';
let response;
let calls = 0;
mock.module('../lib/github.mjs', { exports: { rest: async (method, target) => {
  calls += 1;
  assert.equal(method, 'GET');
  assert.equal(target, 'repos/owner/repo/pulls/1');
  assert.deepEqual(currentGitHubPolicy(), { mode: 'app-only', repositories: ['owner/repo'] });
  return response;
} } });
const { readManagedRevisions } = await import('../lib/management-revisions.mjs');

test('revision reads use App-only policy and return just immutable object IDs', async () => {
  response = { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) }, privateResponse: 'excluded' };
  assert.deepEqual(await readManagedRevisions('OWNER/REPO', 1), { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
  assert.equal(currentGitHubPolicy().mode, 'legacy');
});

test('invalid identifiers and malformed provider revisions are refused', async () => {
  calls = 0;
  await assert.rejects(readManagedRevisions('owner/../other', 1));
  await assert.rejects(readManagedRevisions('owner/repo', 0));
  assert.equal(calls, 0);
  response = { base: { sha: 'moving-branch' }, head: { sha: 'b'.repeat(40) } };
  await assert.rejects(readManagedRevisions('owner/repo', 1), { code: 'invalid_revision' });
});
