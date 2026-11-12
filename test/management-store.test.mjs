import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RequestStore, StoreError } from '../lib/management-store.mjs';

function fixture(t, maxRequests = 10000) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-management-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new RequestStore({ directory, maxRequests }); t.after(() => { try { store.close(); } catch {} });
  return { directory, store };
}
const input = (requestId = 'req-1', intent = { z: 2, a: 1 }, principalId = 'caller') => ({ principalId, requestId, intent, runName: 'run_1' });
const proof = { processStopped: true, cleanupComplete: true };
const syntheticEnv = { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'C' };

test('request listing is principal and repository scoped with a stable bounded cursor', (t) => {
  const { store } = fixture(t);
  for (let index = 0; index < 32; index += 1) {
    const requestId = `page-${String(index).padStart(3, '0')}`;
    const principalId = index === 31 ? 'other' : 'caller';
    store.reserve({ principalId, requestId, intent: { repo: index === 30 ? 'owner/private' : 'owner/repo' }, runName: requestId });
    store.finish(principalId, requestId, { state: 'failed', exitCode: 1, ...proof });
  }
  const first = store.list('caller', { repositories: ['owner/repo'] });
  assert.equal(first.records.length, 25);
  assert.equal(first.nextCursor, 'page-024');
  const next = store.list('caller', { repositories: ['owner/repo'], after: first.nextCursor });
  assert.equal(next.records.length, 5);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.records, ...next.records].map((record) => record.requestId)).size, 30);
  assert.throws(() => store.list('caller', { repositories: ['owner/repo'], after: 'page-031' }), { code: 'invalid_cursor' });
  assert.equal(store.lookupRun('page-000').requestId, 'page-000');
  assert.equal(store.lookupRun('legacy run with spaces'), null);
});

test('reservation is durable, canonical, principal scoped, and duplicate precedes busy checks', (t) => {
  const { directory, store } = fixture(t);
  const first = store.reserve(input());
  assert.equal(first.created, true);
  assert.deepEqual(store.reserve(input('req-1', { a: 1, z: 2 })).record, first.record);
  assert.equal(store.lookup('other', 'req-1'), null);
  assert.throws(() => store.reserve(input('req-1', { a: 9 })), (e) => e instanceof StoreError && e.code === 'request_conflict' && e.status === 409);
  assert.throws(() => store.reserve(input('req-2')), (e) => e.code === 'run_busy');
  store.close();
  const reopened = new RequestStore({ directory }); t.after(() => reopened.close());
  assert.deepEqual(reopened.lookup('caller', 'req-1'), first.record);
  assert.equal(reopened.active().requestId, 'req-1');
});

test('capacity limit retains terminal records and never permits key reuse', (t) => {
  const { store } = fixture(t, 1); store.reserve(input());
  assert.throws(() => store.reserve(input('other')), (e) => e.code === 'run_busy');
  store.start('caller', 'req-1'); store.attach('caller', 'req-1', { pid: 123 });
  store.finish('caller', 'req-1', { state: 'succeeded', exitCode: 0, ...proof });
  assert.equal(store.active(), null);
  assert.throws(() => store.reserve(input('other')), (e) => e.code === 'request_capacity_exhausted');
});

test('completed run names remain uniquely owned', (t) => {
  const { store } = fixture(t);
  store.reserve(input('first'));
  store.start('caller', 'first'); store.attach('caller', 'first', { pid: 123 });
  store.finish('caller', 'first', { state: 'succeeded', exitCode: 0, ...proof });
  assert.throws(() => store.reserve({ ...input('second'), runName: 'run_1' }), (e) => e.code === 'run_name_conflict');
  assert.equal(store.lookup('caller', 'second'), null);
});

test('finish proof must be boolean true and invalid proof preserves the slot', (t) => {
  const { store } = fixture(t); store.reserve(input()); store.start('caller', 'req-1'); store.attach('caller', 'req-1', { pid: 123 });
  for (const bad of ['true', {}, 1]) {
    assert.throws(() => store.finish('caller', 'req-1', { state: 'succeeded', exitCode: 0, processStopped: bad, cleanupComplete: true }), (e) => e.code === 'finish_unproven');
    assert.throws(() => store.finish('caller', 'req-1', { state: 'succeeded', exitCode: 0, processStopped: true, cleanupComplete: bad }), (e) => e.code === 'finish_unproven');
  }
  assert.equal(store.active().state, 'running');
  assert.equal(store.lookup('caller', 'missing'), null);
  assert.throws(() => store.start('caller', 'missing'), (e) => e.code === 'request_not_found');
  assert.equal(store.active().state, 'running');
});

test('finish exit code and timestamp are returned and durable after reopen', (t) => {
  const { directory, store } = fixture(t); store.reserve(input()); store.start('caller', 'req-1'); store.attach('caller', 'req-1', { pid: 123 });
  const finished = store.finish('caller', 'req-1', { state: 'failed', exitCode: 7, ...proof });
  assert.equal(finished.exitCode, 7); assert.equal(typeof finished.finishedAt, 'string');
  store.close(); const reopened = new RequestStore({ directory }); t.after(() => reopened.close());
  assert.equal(reopened.lookup('caller', 'req-1').exitCode, 7);
  assert.equal(reopened.lookup('caller', 'req-1').finishedAt, finished.finishedAt);
});

test('invalid reserve inputs reject without admitting a request', (t) => {
  const { store } = fixture(t);
  const cases = [
    { ...input('bad-intent'), intent: undefined },
    { ...input('large-intent'), intent: 'x'.repeat(17000) },
    { ...input('bad-id'), requestId: '!invalid' },
    { ...input('bad-run'), runName: '../bad' },
  ];
  for (const request of cases) assert.throws(() => store.reserve(request));
  assert.equal(store.active(), null);
  assert.equal(store.lookup('caller', 'bad-intent'), null);
});

test('unsafe directory and database references are refused without repair', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-unsafe-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o777);
  assert.throws(() => new RequestStore({ directory }), (e) => e.code === 'unsafe_store_directory');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o777);

  for (const kind of ['world-readable', 'hardlink', 'symlink']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miu-${kind}-`)); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'requests.sqlite'); const target = path.join(dir, 'target.sqlite');
    fs.writeFileSync(target, 'preserve');
    if (kind === 'world-readable') { fs.writeFileSync(file, 'preserve'); fs.chmodSync(file, 0o644); }
    if (kind === 'hardlink') fs.linkSync(target, file);
    if (kind === 'symlink') fs.symlinkSync(target, file);
    assert.throws(() => new RequestStore({ directory: dir }), (e) => e.code === 'unsafe_store_file');
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
    if (kind === 'world-readable') assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    if (kind === 'hardlink') assert.equal(fs.statSync(file).nlink, 2);
    if (kind === 'symlink') assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  }
});

test('unsafe transitions and unproven finish preserve the capacity fence', (t) => {
  const { directory, store } = fixture(t); store.reserve(input());
  assert.throws(() => store.finish('caller', 'req-1', { state: 'succeeded', exitCode: 0, processStopped: true, cleanupComplete: false }), (e) => e.code === 'finish_unproven');
  assert.throws(() => store.attach('caller', 'req-1', { pid: 123 }), (e) => e.code === 'invalid_transition');
  store.markUnknown('caller', 'req-1', 'lost_reply');
  assert.equal(store.active().state, 'unknown_effect');
  store.close();
  const reopened = new RequestStore({ directory }); t.after(() => reopened.close());
  assert.equal(reopened.active().state, 'unknown_effect');
  assert.throws(() => reopened.reserve(input('req-2')), (e) => e.code === 'run_busy');
});

test('overlapping processes admit one request and reject the other without crashing', async (t) => {
  const { directory, store } = fixture(t); store.close();
  const script = `import {RequestStore} from ${JSON.stringify(new URL('../lib/management-store.mjs', import.meta.url).href)}; const s=new RequestStore({directory:${JSON.stringify(directory)}}); process.stdout.write('ready\\n'); await new Promise(r=>process.stdin.once('data',r)); try{s.reserve({principalId:'p',requestId:process.argv[1],intent:{},runName:process.argv[1]});process.stdout.write('accepted\\n')}catch(e){process.stdout.write(e.code==='run_busy'?'busy\\n':'error:'+e.code+'\\n');process.exitCode=e.code==='run_busy'?3:4}finally{s.close()}`;
  const children = ['a', 'b'].map((id) => spawn(process.execPath, ['--input-type=module', '-e', script, id], { env: syntheticEnv, stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const outcomes = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let ready = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; if (!ready && stdout.includes('ready\n')) { ready = true; resolve({ child, stdout: () => stdout, stderr: () => stderr, release: () => child.stdin.end('go') }); } });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('exit', (code) => { if (!ready) reject(new Error(`child exited ${code}: ${stderr}`)); });
  })));
  for (const result of outcomes) result.release();
  const exits = await Promise.all(outcomes.map(({ child }) => new Promise((resolve) => child.once('exit', (code) => resolve(code)))));
  assert.deepEqual(exits.sort(), [0, 3]);
  const combined = outcomes.map(({ stdout }) => stdout()).join('');
  assert.equal((combined.match(/accepted/g) ?? []).length, 1);
  assert.equal((combined.match(/busy/g) ?? []).length, 1);
  assert.equal((combined.match(/error:/g) ?? []).length, 0);
});
