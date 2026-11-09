import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RequestStore } from '../lib/management-store.mjs';
import { ManagedRuns } from '../lib/management-runs.mjs';
import { LaunchRefusal } from '../lib/management-launcher.mjs';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-managed-runs-'));
  fs.chmodSync(directory, 0o700);
  const store = new RequestStore({ directory });
  const runsDirectory = path.join(directory, 'runs');
  fs.mkdirSync(runsDirectory, { mode: 0o700 });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(directory, { recursive: true, force: true }); });
  const children = [];
  const launch = options.launch ?? (() => { const child = new EventEmitter(); child.pid = 123; child.connected = true; child.messages = []; child.send = (message) => child.messages.push(message); children.push(child); return child; });
  return { directory, store, runsDirectory, children, managed: new ManagedRuns({ store, runsDirectory, launch,
    ...(options.snapshotEvidence ? { evidenceDirectory: path.join(directory, 'evidence') } : {}), ...options }) };
}
const args = (requestId = 'req-1', intent = { baseSha: 'base', headSha: 'head' }) => ({ principalId: 'caller', requestId, intent });
const tick = async () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 40; i += 1) { await tick(); } }
function ack(record, patch = {}) { return { type: 'miu-complete', requestId: record.requestId, runName: record.runName, baseSha: record.intent.baseSha, headSha: record.intent.headSha, cleanupComplete: true, cancelled: false, ...patch }; }
async function closeWith(child, code = 0) { child.emit('close', code); await settle(); }

test('reservation is idempotent, intent-bound, and launches only once', async (t) => {
  const f = fixture(t); const first = await f.managed.submit(args()); const again = await f.managed.submit(args());
  assert.equal(first.created, true); assert.equal(again.created, false); assert.equal(f.children.length, 1);
  await assert.rejects(f.managed.submit(args('req-1', { baseSha: 'other', headSha: 'head' })), (e) => e.code === 'request_conflict');
});

test('known pre-spawn refusal finishes failed; an uncertain factory error retains capacity', async (t) => {
  const safe = fixture(t, { launch: async () => { throw new LaunchRefusal('revision_mismatch'); } });
  await safe.managed.submit(args()); await settle();
  assert.equal((await safe.managed.read('caller', 'req-1')).record.state, 'failed');
  assert.equal((await safe.managed.submit(args('req-2'))).created, true);
  const unknown = fixture(t, { launch: async () => { throw new Error('uncertain'); } });
  await unknown.managed.submit(args()); await settle();
  assert.equal((await unknown.managed.read('caller', 'req-1')).record.state, 'unknown_effect');
  await assert.rejects(unknown.managed.submit(args('req-2')), { code: 'run_busy' });
});

test('same capacity spans managed and legacy requests; existing lookup precedes foreign busy check', async (t) => {
  let foreign = false; const f = fixture(t, { legacyBusy: () => foreign });
  const first = await f.managed.submit(args()); foreign = true;
  assert.equal((await f.managed.read('caller', 'req-1')).record.requestId, first.record.requestId);
  await assert.rejects(f.managed.submit(args('req-2')), (e) => e.code === 'run_busy');
  assert.throws(() => f.managed.admitLegacy({ requestId: 'legacy', intent: {}, runName: 'legacy_1', launch: () => null }), (e) => e.code === 'run_busy');
});

test('close without acknowledgement retains capacity', async (t) => {
  const f = fixture(t, { observeStopped: async () => true }); const { record } = await f.managed.submit(args()); const child = f.children[0];
  await closeWith(child, 0); assert.equal((await f.managed.read('caller', record.requestId)).record.state, 'unknown_effect');
});

test('ack alone retains capacity; ack then close finishes with positive stopped proof', async (t) => {
  const f = fixture(t, { observeStopped: async () => true }); const { record } = await f.managed.submit(args()); const child = f.children[0];
  child.emit('message', ack(record)); await settle();
  assert.equal((await f.managed.read('caller', record.requestId)).record.state, 'running');
  await assert.rejects(f.managed.submit(args('req-2')), (e) => e.code === 'run_busy');
  await closeWith(child, 0);
  const result = await f.managed.read('caller', record.requestId); assert.equal(result.record.state, 'succeeded');
  assert.equal(result.observation, 'observed');
  assert.equal((await f.managed.submit(args('req-2'))).created, true);
});

test('stopped observation must positively confirm the entire owned process group', async (t) => {
  const f = fixture(t, { observeStopped: async () => false });
  const { record } = await f.managed.submit(args());
  f.children[0].emit('message', ack(record)); await closeWith(f.children[0]);
  assert.equal((await f.managed.read('caller', record.requestId)).record.state, 'unknown_effect');
  await assert.rejects(f.managed.submit(args('req-2')), (e) => e.code === 'run_busy');
});

test('new controller reports retained state and cannot cancel or replay an unowned worker', async (t) => {
  const f = fixture(t); await f.managed.submit(args());
  const other = new ManagedRuns({ store: f.store, runsDirectory: f.runsDirectory, launch: () => assert.fail('must not replay') });
  assert.equal((await other.read('caller', 'req-1')).observation, 'retained');
  assert.equal((await other.submit(args())).created, false);
  assert.equal((await other.cancel('caller', 'req-1')).state, 'unknown_effect');
  assert.equal(f.children[0].messages.length, 0);
});

test('cancellation during preflight can finish only when launcher confirms no child was spawned', async (t) => {
  let proceed; const ready = new Promise((resolve) => { proceed = resolve; });
  const f = fixture(t, { launch: async (_record, { isCancelled }) => { await ready; assert.equal(isCancelled(), true); return null; } });
  await f.managed.submit(args()); await f.managed.cancel('caller', 'req-1'); proceed(); await settle();
  assert.equal((await f.managed.read('caller', 'req-1')).record.state, 'cancelled');
  assert.equal((await f.managed.submit(args('req-2'))).created, true);
});

test('invalid acknowledgement and failed cleanup fence capacity as unknown', async (t) => {
  const f = fixture(t, { observeStopped: async () => true }); const { record } = await f.managed.submit(args()); const child = f.children[0];
  child.emit('message', ack(record, { cleanupComplete: false })); await closeWith(child, 0);
  assert.equal((await f.managed.read('caller', record.requestId)).record.state, 'unknown_effect');
  await assert.rejects(f.managed.submit(args('req-2')), (e) => e.code === 'run_busy');
});

test('cancel persists and sends a message without signalling a PID', async (t) => {
  const f = fixture(t); const { record } = await f.managed.submit(args()); const child = f.children[0]; child.kill = () => assert.fail('must not signal child');
  await f.managed.cancel('caller', record.requestId);
  assert.deepEqual(child.messages.at(-1), { type: 'miu-cancel', requestId: record.requestId, runName: record.runName });
});

test('evidence returns bounded metadata for fixed safe filenames and excludes symlinks and paths', async (t) => {
  const f = fixture(t); const { record } = await f.managed.submit(args());
  const runDirectory = path.join(f.runsDirectory, record.runName); fs.mkdirSync(runDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(runDirectory, 'final-report.md'), 'private report');
  const outside = path.join(f.directory, 'outside.txt'); fs.writeFileSync(outside, 'secret outside');
  fs.symlinkSync(outside, path.join(runDirectory, 'results.json'));
  const evidence = await f.managed.evidence('caller', record.requestId);
  assert.ok(Array.isArray(evidence)); assert.ok(evidence.every((item) => ['name', 'sizeBytes', 'kind'].every((key) => Object.hasOwn(item, key))));
  assert.ok(evidence.every((item) => !JSON.stringify(item).includes(outside) && !JSON.stringify(item).includes('secret outside')));
});

test('ACL-shared run data becomes immutable private metadata only after proven completion', async (t) => {
  const f = fixture(t, { snapshotEvidence: true, observeStopped: async () => true });
  const { record } = await f.managed.submit(args());
  const directory = path.join(f.runsDirectory, record.runName);
  fs.mkdirSync(directory, { mode: 0o770 }); fs.chmodSync(directory, 0o770);
  fs.writeFileSync(path.join(directory, 'report.md'), 'private report', { mode: 0o600 });
  assert.deepEqual(await f.managed.evidence('caller', record.requestId), []);
  f.children[0].emit('message', ack(record, { outcome: { verdict: 'ok', mode: 'full', sites: [{ role: 'pr', id: 'synthetic-site' }] } })); await closeWith(f.children[0]);
  fs.unlinkSync(path.join(directory, 'report.md'));
  assert.deepEqual(await f.managed.evidence('caller', record.requestId), [{ name: 'report.md', sizeBytes: 14, kind: 'report' }]);
  const snapshots = path.join(f.directory, 'evidence');
  assert.equal(fs.statSync(snapshots).mode & 0o777, 0o700);
  const file = path.join(snapshots, `${record.runName}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes('private report'), false);
  assert.deepEqual(await f.managed.result('caller', record.requestId), {
    verdict: 'ok', mode: 'full', sites: [{ role: 'pr', id: 'synthetic-site' }],
  });
});
