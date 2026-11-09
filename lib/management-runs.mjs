import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StoreError } from './management-store.mjs';
import { LaunchRefusal } from './management-launcher.mjs';
import { projectResult } from './management-result.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const evidenceNames = Object.freeze({
  'report.md': 'report', 'final-report.md': 'report', 'comment.md': 'report',
  'verdict.json': 'result', 'results.json': 'result',
});
const privateDirectory = (stat) => stat.isDirectory() && !stat.isSymbolicLink()
  && (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;

/** Owns live child handles; persisted PIDs never confer authority after restart. */
export class ManagedRuns {
  #store;
  #runsDirectory;
  #launch;
  #legacyBusy;
  #observeStopped;
  #evidenceDirectory;
  #owned = new Map();

  constructor({ store, runsDirectory, launch, legacyBusy = () => null, observeStopped = async () => false, evidenceDirectory }) {
    if (!store || typeof launch !== 'function' || typeof legacyBusy !== 'function'
        || typeof observeStopped !== 'function' || !path.isAbsolute(runsDirectory)) throw new TypeError('invalid run controller');
    this.#store = store;
    this.#runsDirectory = runsDirectory;
    this.#launch = launch;
    this.#legacyBusy = legacyBusy;
    this.#observeStopped = observeStopped;
    if (evidenceDirectory !== undefined && !path.isAbsolute(evidenceDirectory)) throw new TypeError('absolute evidence directory required');
    this.#evidenceDirectory = evidenceDirectory;
  }

  #key(principalId, requestId) { return JSON.stringify([principalId, requestId]); }

  #admit(args, launch) {
    const prior = this.#store.lookup(args.principalId, args.requestId);
    if (!prior && this.#legacyBusy()) throw new StoreError('run_busy');
    const result = this.#store.reserve(args);
    if (result.created) {
      const owner = { record: result.record, child: null, cancelled: false, ack: null, closed: false, finalizing: false, launchSettled: false };
      this.#owned.set(this.#key(args.principalId, args.requestId), owner);
      // Admission is durable before the factory can perform any external operation.
      void this.#start(owner, launch);
    }
    return result;
  }

  async submit({ principalId, requestId, intent }) {
    const digest = createHash('sha256').update(JSON.stringify([principalId, requestId])).digest('hex').slice(0, 32);
    return this.#admit({ principalId, requestId, intent, runName: `managed-${digest}` }, this.#launch);
  }

  admitLegacy({ requestId, intent, runName, launch }) {
    if (typeof launch !== 'function') throw new TypeError('invalid legacy launcher');
    return this.#admit({ principalId: '_dashboard', requestId, intent, runName }, launch);
  }

  #unknown(owner, code) {
    const { principalId, requestId } = owner.record;
    const record = this.#store.lookup(principalId, requestId);
    if (record && !terminal.has(record.state)) this.#store.markUnknown(principalId, requestId, code);
  }

  async #start(owner, launch) {
    const { principalId, requestId } = owner.record;
    try {
      this.#store.start(principalId, requestId);
      const child = await launch(owner.record, { isCancelled: () => owner.cancelled });
      if (child === null && owner.cancelled) {
        this.#store.finish(principalId, requestId, { state: 'cancelled', exitCode: 0, processStopped: true, cleanupComplete: true });
        return;
      }
      if (!child || typeof child.on !== 'function' || !Number.isSafeInteger(child.pid) || child.pid < 1) {
        this.#unknown(owner, 'launch_unproven');
        return;
      }
      owner.child = child;
      child.on('message', (message) => {
        if (owner.closed || owner.ack || !this.#validAck(owner, message)) return;
        try { owner.ack = { cancelled: message.cancelled,
          outcome: projectResult(message.outcome ?? { verdict: null, mode: null, sites: [] }) }; }
        catch { /* malformed completion data is not authority to release capacity */ }
      });
      child.once('error', () => { try { this.#unknown(owner, 'worker_error'); } catch { /* durable reservation remains */ } });
      child.once('close', (code) => {
        owner.closed = true;
        void this.#finish(owner, code);
      });
      if (owner.cancelled) this.#sendCancel(owner);
      else this.#store.attach(principalId, requestId, { pid: child.pid });
    } catch (error) {
      if (error instanceof LaunchRefusal && !owner.child) {
        try {
          this.#store.finish(principalId, requestId, { state: 'failed', exitCode: 1, processStopped: true, cleanupComplete: true });
        } catch { try { this.#unknown(owner, 'launch_unknown'); } catch {} }
        return;
      }
      try { this.#unknown(owner, 'launch_unknown'); } catch { /* never release or retry an uncertain launch */ }
    } finally { owner.launchSettled = true; }
  }

  #validAck(owner, message) {
    const record = owner.record;
    return message && message.type === 'miu-complete' && message.requestId === record.requestId
      && message.runName === record.runName && message.baseSha === record.intent.baseSha
      && message.headSha === record.intent.headSha && message.cleanupComplete === true
      && typeof message.cancelled === 'boolean' && (!message.cancelled || owner.cancelled);
  }

  async #finish(owner, code) {
    if (owner.finalizing) return;
    owner.finalizing = true;
    try {
      if (!owner.ack || !Number.isInteger(code) || code < 0 || code > 255
          || await this.#observeStopped(owner.child, owner.record) !== true) {
        this.#unknown(owner, 'completion_unproven');
        return;
      }
      if (this.#evidenceDirectory) this.#captureEvidence(owner.record, owner.ack.outcome);
      this.#store.finish(owner.record.principalId, owner.record.requestId, {
        state: owner.ack.cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed',
        exitCode: code, processStopped: true, cleanupComplete: true,
      });
    } catch {
      try { this.#unknown(owner, 'completion_unknown'); } catch { /* keep the capacity fence */ }
    }
  }

  async read(principalId, requestId) {
    const record = this.#store.lookup(principalId, requestId);
    if (!record) return null;
    return { record, observation: this.#owned.has(this.#key(principalId, requestId)) ? 'observed' : 'retained' };
  }

  async list(principalId, options) { return this.#store.list(principalId, options); }

  observation(principalId, requestId) {
    const owner = this.#owned.get(this.#key(principalId, requestId));
    return owner ? { observation: 'observed', live: !!owner.child && !owner.closed,
      pending: !owner.launchSettled } : { observation: 'retained', live: null, pending: null };
  }

  abandon(principalId, requestId) {
    const owner = this.#owned.get(this.#key(principalId, requestId));
    if (!owner) throw new StoreError('owner_unavailable');
    this.#unknown(owner, 'supervisor_deadline');
    // Closing IPC asks the worker to cancel; it is not proof of cessation.
    if (owner.child?.connected) owner.child.disconnect();
    owner.child?.unref();
  }

  #sendCancel(owner) {
    if (owner.child?.connected !== true || typeof owner.child.send !== 'function') return;
    try {
      owner.child.send({ type: 'miu-cancel', requestId: owner.record.requestId, runName: owner.record.runName },
        (error) => { if (error) { try { this.#unknown(owner, 'cancel_delivery_unknown'); } catch {} } });
    } catch { this.#unknown(owner, 'cancel_delivery_unknown'); }
  }

  async cancel(principalId, requestId) {
    const record = this.#store.lookup(principalId, requestId);
    if (!record) throw new StoreError('request_not_found', 404);
    if (terminal.has(record.state)) return record;
    const owner = this.#owned.get(this.#key(principalId, requestId));
    if (!owner) return this.#store.markUnknown(principalId, requestId, 'owner_unavailable');
    if (record.state === 'unknown_effect') return record;
    this.#store.requestCancel(principalId, requestId);
    owner.cancelled = true;
    this.#sendCancel(owner);
    return this.#store.lookup(principalId, requestId);
  }

  async evidence(principalId, requestId) {
    const record = this.#store.lookup(principalId, requestId);
    if (!record) throw new StoreError('request_not_found', 404);
    if (this.#evidenceDirectory) return this.#readSnapshot(record).evidence;
    return this.#metadata(record, false);
  }

  async result(principalId, requestId) {
    const record = this.#store.lookup(principalId, requestId);
    if (!record) throw new StoreError('request_not_found', 404);
    return this.#evidenceDirectory ? this.#readSnapshot(record).result : null;
  }

  #metadata(record, shared) {
    const directory = path.join(this.#runsDirectory, record.runName);
    try {
      const root = fs.lstatSync(this.#runsDirectory), leaf = fs.lstatSync(directory);
      if (shared) {
        if (!root.isDirectory() || root.isSymbolicLink() || !leaf.isDirectory() || leaf.isSymbolicLink()
            || (process.getuid && (root.uid !== process.getuid() || leaf.uid !== process.getuid()))
            || (root.mode & 0o022) !== 0 || (leaf.mode & 0o002) !== 0) throw new StoreError('unsafe_storage');
      } else if (!privateDirectory(root) || !privateDirectory(leaf)) return [];
    } catch { return []; }
    const result = [];
    let total = 0;
    for (const [name, kind] of Object.entries(evidenceNames)) {
      let fd;
      try {
        fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (stat.isFile() && stat.nlink === 1 && (!process.getuid || stat.uid === process.getuid())
            && stat.size <= 16 * 1024 * 1024 && total + stat.size <= 64 * 1024 * 1024) {
          total += stat.size;
          result.push({ name, sizeBytes: stat.size, kind });
        }
      } catch { /* missing or unsafe evidence is not exposed */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    return result;
  }

  #captureEvidence(record, outcome) {
    fs.mkdirSync(this.#evidenceDirectory, { recursive: true, mode: 0o700 });
    if (!privateDirectory(fs.lstatSync(this.#evidenceDirectory))) throw new StoreError('unsafe_storage');
    const bytes = JSON.stringify({ version: 1, principalId: record.principalId, requestId: record.requestId,
      runName: record.runName, baseSha: record.intent.baseSha, headSha: record.intent.headSha,
      evidence: this.#metadata(record, true), result: projectResult(outcome) });
    if (Buffer.byteLength(bytes) > 4096) throw new StoreError('store_unavailable', 503);
    const filename = path.join(this.#evidenceDirectory, `${record.runName}.json`);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(this.#evidenceDirectory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  #readSnapshot(record) {
    let fd;
    try {
      if (!privateDirectory(fs.lstatSync(this.#evidenceDirectory))) throw new StoreError('unsafe_storage');
      fd = fs.openSync(path.join(this.#evidenceDirectory, `${record.runName}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
          || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw new StoreError('unsafe_storage');
      const bytes = Buffer.alloc(4097);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const snapshot = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (!snapshot || snapshot.version !== 1 || snapshot.principalId !== record.principalId
          || snapshot.requestId !== record.requestId || snapshot.runName !== record.runName
          || snapshot.baseSha !== record.intent.baseSha || snapshot.headSha !== record.intent.headSha) throw new StoreError('unsafe_storage');
      const entries = snapshot.evidence;
      if (count > 4096 || !Array.isArray(entries) || entries.length > Object.keys(evidenceNames).length
          || entries.some((entry) => !entry || Object.keys(entry).sort().join(',') !== 'kind,name,sizeBytes'
            || !Object.hasOwn(evidenceNames, entry.name) || entry.kind !== evidenceNames[entry.name]
            || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > 16777216)) throw new StoreError('unsafe_storage');
      return { evidence: entries, result: projectResult(snapshot.result) };
    } catch (error) {
      if (error.code === 'ENOENT') return { evidence: [], result: null };
      throw new StoreError('store_unavailable', 503);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
