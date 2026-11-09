import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  configureManagement,
  openManagementService,
  readManagementConfiguration,
  acquireDashboardLease,
  readAuthenticationMode,
} from '../lib/management-service.mjs';

test('engine authentication policy binds API or plan mode and refuses disabled or malformed config', (t) => {
  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  const filename = path.join(paths.runsDirectory, '.config.json');
  fs.writeFileSync(filename, JSON.stringify({ connections: { codex: 'api', claude: 'off' } }), { mode: 0o600 });
  assert.equal(readAuthenticationMode(paths.runsDirectory, 'gpt-6.1-sol'), 'api');
  assert.throws(() => readAuthenticationMode(paths.runsDirectory, 'claude-opus-5-5'), { code: 'engine_unavailable' });
  fs.writeFileSync(filename, '{');
  assert.throws(() => readAuthenticationMode(paths.runsDirectory, 'gpt-6.1-sol'), { code: 'configuration_unavailable' });
});

test('dashboard queue ownership is exclusive and kernel-released after process death', async (t) => {
  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  const module = new URL('../lib/management-service.mjs', import.meta.url).href;
  const code = `import { acquireDashboardLease } from ${JSON.stringify(module)}; const lease=acquireDashboardLease(${JSON.stringify(paths.directory)}); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: paths.root, TMPDIR: '/tmp' },
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lease fixture did not start')), 2000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  assert.throws(() => acquireDashboardLease(paths.directory), { code: 'dashboard_busy' });
  child.kill('SIGKILL'); await closed;
  const next = acquireDashboardLease(paths.directory); next.close();
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-management-service-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'management');
  const runsDirectory = path.join(root, 'runs');
  const workerPath = path.join(root, 'worker.mjs');
  fs.writeFileSync(workerPath, 'process.exit(0);\n', { mode: 0o600, flag: 'wx' });
  return { root, directory, runsDirectory, workerPath };
}

const serviceOptions = (paths, overrides = {}) => ({
  ...paths,
  preflight: async () => true,
  ...overrides,
});

test('configuration creates private roots and a durable versioned service file idempotently', (t) => {
  const paths = fixture(t);
  const expected = { version: 1, runsDirectory: paths.runsDirectory };

  assert.deepEqual(configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory }), expected);
  assert.deepEqual(configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory }), expected);
  assert.deepEqual(readManagementConfiguration(paths.directory), expected);
  assert.deepEqual(fs.readdirSync(paths.directory).sort(), ['service.json']);
  assert.equal(fs.statSync(paths.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.runsDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(paths.directory, 'service.json')).mode & 0o777, 0o600);
});

test('configuration refuses insecure paths, modes, and conflicting run roots without repairing them', (t) => {
  const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-management-service-unsafe-'));
  t.after(() => fs.rmSync(unsafe, { recursive: true, force: true }));
  const openDirectory = path.join(unsafe, 'open');
  fs.mkdirSync(openDirectory, { mode: 0o700 });
  fs.chmodSync(openDirectory, 0o777);
  assert.throws(() => configureManagement({ directory: openDirectory, runsDirectory: path.join(unsafe, 'runs') }));
  assert.equal(fs.statSync(openDirectory).mode & 0o777, 0o777);

  const target = path.join(unsafe, 'target');
  const linkedDirectory = path.join(unsafe, 'linked');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, linkedDirectory);
  assert.throws(() => configureManagement({ directory: linkedDirectory, runsDirectory: path.join(unsafe, 'other-runs') }));
  assert.deepEqual(fs.readdirSync(target), []);

  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  assert.throws(() => configureManagement({ directory: paths.directory, runsDirectory: path.join(paths.root, 'different-runs') }),
    (error) => error.code === 'configuration_conflict');
});

test('read is non-creating for absent configuration and rejects malformed or unknown schema fields', (t) => {
  const paths = fixture(t);
  assert.equal(readManagementConfiguration(paths.directory), null);
  assert.equal(fs.existsSync(paths.directory), false);

  fs.mkdirSync(paths.directory, { mode: 0o700 });
  const filename = path.join(paths.directory, 'service.json');
  fs.writeFileSync(filename, JSON.stringify({ version: 1, runsDirectory: paths.runsDirectory, extra: true }), { mode: 0o600, flag: 'wx' });
  assert.throws(() => readManagementConfiguration(paths.directory));
  fs.writeFileSync(filename, '{', { mode: 0o600 });
  assert.throws(() => readManagementConfiguration(paths.directory));
});

test('service requires preflight and refuses a runs root different from its configured value', (t) => {
  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  assert.throws(() => openManagementService(paths), /preflight/i);
  assert.throws(() => openManagementService(serviceOptions(paths, {
    runsDirectory: path.join(paths.root, 'different-runs'),
  })), (error) => error.code === 'configuration_conflict');
});

test('a second service shares the durable run-busy fence and does not preflight a rejected request', async (t) => {
  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  const first = openManagementService(serviceOptions(paths));
  const secondPreflight = async () => { throw new Error('preflight must not run for a rejected request'); };
  const second = openManagementService(serviceOptions(paths, { preflight: secondPreflight }));
  t.after(() => { first.close(); second.close(); });
  assert.equal(typeof first.store.reserve, 'function');
  assert.equal(typeof first.control.submit, 'function');
  assert.equal(typeof first.launch, 'function');
  assert.equal(typeof first.credentials.provision, 'function');
  assert.equal(typeof first.close, 'function');

  first.store.reserve({ principalId: 'caller', requestId: 'first-request', intent: { value: 1 }, runName: 'run_1' });
  await assert.rejects(second.control.submit({ principalId: 'caller', requestId: 'second-request', intent: { value: 2 } }),
    (error) => error.code === 'run_busy');
});

test('closing services closes handles without deleting state or releasing an active admission', async (t) => {
  const paths = fixture(t);
  configureManagement({ directory: paths.directory, runsDirectory: paths.runsDirectory });
  const service = openManagementService(serviceOptions(paths));
  service.store.reserve({ principalId: 'caller', requestId: 'retained-request', intent: { value: 1 }, runName: 'retained_run' });
  service.close();

  assert.deepEqual(fs.readdirSync(paths.directory).sort(), ['requests.sqlite', 'service.json']);
  const reopened = openManagementService(serviceOptions(paths));
  t.after(() => reopened.close());
  assert.equal(reopened.store.active().requestId, 'retained-request');
  await assert.rejects(reopened.control.submit({ principalId: 'caller', requestId: 'new-request', intent: { value: 2 } }),
    (error) => error.code === 'run_busy');
});
