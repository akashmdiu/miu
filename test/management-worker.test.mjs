import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('../lib/agent.mjs', { exports: { runAgent: async () => assert.fail('must not launch an agent') } });
mock.module('../lib/project.mjs', { exports: {
  PROFILES_DIR: '/synthetic-profiles',
  project: () => ({ live_hosts: [] }), projectText: () => '', profileOf: () => null,
  roles: () => ({}), mainFile: () => null, profiles: () => [],
} });
const { runQa } = await import('../lib/qa-run-worker.mjs');

test('invalid worker arguments return failure without terminating the owning supervisor', async () => {
  const result = await runQa({ argv: [] });
  assert.equal(result.exitCode, 2);
  assert.equal(result.cleanupComplete, true);
});

test('an unknown profile returns failure and completes local cleanup', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-worker-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runQa({ argv: ['--repo', 'synthetic/missing', '--pr', '1', '--run-dir', home] });
  assert.equal(result.exitCode, 2);
  assert.equal(result.cleanupComplete, true);
});

test('cancellation before the worker begins performs no run directory mutation', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-worker-cancel-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  const result = await runQa({ argv: ['--repo', 'synthetic/missing', '--pr', '1', '--run-dir', home], signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanupComplete, true);
  assert.deepEqual(fs.readdirSync(home), []);
});
