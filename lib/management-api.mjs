import { MANAGEMENT_SCOPES } from './management-auth.mjs';
import { projectResult } from './management-result.mjs';

const MAX_BODY = 16384;
const MAX_RESPONSE = 65536;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const OBJECT_ID = /^[a-f0-9]{40}$/;
const RUN_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const STATES = new Set(['accepted', 'starting', 'running', 'cancel_requested', 'unknown_effect', 'succeeded', 'failed', 'cancelled']);
const ERRORS = Object.freeze({
  unauthorized: 401, forbidden: 403, not_found: 404, invalid_request: 400,
  invalid_intent: 400, invalid_request_id: 400, invalid_principal: 400,
  invalid_run_name: 400, invalid_pid: 400, invalid_code: 400, invalid_finish: 400,
  payload_too_large: 413, request_timeout: 408, request_conflict: 409,
  run_busy: 409, run_name_conflict: 409, request_not_found: 404,
  request_capacity_exhausted: 429, invalid_transition: 409, launch_conflict: 409,
  finish_conflict: 409, finish_unproven: 409, unsafe_storage: 500,
  unsafe_store_directory: 500, unsafe_store_file: 500,
  store_unavailable: 503, storage_unavailable: 503, store_schema_unsupported: 503,
  identity_unavailable: 409, revision_mismatch: 409, invalid_cursor: 400, operation_failed: 500,
  engine_unavailable: 409, configuration_unavailable: 503,
});
const refuse = (code) => { throw Object.assign(new Error(code), { code }); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const repository = (value) => typeof value === 'string' && REPOSITORY.test(value)
  && !value.split('/').some((part) => part === '.' || part === '..');
const boundedText = (value, maximum) => typeof value === 'string' && value.length <= maximum
  && !/[\x00-\x1f\x7f]/.test(value);
const permittedRepo = (principal, repo) => repository(repo)
  && principal.repositories.includes(repo.toLowerCase());

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_RESPONSE) refuse('operation_failed');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function bodyJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) refuse('invalid_request');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) refuse('payload_too_large');
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const stop = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const error = (code) => Object.assign(new Error(code), { code });
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return stop(error('payload_too_large'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return stop(error('invalid_request')); }
      if (!isObject(value)) return stop(error('invalid_request'));
      stop(null, value);
    };
    const onError = () => stop(error('invalid_request'));
    const timer = setTimeout(() => stop(error('request_timeout')), 5000);
    timer.unref?.();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
}

async function submitIntent(body, principal, repositories, models, authenticationMode, invoke, admittedAuthMode) {
  const fields = new Set(['repo', 'pr', 'baseSha', 'headSha', 'model', 'mode', 'trust']);
  if (Object.keys(body).some((key) => !fields.has(key)) || !repository(body.repo)
      || !Number.isSafeInteger(body.pr) || body.pr < 1 || body.pr > 2147483647
      || typeof body.baseSha !== 'string' || !OBJECT_ID.test(body.baseSha)
      || typeof body.headSha !== 'string' || !OBJECT_ID.test(body.headSha)
      || !boundedText(body.model, 128) || body.trust !== 'trusted'
      || (body.mode !== undefined && !['report-only', 'publish'].includes(body.mode))) refuse('invalid_request');
  const repo = body.repo.toLowerCase();
  const allowed = await invoke(repositories);
  if (!Array.isArray(allowed)) refuse('operation_failed');
  if (!permittedRepo(principal, repo) || !allowed.some((candidate) => repository(candidate) && candidate.toLowerCase() === repo)) refuse('forbidden');
  if (admittedAuthMode === undefined) {
    const choices = await invoke(models);
    if (!Array.isArray(choices)) refuse('operation_failed');
    if (!choices.includes(body.model)) refuse('invalid_request');
  }
  if (!principal.scopes.includes('runs:trusted')) refuse('forbidden');
  const mode = body.mode ?? 'report-only';
  if (mode === 'publish' && !principal.scopes.includes('runs:publish')) refuse('forbidden');
  const authMode = admittedAuthMode ?? await invoke(() => authenticationMode(body.model));
  if (!['plan', 'api'].includes(authMode)) refuse('engine_unavailable');
  return { repo, pr: body.pr, baseSha: body.baseSha, headSha: body.headSha, model: body.model, mode, trust: 'trusted', authMode };
}

function owned(record, principal, requestId) {
  if (!record || record.principalId !== principal.id || record.requestId !== requestId
      || !record.intent || !permittedRepo(principal, record.intent.repo)) refuse('not_found');
  return record;
}

function publicRequest(record) {
  const intent = record.intent;
  if (!REQUEST_ID.test(record.requestId) || !STATES.has(record.state)
      || !boundedText(record.runName, 128) || !RUN_NAME.test(record.runName)
      || !boundedText(record.createdAt, 40) || !boundedText(record.updatedAt, 40)
      || !repository(intent.repo) || !Number.isSafeInteger(intent.pr)
      || !OBJECT_ID.test(intent.baseSha) || !OBJECT_ID.test(intent.headSha)
      || !boundedText(intent.model, 128) || !['report-only', 'publish'].includes(intent.mode)
      || intent.trust !== 'trusted') refuse('operation_failed');
  return {
    requestId: record.requestId, state: record.state, runName: record.runName,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    intent: { repo: intent.repo, pr: intent.pr, baseSha: intent.baseSha, headSha: intent.headSha,
      model: intent.model, mode: intent.mode, trust: intent.trust,
      ...(['plan', 'api'].includes(intent.authMode) ? { authMode: intent.authMode } : {}) },
    ...(Number.isInteger(record.exitCode) && record.exitCode >= -1 && record.exitCode <= 255 ? { exitCode: record.exitCode } : {}),
    ...(boundedText(record.finishedAt, 40) ? { finishedAt: record.finishedAt } : {}),
  };
}

function healthProjection(value) {
  if (!isObject(value)) refuse('operation_failed');
  const revision = typeof value.sourceRevision === 'string' && OBJECT_ID.test(value.sourceRevision) ? value.sourceRevision : null;
  return {
    apiVersion: 1,
    status: ['ok', 'degraded', 'unknown'].includes(value.status) ? value.status : 'unknown',
    version: boundedText(value.version, 64) ? value.version : null,
    sourceRevision: revision,
    provenance: revision && value.provenance === 'verified-source' ? 'verified-source' : 'unknown',
  };
}

function appProjection(value) {
  if (!isObject(value)) refuse('operation_failed');
  const states = ['none', 'configured_unverified', 'not_installed', 'partial', 'ready', 'unavailable'];
  const state = states.includes(value.state) ? value.state : 'unavailable';
  return {
    state, setupUrl: '/github-app',
    ...(boundedText(value.slug, 100) && /^[A-Za-z0-9-]+$/.test(value.slug) ? { slug: value.slug } : {}),
    ...(boundedText(value.owner, 100) && /^[A-Za-z0-9-]+$/.test(value.owner) ? { owner: value.owner } : {}),
    grantObservation: 'unknown',
  };
}

function evidenceProjection(value) {
  if (!Array.isArray(value) || value.length > 100) refuse('operation_failed');
  let total = 0;
  return value.map((entry) => {
    if (!isObject(entry) || typeof entry.name !== 'string'
        || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(entry.name)
        || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > 16777216) refuse('operation_failed');
    total += entry.sizeBytes;
    if (total > 67108864) refuse('operation_failed');
    return { name: entry.name, sizeBytes: entry.sizeBytes,
      ...(typeof entry.kind === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(entry.kind) ? { kind: entry.kind } : {}),
    };
  });
}

/**
 * Service-only HTTP boundary. Browser sessions never authorize management calls.
 * Control owns admission, process lifecycle, and evidence; handlers never launch work.
 * @returns {(req:import('node:http').IncomingMessage,res:import('node:http').ServerResponse)=>Promise<boolean>}
 */
export function createManagementHandler({ credentials, control, health, app, repositories, models, authenticationMode, operationTimeoutMs = 5000 }) {
  for (const callback of [credentials?.authenticate, control?.submit, control?.read, control?.list, control?.cancel, control?.evidence, control?.result, health, app, repositories, models, authenticationMode]) {
    if (typeof callback !== 'function') throw new TypeError('management dependencies required');
  }
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 10000) throw new TypeError('bounded management deadline required');
  return async (req, res) => {
    const target = req.url ?? '';
    if (!/^\/management(?:\/|\?|$)/.test(target)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const deadline = performance.now() + operationTimeoutMs;
    const invoke = async (callback) => {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) refuse('request_timeout');
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(callback),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('request_timeout'), { code: 'request_timeout' })), remaining);
            timer.unref?.();
          }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      const pathname = target.split('?')[0];
      const method = req.method;
      let scope;
      if (method === 'GET' && ['/management/v1/health', '/management/v1/capabilities'].includes(pathname)) scope = 'health:read';
      else if (method === 'GET' && pathname === '/management/v1/app') scope = 'app:read';
      else if (method === 'POST' && pathname === '/management/v1/requests') scope = 'runs:submit';
      else if (method === 'GET' && pathname === '/management/v1/requests') scope = 'runs:read';
      else if (method === 'POST' && pathname.endsWith('/cancel')) scope = 'runs:cancel';
      else if (method === 'GET' && pathname.endsWith('/evidence')) scope = 'evidence:read';
      else if (method === 'GET' && pathname.startsWith('/management/v1/requests/')) scope = 'runs:read';
      const principal = await invoke(() => credentials.authenticate(req.headers.authorization, { scope }));
      if (req.headers.cookie !== undefined || req.headers.origin !== undefined) refuse('forbidden');
      if (target.length > 2048 || target.includes('?')) refuse('invalid_request');
      const peer = req.socket.remoteAddress ?? '';
      if (!req.socket.encrypted && !/^(127\.|::1$|::ffff:127\.)/.test(peer)) refuse('forbidden');
      if (method === 'GET' && pathname === '/management/v1/health') {
        send(res, 200, { ok: true, ...healthProjection(await invoke(health)) });
      } else if (method === 'GET' && pathname === '/management/v1/capabilities') {
        send(res, 200, { ok: true, apiVersion: 1, scopes: [...MANAGEMENT_SCOPES],
          operations: ['health', 'app', 'submit', 'read', 'list', 'cancel', 'evidence', 'result'],
          modes: ['report-only', 'publish'], trustClasses: ['trusted'],
          limits: { requestBytes: MAX_BODY, responseBytes: MAX_RESPONSE, evidenceCount: 100, requestPageSize: 25, resultSiteCount: 2 },
        });
      } else if (method === 'GET' && pathname === '/management/v1/app') {
        send(res, 200, { ok: true, app: appProjection(await invoke(app)) });
      } else if (method === 'GET' && pathname === '/management/v1/requests') {
        const cursor = req.headers['x-miu-after-request'];
        if (cursor !== undefined && (typeof cursor !== 'string' || !REQUEST_ID.test(cursor))) refuse('invalid_cursor');
        const configured = await invoke(repositories);
        if (!Array.isArray(configured)) refuse('operation_failed');
        const allowed = principal.repositories.filter((repo) => configured.some((candidate) => repository(candidate) && candidate.toLowerCase() === repo));
        const page = await invoke(() => control.list(principal.id, { repositories: allowed, after: cursor }));
        if (!page || !Array.isArray(page.records) || page.records.length > 25
            || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !REQUEST_ID.test(page.nextCursor)))) refuse('operation_failed');
        const records = page.records.map((record) => {
          owned(record, principal, record.requestId);
          if (!allowed.includes(record.intent.repo)) refuse('operation_failed');
          return publicRequest(record);
        });
        if (page.nextCursor !== null && page.nextCursor !== records.at(-1)?.requestId) refuse('operation_failed');
        send(res, 200, { ok: true, requests: records, nextCursor: page.nextCursor });
      } else if (method === 'POST' && pathname === '/management/v1/requests') {
        const requestId = req.headers['idempotency-key'];
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) refuse('invalid_request');
        if (!principal.scopes.includes('runs:trusted')) refuse('forbidden');
        const body = await invoke(() => bodyJson(req));
        const prior = await invoke(() => control.read(principal.id, requestId));
        const previous = prior?.record ?? prior;
        if (previous) owned(previous, principal, requestId);
        const admittedAuthMode = ['plan', 'api'].includes(previous?.intent?.authMode) ? previous.intent.authMode : undefined;
        const intent = await submitIntent(body, principal, repositories, models, authenticationMode, invoke, admittedAuthMode);
        const result = await invoke(() => control.submit({ principalId: principal.id, requestId, intent }));
        if (!result || typeof result.created !== 'boolean') refuse('operation_failed');
        const record = owned(result.record, principal, requestId);
        send(res, result.created ? 201 : 200, { ok: true, created: result.created, request: publicRequest(record) });
      } else {
        const match = /^\/management\/v1\/requests\/([A-Za-z0-9_-]{1,128})(?:\/(cancel|evidence|result))?$/.exec(pathname);
        if (!match || !((method === 'GET' && match[2] !== 'cancel') || (method === 'POST' && match[2] === 'cancel'))) refuse('not_found');
        const requestId = match[1];
        const result = await invoke(() => control.read(principal.id, requestId));
        const observation = result?.record ? result.observation : undefined;
        const record = owned(result?.record ?? result, principal, requestId);
        if (match[2] === 'cancel') {
          if (Number(req.headers['content-length'] ?? 0) !== 0 || req.headers['transfer-encoding']) refuse('invalid_request');
          const cancelled = owned(await invoke(() => control.cancel(principal.id, requestId)), principal, requestId);
          send(res, 202, { ok: true, request: publicRequest(cancelled) });
        } else if (match[2] === 'evidence') {
          send(res, 200, { ok: true, evidence: evidenceProjection(await invoke(() => control.evidence(principal.id, requestId))) });
        } else if (match[2] === 'result') {
          const outcome = projectResult(await invoke(() => control.result(principal.id, requestId)));
          send(res, 200, { ok: true, request: publicRequest(record), result: outcome ? { ...outcome, cleanup: 'complete' } : null });
        } else send(res, 200, { ok: true, request: publicRequest(record),
          ...(['observed', 'retained'].includes(observation) ? { observation } : {}) });
      }
    } catch (error) {
      const code = typeof error?.code === 'string' && Object.hasOwn(ERRORS, error.code) ? error.code : 'operation_failed';
      const status = ERRORS[code];
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (res.headersSent || res.destroyed) res.destroy();
      else {
        res.setHeader('Connection', 'close');
        send(res, status, { ok: false, code });
      }
      req.resume();
    }
    return true;
  };
}
