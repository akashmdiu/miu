import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'MIU_PROFILES',
  'MIU_AGENT_USER', 'MIU_AGENT_REX', 'MIU_AGENT_EXEC', 'MIU_AGENT_BASE_PATH',
]);
const PATH_LOCATORS = Object.freeze([
  'MIU_AGENT_LIB', 'MIU_AGENT_CLAUDE', 'MIU_AGENT_CODEX', 'MIU_AGENT_CODEX_DIR',
  'CREDENTIALS_DIRECTORY', 'MIU_SECRETS_KEY_FILE', 'PLAYWRIGHT_BROWSERS_PATH',
]);
const owns = (stat) => !process.getuid || stat.uid === process.getuid();
const refusal = (code) => Object.assign(new Error(code), { code });

/** A refusal emitted only while this launcher knows it has not created a child. */
export class LaunchRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}

function trustedFile(filename) {
  const stat = fs.lstatSync(filename);
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && (owns(stat) || stat.uid === 0) && (stat.mode & 0o022) === 0;
}

/** Launches only admitted work; it never inherits the caller's environment. */
export function createWorkerLauncher({ workerPath, runsDirectory, nodePath = process.execPath,
  environment = {}, preflight = async () => true, preflightTimeoutMs = 5000, managementDirectory }) {
  if (![workerPath, runsDirectory, nodePath].every((value) => typeof value === 'string' && path.isAbsolute(value))
      || typeof preflight !== 'function' || !Number.isSafeInteger(preflightTimeoutMs)
      || preflightTimeoutMs < 1 || preflightTimeoutMs > 10000) throw new TypeError('invalid worker launcher');
  if (managementDirectory !== undefined && !path.isAbsolute(managementDirectory)) throw new TypeError('absolute management directory required');
  const childEnvironment = Object.create(null);
  for (const key of ENVIRONMENT_KEYS) {
    if (typeof environment[key] === 'string' && !environment[key].includes('\0')) childEnvironment[key] = environment[key];
  }
  // These are trusted supervisor configuration paths, never credential values.
  // Agent subprocesses still receive their separately filtered environments.
  for (const key of PATH_LOCATORS) {
    if (environment[key] === undefined) continue;
    const value = environment[key];
    if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) {
      throw new TypeError('absolute worker configuration path required');
    }
    childEnvironment[key] = value;
  }
  return async (record, { isCancelled }) => {
    if (isCancelled()) return null;
    let timer;
    let output;
    let directory;
    let createdDirectory = false;
    let child;
    try {
      const approved = await Promise.race([
        Promise.resolve().then(() => preflight(record)),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(refusal('preflight_timeout')), preflightTimeoutMs);
        }),
      ]);
      if (isCancelled()) return null;
      if (approved !== true) throw refusal('revision_mismatch');
      if (!record || typeof record.runName !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(record.runName)) {
        throw refusal('invalid_run_name');
      }
      const root = fs.lstatSync(runsDirectory);
      if (!root.isDirectory() || root.isSymbolicLink() || !owns(root) || (root.mode & 0o022) !== 0
          || !trustedFile(workerPath) || !trustedFile(nodePath)) throw refusal('unsafe_worker_path');
      // Refuse pre-existing state. An uncertain launch must never become a new worker.
      directory = path.join(runsDirectory, record.runName);
      fs.mkdirSync(directory, { mode: 0o700 });
      createdDirectory = true;
      output = fs.openSync(path.join(directory, 'qa-run.out'), fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      child = spawn(nodePath, [workerPath], { cwd: directory, env: childEnvironment,
        detached: true, stdio: ['ignore', output, output, 'ipc'] });
      // Always absorb asynchronous spawn/IPC errors; the controller also observes them.
      child.on('error', () => {});
      child.once('spawn', () => {
        try {
          child.send({ type: 'miu-admitted', record, ...(managementDirectory ? { managementDirectory } : {}) }, (error) => {
            if (error) child.emit('error', refusal('worker_admission_unknown'));
          });
        } catch { child.emit('error', refusal('worker_admission_unknown')); }
      });
      return child;
    } catch (error) {
      // After spawn() returned, even an error cannot establish no child effect.
      if (child) throw refusal('worker_launch_unknown');
      if (createdDirectory) {
        try {
          if (output !== undefined) { fs.closeSync(output); output = undefined; fs.unlinkSync(path.join(directory, 'qa-run.out')); }
          fs.rmdirSync(directory);
        } catch { throw refusal('worker_cleanup_unknown'); }
      }
      throw new LaunchRefusal(['revision_mismatch', 'preflight_timeout', 'invalid_run_name', 'unsafe_worker_path'].includes(error?.code)
        ? error.code : 'worker_launch_refused');
    } finally {
      clearTimeout(timer);
      if (output !== undefined) fs.closeSync(output);
    }
  };
}
