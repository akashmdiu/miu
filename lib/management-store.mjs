import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Store refusals expose stable codes, never SQL or request contents. */
export class StoreError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status) => { throw new StoreError(code, status); };
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const runPattern = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const transitions = Object.freeze({
  accepted: ['starting', 'cancel_requested', 'failed', 'unknown_effect'],
  starting: ['running', 'cancel_requested', 'failed', 'unknown_effect'],
  running: ['succeeded', 'failed', 'cancel_requested', 'unknown_effect'],
  cancel_requested: ['cancelled', 'succeeded', 'failed', 'unknown_effect'],
  unknown_effect: ['succeeded', 'failed', 'cancelled'],
});
const privateOwner = (stat) => (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;
const validateId = (value, kind) => {
  if (typeof value !== 'string' || !idPattern.test(value)) fail(`invalid_${kind}`, 400);
};

function canonical(value) {
  let bytes = 0;
  let nodes = 0;
  const part = (text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 16384) fail('invalid_intent', 400);
    return text;
  };
  const encode = (item, depth) => {
    if (depth > 32 || ++nodes > 2048) fail('invalid_intent', 400);
    if (item === null || typeof item === 'boolean') return part(JSON.stringify(item));
    if (typeof item === 'string') {
      if (item.length > 16384) fail('invalid_intent', 400);
      return part(JSON.stringify(item));
    }
    if (typeof item === 'number' && Number.isFinite(item)) return part(JSON.stringify(item));
    if (Array.isArray(item)) {
      if (item.length > 256) fail('invalid_intent', 400);
      return part('[') + item.map((entry) => encode(entry, depth + 1)).join(part(',')) + part(']');
    }
    if (item && Object.getPrototypeOf(item) === Object.prototype) {
      const keys = Object.keys(item).sort();
      if (keys.length > 256) fail('invalid_intent', 400);
      return part('{') + keys.map((key) => {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !Object.hasOwn(property, 'value')) fail('invalid_intent', 400);
        return part(JSON.stringify(key)) + part(':') + encode(property.value, depth + 1);
      }).join(part(',')) + part('}');
    }
    fail('invalid_intent', 400);
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded) > 16384) fail('invalid_intent', 400);
  return encoded;
}

/** Durable request identity and the one shared run-capacity reservation. */
export class RequestStore {
  #db;
  #maxRequests;

  constructor({ directory, maxRequests = 10000 }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)
        || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000) fail('invalid_store_options', 400);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)) fail('unsafe_store_directory', 500);
    const filename = path.join(directory, 'requests.sqlite');
    try {
      const file = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.closeSync(file);
    } catch (error) {
      if (error.code !== 'EEXIST') fail('store_unavailable', 503);
    }
    const existing = fs.lstatSync(filename);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || !privateOwner(existing)) fail('unsafe_store_file', 500);
    try {
      this.#db = new DatabaseSync(filename);
      this.#db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) fail('store_schema_unsupported', 503);
      if (version === 0) {
        const table = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
        if (table) fail('store_schema_unsupported', 503);
        this.#db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE requests (
            principal TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
            run_name TEXT NOT NULL UNIQUE, intent TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            pid INTEGER, code TEXT, exit_code INTEGER, finished_at TEXT,
            PRIMARY KEY(principal, request_id)
          );
          CREATE TABLE capacity (
            id INTEGER PRIMARY KEY CHECK(id=1), principal TEXT, request_id TEXT,
            CHECK((principal IS NULL) = (request_id IS NULL)),
            FOREIGN KEY(principal,request_id) REFERENCES requests(principal,request_id)
          );
          INSERT INTO capacity(id) VALUES(1);
          PRAGMA user_version=1;
          COMMIT;`);
      }
      const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } catch (error) {
      try { this.#db?.close(); } catch { /* preserve the original safe refusal */ }
      if (error instanceof StoreError) throw error;
      fail('store_unavailable', 503);
    }
    this.#maxRequests = maxRequests;
  }

  #transaction(operation) {
    let begun = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      begun = true;
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (begun) { try { this.#db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ } }
      if (error instanceof StoreError) throw error;
      fail('store_unavailable', 503);
    }
  }

  #row(principalId, requestId) {
    return this.#db.prepare('SELECT * FROM requests WHERE principal=? AND request_id=?').get(principalId, requestId);
  }

  #record(row) {
    return row ? {
      requestId: row.request_id, principalId: row.principal, state: row.state,
      runName: row.run_name, intent: JSON.parse(row.intent),
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.pid === null ? {} : { pid: row.pid }),
      ...(row.code === null ? {} : { code: row.code }),
      ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    } : null;
  }

  reserve({ principalId, requestId, intent, runName }) {
    validateId(principalId, 'principal');
    validateId(requestId, 'request_id');
    if (typeof runName !== 'string' || !runPattern.test(runName)) fail('invalid_run_name', 400);
    const encoded = canonical(intent);
    return this.#transaction(() => {
      const previous = this.#row(principalId, requestId);
      if (previous) {
        if (previous.intent !== encoded || previous.run_name !== runName) fail('request_conflict');
        return { created: false, record: this.#record(previous) };
      }
      const slot = this.#db.prepare('SELECT principal FROM capacity WHERE id=1').get();
      if (slot.principal !== null) fail('run_busy');
      if (this.#db.prepare('SELECT count(*) n FROM requests').get().n >= this.#maxRequests) fail('request_capacity_exhausted', 429);
      if (this.#db.prepare('SELECT 1 FROM requests WHERE run_name=?').get(runName)) fail('run_name_conflict');
      const now = new Date().toISOString();
      this.#db.prepare('INSERT INTO requests(principal,request_id,state,run_name,intent,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(principalId, requestId, 'accepted', runName, encoded, now, now);
      this.#db.prepare('UPDATE capacity SET principal=?,request_id=? WHERE id=1').run(principalId, requestId);
      return { created: true, record: this.#record(this.#row(principalId, requestId)) };
    });
  }

  lookup(principalId, requestId) {
    validateId(principalId, 'principal');
    validateId(requestId, 'request_id');
    try { return this.#record(this.#row(principalId, requestId)); }
    catch (error) { if (error instanceof StoreError) throw error; fail('store_unavailable', 503); }
  }

  lookupRun(runName) {
    if (typeof runName !== 'string' || !runPattern.test(runName)) return null;
    try { return this.#record(this.#db.prepare('SELECT * FROM requests WHERE run_name=?').get(runName)); }
    catch { fail('store_unavailable', 503); }
  }

  list(principalId, { repositories, after } = {}) {
    validateId(principalId, 'principal');
    if (!Array.isArray(repositories) || repositories.length > 100
        || repositories.some((repo) => typeof repo !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))) fail('invalid_intent', 400);
    if (after !== undefined) validateId(after, 'request_id');
    try {
      const cursor = after === undefined ? null : this.#row(principalId, after);
      if (after !== undefined && !cursor) fail('invalid_cursor', 400);
      if (!repositories.length) return { records: [], nextCursor: null };
      const placeholders = repositories.map(() => '?').join(',');
      const rows = this.#db.prepare(`SELECT * FROM requests WHERE principal=?
        AND json_extract(intent,'$.repo') IN (${placeholders})
        ${cursor ? 'AND (created_at,request_id) > (?,?)' : ''}
        ORDER BY created_at,request_id LIMIT 26`).all(principalId, ...repositories,
          ...(cursor ? [cursor.created_at, cursor.request_id] : []));
      const records = rows.slice(0, 25).map((row) => this.#record(row));
      return { records, nextCursor: rows.length > 25 ? records.at(-1).requestId : null };
    } catch (error) { if (error instanceof StoreError) throw error; fail('store_unavailable', 503); }
  }

  #transition(principalId, requestId, next, patch = {}) {
    validateId(principalId, 'principal');
    validateId(requestId, 'request_id');
    return this.#transaction(() => {
      const row = this.#row(principalId, requestId);
      if (!row) fail('request_not_found', 404);
      if (row.state === next) {
        if (next === 'running' && patch.pid !== row.pid) fail('launch_conflict');
        if (terminal.has(next) && patch.exitCode !== row.exit_code) fail('finish_conflict');
        return this.#record(row);
      }
      if (!transitions[row.state]?.includes(next)) fail('invalid_transition');
      if (terminal.has(next) && (patch.processStopped !== true || patch.cleanupComplete !== true)) fail('finish_unproven');
      const now = new Date().toISOString();
      this.#db.prepare(`UPDATE requests SET state=?,updated_at=?,pid=coalesce(?,pid),
          code=coalesce(?,code),exit_code=?,finished_at=? WHERE principal=? AND request_id=?`)
        .run(next, now, patch.pid ?? null, patch.code ?? null,
          terminal.has(next) ? patch.exitCode : null, terminal.has(next) ? now : null,
          principalId, requestId);
      if (terminal.has(next)) {
        this.#db.prepare('UPDATE capacity SET principal=NULL,request_id=NULL WHERE id=1 AND principal=? AND request_id=?')
          .run(principalId, requestId);
      }
      return this.#record(this.#row(principalId, requestId));
    });
  }

  start(principalId, requestId) { return this.#transition(principalId, requestId, 'starting'); }
  attach(principalId, requestId, { pid }) {
    if (!Number.isSafeInteger(pid) || pid < 1) fail('invalid_pid', 400);
    return this.#transition(principalId, requestId, 'running', { pid });
  }
  requestCancel(principalId, requestId) { return this.#transition(principalId, requestId, 'cancel_requested'); }
  markUnknown(principalId, requestId, code) {
    validateId(code, 'code');
    return this.#transition(principalId, requestId, 'unknown_effect', { code });
  }
  finish(principalId, requestId, { state, exitCode, processStopped, cleanupComplete }) {
    if (!terminal.has(state) || !Number.isInteger(exitCode) || exitCode < -1 || exitCode > 255) fail('invalid_finish', 400);
    if (processStopped !== true || cleanupComplete !== true) fail('finish_unproven');
    return this.#transition(principalId, requestId, state, { exitCode, processStopped, cleanupComplete });
  }
  active() {
    try {
      const slot = this.#db.prepare('SELECT principal,request_id FROM capacity WHERE id=1').get();
      return slot.principal === null ? null : this.#record(this.#row(slot.principal, slot.request_id));
    } catch { fail('store_unavailable', 503); }
  }
  close() { this.#db.close(); }
}
