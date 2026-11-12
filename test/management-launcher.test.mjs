import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerLauncher } from '../lib/management-launcher.mjs';

const allowedEnvironment = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'MIU_PROFILES',
  'MIU_AGENT_USER', 'MIU_AGENT_REX', 'MIU_AGENT_EXEC', 'MIU_AGENT_BASE_PATH',
  'MIU_AGENT_LIB', 'MIU_AGENT_CLAUDE', 'MIU_AGENT_CODEX', 'MIU_AGENT_CODEX_DIR',
  'CREDENTIALS_DIRECTORY', 'MIU_SECRETS_KEY_FILE', 'PLAYWRIGHT_BROWSERS_PATH',
];
const forbiddenEnvironment = ['GITHUB_TOKEN', 'GH_TOKEN', 'COMPOSER_AUTH', 'GIT_CONFIG_COUNT', 'UNLISTED_MARKER'];
const waitForClose = (child) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('worker did not close within 3 seconds')), 3000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-worker-launcher-'));
  fs.chmodSync(root, 0o700);
  const runsDirectory = path.join(root, 'runs');
  fs.mkdirSync(runsDirectory, { mode: 0o700 });
  const workerPath = path.join(root, 'worker.mjs');
  const reportPath = path.join(root, 'worker-report.json');
  const workerSource = `
    import fs from 'node:fs';
    const allowed = ${JSON.stringify(allowedEnvironment)};
    const forbidden = ${JSON.stringify(forbiddenEnvironment)};
    process.on('message', (message) => {
      const report = {
        message,
        allowedPresent: Object.fromEntries(allowed.map((key) => [key, Object.hasOwn(process.env, key)])),
        forbiddenAbsent: Object.fromEntries(forbidden.map((key) => [key, !Object.hasOwn(process.env, key)])),
        argv: process.argv.slice(1),
        ownsProcessGroup: (() => { try { process.kill(-process.pid, 0); return true; } catch { return false; } })(),
      };
      fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));
      process.send({ type: 'worker-report-written' });
      process.disconnect();
    });
  `;
  fs.writeFileSync(workerPath, workerSource, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runsDirectory, workerPath, reportPath };
}

function suppliedEnvironment(root) {
  return {
    PATH: '/synthetic/bin', HOME: root, TMPDIR: root, LANG: 'C', LC_ALL: 'C',
    MIU_PROFILES: 'synthetic-profiles', MIU_AGENT_USER: 'synthetic-user',
    MIU_AGENT_REX: 'synthetic-rex', MIU_AGENT_EXEC: 'synthetic-exec',
    MIU_AGENT_BASE_PATH: 'synthetic-base',
    MIU_AGENT_LIB: '/synthetic/lib', MIU_AGENT_CLAUDE: '/synthetic/bin/claude',
    MIU_AGENT_CODEX: '/synthetic/bin/codex', MIU_AGENT_CODEX_DIR: '/synthetic/codex',
    CREDENTIALS_DIRECTORY: '/synthetic/credentials', MIU_SECRETS_KEY_FILE: '/synthetic/key',
    PLAYWRIGHT_BROWSERS_PATH: '/synthetic/browsers', GITHUB_TOKEN: 'synthetic-secret',
    GH_TOKEN: 'synthetic-secret', COMPOSER_AUTH: 'synthetic-secret',
    GIT_CONFIG_COUNT: '1', UNLISTED_MARKER: 'synthetic-value',
  };
}

test('launches an admitted worker with only the explicit safe environment and argv', async (t) => {
  const f = fixture(t);
  const record = { requestId: 'request-safe', runName: 'run-safe', intent: { baseSha: 'base', headSha: 'head' } };
  const launch = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory, environment: suppliedEnvironment(f.root), preflight: async () => true });
  const child = await launch(record, { isCancelled: () => false });
  assert.equal(typeof child.pid, 'number');
  const closed = await waitForClose(child);
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  const report = JSON.parse(fs.readFileSync(f.reportPath, 'utf8'));
  assert.deepEqual(report.message, { type: 'miu-admitted', record });
  assert.deepEqual(report.allowedPresent, Object.fromEntries(allowedEnvironment.map((key) => [key, true])));
  assert.deepEqual(report.forbiddenAbsent, Object.fromEntries(forbiddenEnvironment.map((key) => [key, true])));
  assert.deepEqual(report.argv, [f.workerPath]);
  assert.equal(report.ownsProcessGroup, true);
  const runDirectories = fs.readdirSync(f.runsDirectory);
  assert.equal(runDirectories.length, 1);
  const runPath = path.join(f.runsDirectory, runDirectories[0]);
  assert.equal(fs.statSync(runPath).isDirectory(), true);
  assert.equal(fs.statSync(runPath).mode & 0o777, 0o700);
  const outputPath = path.join(runPath, 'qa-run.out');
  assert.equal(fs.statSync(outputPath).isFile(), true);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
});

test('requires preflight approval before creating run state or spawning', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const launch = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory, preflight: async () => { calls += 1; return false; } });
  await assert.rejects(launch({ requestId: 'request-rejected' }, { isCancelled: () => false }), (error) => error.code === 'revision_mismatch');
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(f.runsDirectory), []);
});

test('preflight has a finite deadline and never launches after a late approval', async (t) => {
  const f = fixture(t);
  let approve;
  const launch = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory,
    preflightTimeoutMs: 10, preflight: () => new Promise((resolve) => { approve = resolve; }) });
  await assert.rejects(launch({ requestId: 'late', runName: 'late' }, { isCancelled: () => false }), { code: 'preflight_timeout' });
  approve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fs.readdirSync(f.runsDirectory), []);
});

test('cancellation before or after preflight returns null without child effects', async (t) => {
  const f = fixture(t);
  const before = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory, preflight: async () => assert.fail('preflight must not run after cancellation') });
  assert.equal(await before({ requestId: 'cancelled-before' }, { isCancelled: () => true }), null);
  let finishPreflight;
  let cancelled = false;
  const preflight = new Promise((resolve) => { finishPreflight = resolve; });
  const after = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory, preflight: () => preflight });
  const pending = after({ requestId: 'cancelled-after' }, { isCancelled: () => cancelled });
  cancelled = true;
  finishPreflight(true);
  assert.equal(await pending, null);
  assert.deepEqual(fs.readdirSync(f.runsDirectory), []);
});

test('refuses symlinked worker paths and run roots before spawning', async (t) => {
  const f = fixture(t);
  const linkedWorker = path.join(f.root, 'worker-link.mjs');
  fs.symlinkSync(f.workerPath, linkedWorker);
  const workerLaunch = createWorkerLauncher({ workerPath: linkedWorker, runsDirectory: f.runsDirectory, preflight: async () => true });
  await assert.rejects(workerLaunch({ requestId: 'symlink-worker' }, { isCancelled: () => false }));
  assert.deepEqual(fs.readdirSync(f.runsDirectory), []);

  const realRuns = path.join(f.root, 'real-runs');
  const linkedRuns = path.join(f.root, 'linked-runs');
  fs.mkdirSync(realRuns, { mode: 0o700 });
  fs.symlinkSync(realRuns, linkedRuns);
  const runsLaunch = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: linkedRuns, preflight: async () => true });
  await assert.rejects(runsLaunch({ requestId: 'symlink-runs' }, { isCancelled: () => false }));
  assert.deepEqual(fs.readdirSync(realRuns), []);
});

test('refuses an existing run directory before spawning', async (t) => {
  const f = fixture(t);
  const existingRun = path.join(f.runsDirectory, 'already-owned');
  fs.mkdirSync(existingRun, { mode: 0o700 });
  const launch = createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory, preflight: async () => true });
  await assert.rejects(launch({ requestId: 'existing-run', runName: 'already-owned' }, { isCancelled: () => false }));
  assert.deepEqual(fs.readdirSync(f.runsDirectory), ['already-owned']);
  assert.deepEqual(fs.readdirSync(existingRun), []);
});

test('rejects relative trusted-worker configuration locators before launch', (t) => {
  const f = fixture(t);
  assert.throws(() => createWorkerLauncher({ workerPath: f.workerPath, runsDirectory: f.runsDirectory,
    environment: { MIU_AGENT_CLAUDE: 'relative/claude' } }), /absolute worker configuration path required/);
  assert.deepEqual(fs.readdirSync(f.runsDirectory), []);
});
