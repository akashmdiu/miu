import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../lib/management-auth.mjs';
import { createManagementHandler } from '../lib/management-api.mjs';

const secret = 'synthetic-management-api-secret-0123456789';
const runIntent = Object.freeze({
  repo: 'owner/repo', pr: 17, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  model: 'claude', mode: 'report-only', trust: 'trusted',
});
const requestRecord = (overrides = {}) => ({
  principalId: 'runner', requestId: 'request-1', state: 'accepted', runName: 'qa-17',
  intent: { ...runIntent }, createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z', pid: 4321, privateExtra: 'PRIVATE-MARKER', ...overrides,
});

async function fixture(t, { scopes = ['health:read', 'app:read', 'runs:submit', 'runs:read', 'runs:cancel', 'evidence:read', 'runs:trusted', 'runs:publish'], repositories = ['owner/repo'], models = ['claude'], submit, read, list, cancel, evidence, result, authMode = 'plan', operationTimeoutMs = 5000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'miu-management-api-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = new CredentialStore({ directory });
  await credentials.provision({ id: 'runner', secret, scopes, repositories });
  const calls = { submit: [], read: [], cancel: [], evidence: [] };
  const handler = createManagementHandler({
    operationTimeoutMs,
    credentials,
    control: {
      submit: async (args) => { calls.submit.push(args); return submit ? submit(args) : { created: true, record: requestRecord({ principalId: args.principalId, requestId: args.requestId, intent: args.intent }) }; },
      read: async (...args) => { calls.read.push(args); return read ? read(...args) : args[1] === 'missing' ? null : requestRecord({ principalId: args[0], requestId: args[1] }); },
      cancel: async (...args) => { calls.cancel.push(args); return cancel ? cancel(...args) : requestRecord({ principalId: args[0], requestId: args[1], state: 'cancel_requested' }); },
      evidence: async (...args) => { calls.evidence.push(args); return evidence ? evidence(...args) : [{ name: 'summary.json', sizeBytes: 64, kind: 'summary', path: '/private/summary.json', url: 'https://private.invalid', content: 'PRIVATE-MARKER', privateExtra: 'PRIVATE-MARKER' }]; },
      result: async (...args) => result ? result(...args) : null,
      list: async (...args) => list ? list(...args) : { records: [requestRecord()], nextCursor: null },
    },
    health: async () => ({ status: 'ok', version: '1', sourceRevision: 'unknown', pid: 123, privateExtra: 'PRIVATE-MARKER' }),
    app: async () => ({ installed: true, sourceRevision: 'unknown', status: 'ready', privateExtra: 'PRIVATE-MARKER' }),
    repositories: async () => repositories,
    models: async () => models,
    authenticationMode: async () => authMode,
  });
  const server = createServer((req, res) => { Promise.resolve(handler(req, res)).then((handled) => { if (!handled) { res.setHeader('x-browser-delegated', 'yes'); res.statusCode = 404; res.end(); } }, () => { if (!res.headersSent) { res.statusCode = 500; res.end(); } }); });
  server.requestTimeout = 2500;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 100;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, calls, token: `Bearer runner.${secret}` };
}

test('submission binds the server authentication mode and refuses an unavailable engine', async (t) => {
  const selected = await fixture(t, { authMode: 'api' });
  const response = await postSubmit(selected.base, { token: selected.token });
  assert.equal(response.status, 201);
  assert.equal(selected.calls.submit[0].intent.authMode, 'api');
  assert.equal((await response.json()).request.intent.authMode, 'api');
  const disabled = await fixture(t, { authMode: 'off' });
  assert.equal((await postSubmit(disabled.base, { token: disabled.token })).status, 409);
  assert.equal(disabled.calls.submit.length, 0);
});

test('result retrieval requires run scope and ownership and projects verdict and site identities only', async (t) => {
  const ready = await fixture(t, { result: async () => ({ verdict: 'partial', mode: 'full',
    sites: [{ role: 'pr', id: 'synthetic-site', privateExtra: 'PRIVATE-MARKER' }], privateExtra: 'PRIVATE-MARKER' }) });
  const response = await call(ready.base, '/management/v1/requests/request-1/result', { token: ready.token });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result, { verdict: 'partial', mode: 'full', sites: [{ role: 'pr', id: 'synthetic-site' }], cleanup: 'complete' });
  assert.equal(JSON.stringify(body).includes('PRIVATE-MARKER'), false);
  const denied = await fixture(t, { scopes: ['health:read'] });
  assert.equal((await call(denied.base, '/management/v1/requests/request-1/result', { token: denied.token })).status, 403);
});

test('request listing forwards bounded principal grants and excludes private fields', async (t) => {
  const f = await fixture(t, { list: async (principalId, options) => {
    assert.equal(principalId, 'runner');
    assert.deepEqual(options, { repositories: ['owner/repo'], after: 'prior' });
    return { records: [requestRecord()], nextCursor: null };
  } });
  const response = await call(f.base, '/management/v1/requests', {
    token: f.token, headers: { 'X-Miu-After-Request': 'prior' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requests.length, 1);
  assert.equal(JSON.stringify(body).includes('PRIVATE-MARKER'), false);
  assert.equal(body.nextCursor, null);
});

async function call(base, path, { method = 'GET', token, headers = {}, body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    return await fetch(`${base}${path}`, {
      method, signal: controller.signal,
      headers: { ...(token ? { authorization: token } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  } finally { clearTimeout(timeout); }
}
async function postSubmit(base, options = {}) {
  return call(base, '/management/v1/requests', { method: 'POST', token: options.token, headers: { 'content-type': 'application/json', 'Idempotency-Key': 'request-1', ...(options.headers || {}) }, body: options.body ?? runIntent });
}

test('management namespace always requires bearer authentication, including loopback and unknown paths', async (t) => {
  const { base } = await fixture(t);
  for (const path of ['/management/v1/health', '/management/v1/not-a-route']) {
    const response = await call(base, path, { headers: { cookie: `session=${secret}` } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal((await call(base, '/management/v1/health', { token: 'Bearer runner.' + secret, headers: { cookie: 'session=x' } })).status, 403);
  assert.equal((await call(base, '/management/v1/health', { token: `Bearer runner.${secret}`, headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await call(base, '/management/v1/health')).headers.get('access-control-allow-origin'), null);
});

test('non-management routes are declined for normal browser handling', async (t) => {
  const { base } = await fixture(t);
  const response = await call(base, '/dashboard', { token: `Bearer runner.${secret}` });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-browser-delegated'), 'yes');
});

test('health, capabilities and app enforce their read scopes and expose bounded metadata', async (t) => {
  const { base, token } = await fixture(t);
  for (const path of ['/management/v1/health', '/management/v1/capabilities']) {
    const response = await call(base, path, { token });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(JSON.stringify(payload).includes('PRIVATE-MARKER'), false);
    assert.equal(JSON.stringify(payload).includes('123'), false);
  }
  const app = await call(base, '/management/v1/app', { token });
  assert.equal(app.status, 200);
  assert.equal(JSON.stringify(await app.json()).includes('PRIVATE-MARKER'), false);
  const { base: restricted, token: restrictedToken } = await fixture(t, { scopes: ['app:read'] });
  assert.equal((await call(restricted, '/management/v1/health', { token: restrictedToken })).status, 403);
});

test('submit delegates once with validated trusted intent and returns 201 then idempotent 200', async (t) => {
  const { base, token, calls } = await fixture(t, { submit: (args) => ({ created: calls.submit.length === 1, record: requestRecord({ principalId: args.principalId, requestId: args.requestId, intent: args.intent }) }) });
  const first = await postSubmit(base, { token });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.created, true);
  assert.equal(firstBody.request.requestId, 'request-1');
  assert.equal(firstBody.request.pid, undefined);
  assert.equal(firstBody.request.privateExtra, undefined);
  const retry = await postSubmit(base, { token });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).created, false);
  assert.equal(calls.submit.length, 2);
  assert.equal(calls.submit[0].principalId, 'runner');
  assert.deepEqual(calls.submit[0].intent, { ...runIntent, authMode: 'plan' });
});

test('submit authenticates and authorizes before parsing or causing effects', async (t) => {
  const { base, calls } = await fixture(t);
  const response = await postSubmit(base, { body: '{broken' });
  assert.equal(response.status, 401);
  assert.equal(calls.submit.length, 0);
});

test('submit refuses missing idempotency key, non JSON, oversize, unknown fields and invalid references', async (t) => {
  const { base, token, calls } = await fixture(t);
  const cases = [
    { headers: { 'Idempotency-Key': '' }, expected: 400 },
    { headers: { 'content-type': 'text/plain' }, expected: 400 },
    { body: { ...runIntent, extra: 'x' }, expected: 400 },
    { body: { ...runIntent, pr: 0 }, expected: 400 },
    { body: { ...runIntent, headSha: 'bad' }, expected: 400 },
    { body: { ...runIntent, trust: 'untrusted' }, expected: 400 },
    { body: { ...runIntent, repo: 'other/project' }, expected: 403 },
    { body: { ...runIntent, model: 'unconfigured' }, expected: 400 },
    { raw: 'x'.repeat(16385), expected: 413 },
  ];
  for (const entry of cases) {
    const response = await postSubmit(base, { token, headers: entry.headers, body: entry.raw ?? entry.body });
    assert.equal(response.status, entry.expected, `case expected ${entry.expected}`);
  }
  assert.equal(calls.submit.length, 0);
});

test('publish requires its additional scope and explicit publish mode', async (t) => {
  const { base, token, calls } = await fixture(t, { scopes: ['runs:submit', 'runs:trusted'], repositories: ['owner/repo'] });
  const response = await postSubmit(base, { token, body: { ...runIntent, mode: 'publish' } });
  assert.equal(response.status, 403);
  assert.equal(calls.submit.length, 0);
});

test('explicit publication authority is passed as part of the bound intent', async (t) => {
  const { base, token, calls } = await fixture(t);
  const response = await postSubmit(base, { token, body: { ...runIntent, mode: 'publish' } });
  assert.equal(response.status, 201);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].intent.mode, 'publish');
});

test('an unavailable controller has a finite response deadline', async (t) => {
  const { base, token } = await fixture(t, { operationTimeoutMs: 50, read: () => new Promise(() => {}) });
  const response = await call(base, '/management/v1/requests/request-1', { token });
  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { ok: false, code: 'request_timeout' });
});

test('request reads enforce scope, conceal another principal row, and project public fields', async (t) => {
  const { base, token } = await fixture(t);
  const response = await call(base, '/management/v1/requests/request-1', { token });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.request.pid, undefined);
  assert.equal(payload.request.privateExtra, undefined);
  assert.equal((await call(base, '/management/v1/requests/missing', { token })).status, 404);
  const { base: isolated, token: isolatedToken } = await fixture(t, { read: async () => requestRecord({ principalId: 'someone-else' }) });
  assert.equal((await call(isolated, '/management/v1/requests/request-1', { token: isolatedToken })).status, 404);
  const { base: restricted, token: restrictedToken } = await fixture(t, { scopes: ['health:read'] });
  assert.equal((await call(restricted, '/management/v1/requests/request-1', { token: restrictedToken })).status, 403);
});

test('cancel is scoped and returns the public request projection', async (t) => {
  const { base, token, calls } = await fixture(t);
  const response = await call(base, '/management/v1/requests/request-1/cancel', { method: 'POST', token });
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.request.state, 'cancel_requested');
  assert.equal(payload.request.pid, undefined);
  assert.equal(calls.cancel[0][0], 'runner');
  const { base: restricted, token: restrictedToken } = await fixture(t, { scopes: ['runs:read'] });
  assert.equal((await call(restricted, '/management/v1/requests/request-1/cancel', { method: 'POST', token: restrictedToken })).status, 403);
});

test('evidence is scoped, bounded metadata only, and traversal entries are refused', async (t) => {
  const { base, token } = await fixture(t);
  const response = await call(base, '/management/v1/requests/request-1/evidence', { token });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.evidence, [{ name: 'summary.json', sizeBytes: 64, kind: 'summary' }]);
  assert.equal(JSON.stringify(payload).includes('PRIVATE-MARKER'), false);
  assert.equal(JSON.stringify(payload).includes('/private'), false);
  for (const unsafe of [['../secret.txt', 1], ['dir/file.txt', 2], ['/etc/passwd', 3], ['https://evil.invalid/x', 4]]) {
    const { base: pathBase, token: pathToken } = await fixture(t, { evidence: async () => [{ name: unsafe[0], sizeBytes: unsafe[1] }] });
    const rejected = await call(pathBase, '/management/v1/requests/request-1/evidence', { token: pathToken });
    assert.equal(rejected.status, 500);
    assert.equal(JSON.stringify(await rejected.json()).includes(unsafe[0]), false);
  }
  const { base: limited, token: limitedToken } = await fixture(t, { scopes: ['runs:read'] });
  assert.equal((await call(limited, '/management/v1/requests/request-1/evidence', { token: limitedToken })).status, 403);
});

test('callback failures map to safe stable errors without secret or raw detail', async (t) => {
  const canary = `RAW-${secret}-DETAIL`;
  const { base, token } = await fixture(t, { read: async () => { throw new Error(canary); } });
  const response = await call(base, '/management/v1/requests/request-1', { token });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.equal(body.includes(canary), false);
  assert.equal(body.includes(secret), false);
  assert.deepEqual(JSON.parse(body), { ok: false, code: 'operation_failed' });
});

test('unknown authenticated management routes return stable not found', async (t) => {
  const { base, token } = await fixture(t);
  const response = await call(base, '/management/v1/no-such-operation', { token });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, code: 'not_found' });
});
