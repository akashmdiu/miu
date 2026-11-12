import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CredentialStore } from './management-auth.mjs';
import { RequestStore } from './management-store.mjs';
import { ManagedRuns } from './management-runs.mjs';
import { createWorkerLauncher } from './management-launcher.mjs';
import { MODELS } from './engines.mjs';
import { parseQaArguments } from './management-cli-intent.mjs';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const owns = (stat) => !process.getuid || stat.uid === process.getuid();

function privateDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('invalid_configuration');
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) { if (!create && error.code === 'ENOENT') return false; fail('unsafe_configuration'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owns(stat) || (stat.mode & 0o077) !== 0) fail('unsafe_configuration');
  return true;
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function runDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail('unsafe_configuration'); }
  // Named ACL traversal for the agent may set group execute bits. The parent
  // remains owner-controlled: agents cannot rename another run's directory.
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owns(stat) || (stat.mode & 0o022) !== 0) fail('unsafe_configuration');
}

/** Miu-owned public engine policy, read without ever loading an API key. */
export function readAuthenticationMode(runsDirectory, model) {
  const automatic = typeof model === 'string' && /^auto(?::(claude|codex))?$/.exec(model);
  const engine = automatic ? automatic[1] ?? 'claude' : MODELS.find((candidate) => candidate.id === model)?.engine;
  if (!engine) fail('engine_unavailable');
  let fd;
  let configuration = {};
  try {
    fd = fs.openSync(path.join(runsDirectory, '.config.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !owns(stat) || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 65536) fail('configuration_unavailable');
    const bytes = Buffer.alloc(65537);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 65536) fail('configuration_unavailable');
    configuration = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
        || (configuration.connections !== undefined && (!configuration.connections || typeof configuration.connections !== 'object' || Array.isArray(configuration.connections)))) fail('configuration_unavailable');
  } catch (error) { if (error.code !== 'ENOENT') fail('configuration_unavailable'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const mode = configuration.connections?.[engine] ?? 'plan';
  if (!['plan', 'api'].includes(mode)) fail('engine_unavailable');
  return mode;
}

/** Read only public service metadata; never credentials, keys, or browser state. */
export function readManagementConfiguration(directory) {
  if (!privateDirectory(directory)) return null;
  let fd;
  try { fd = fs.openSync(path.join(directory, 'service.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('unsafe_configuration'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !owns(stat) || (stat.mode & 0o077) !== 0 || stat.size > 4096) fail('unsafe_configuration');
    const bytes = Buffer.alloc(4097);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) fail('unsafe_configuration');
    let value;
    try { value = JSON.parse(bytes.subarray(0, count).toString('utf8')); } catch { fail('unsafe_configuration'); }
    if (!value || Object.keys(value).sort().join(',') !== 'runsDirectory,version'
        || value.version !== 1 || typeof value.runsDirectory !== 'string' || !path.isAbsolute(value.runsDirectory)) fail('unsafe_configuration');
    return Object.freeze({ version: 1, runsDirectory: value.runsDirectory });
  } finally { fs.closeSync(fd); }
}

/** Explicit owner setup. Existing authority is immutable; no implicit migration. */
export function configureManagement({ directory, runsDirectory }) {
  if (typeof runsDirectory !== 'string' || !path.isAbsolute(runsDirectory)) fail('invalid_configuration');
  privateDirectory(directory, true);
  const existing = readManagementConfiguration(directory);
  if (existing) {
    if (existing.runsDirectory !== runsDirectory) fail('configuration_conflict');
    runDirectory(runsDirectory);
    return existing;
  }
  runDirectory(runsDirectory, true);
  const value = { version: 1, runsDirectory };
  const temporary = path.join(directory, `.service-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, path.join(directory, 'service.json')); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.unlinkSync(temporary);
    syncDirectory(directory);
    const configured = readManagementConfiguration(directory);
    if (!configured || configured.runsDirectory !== runsDirectory) fail('configuration_conflict');
    return configured;
  } catch (error) {
    if (error?.code === 'configuration_conflict') throw error;
    fail('configuration_outcome_unknown');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Only an owned, closed ChildProcess handle may justify a process-group probe. */
export async function observeOwnedGroupStopped(child) {
  if (!(child instanceof ChildProcess) || !Number.isSafeInteger(child.pid) || child.pid < 1
      || (child.exitCode === null && child.signalCode === null)) return false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { process.kill(-child.pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function openManagementService({ directory, runsDirectory, workerPath, nodePath,
  environment = {}, preflight, legacyBusy, observeStopped = observeOwnedGroupStopped }) {
  if (typeof preflight !== 'function') throw new TypeError('read-only preflight callback required');
  const configuration = readManagementConfiguration(directory);
  if (!configuration || configuration.runsDirectory !== runsDirectory) fail('configuration_conflict');
  runDirectory(runsDirectory);
  const policyMatches = (record) => {
    if (record.intent.authMode === undefined) return true;
    const args = record.intent.argv;
    const selected = Array.isArray(args) ? parseQaArguments(args).option('--model', record.intent.model) : record.intent.model;
    return readAuthenticationMode(runsDirectory, selected) === record.intent.authMode;
  };
  const launch = createWorkerLauncher({ workerPath, runsDirectory, nodePath, environment, managementDirectory: directory,
    preflight: async (record) => policyMatches(record) && await preflight(record) === true && policyMatches(record) });
  const store = new RequestStore({ directory });
  try {
    const control = new ManagedRuns({ store, runsDirectory, launch, legacyBusy, observeStopped,
      evidenceDirectory: path.join(directory, 'evidence') });
    return Object.freeze({ store, control, launch, credentials: new CredentialStore({ directory }),
      close: () => store.close() });
  } catch (error) { store.close(); throw error; }
}

/** Kernel-held lease for the one dashboard queue writer; no stale PID takeover. */
export function acquireDashboardLease(directory) {
  if (!privateDirectory(directory)) fail('unsafe_configuration');
  const filename = path.join(directory, 'dashboard.sqlite');
  try { const fd = fs.openSync(filename, 'wx', 0o600); fs.closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') fail('unsafe_configuration'); }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owns(stat) || (stat.mode & 0o077) !== 0) fail('unsafe_configuration');
  let database;
  try {
    database = new DatabaseSync(filename);
    database.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF;');
    const version = database.prepare('PRAGMA user_version').get().user_version;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    if (version === 0 && tables.length === 0) database.exec('CREATE TABLE dashboard_guard(id INTEGER PRIMARY KEY); PRAGMA user_version=1;');
    else if (version !== 1 || tables.join(',') !== 'dashboard_guard') fail('unsafe_configuration');
    database.exec('BEGIN IMMEDIATE');
    return { close: () => { database.exec('ROLLBACK'); database.close(); } };
  } catch (error) {
    try { database?.close(); } catch {}
    if (error.code === 'unsafe_configuration') throw error;
    fail('dashboard_busy');
  }
}
