import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{id:string, scopes:ReadonlyArray<string>, repositories:ReadonlyArray<string>}} ManagementPrincipal */
export const MANAGEMENT_SCOPES = Object.freeze([
  'health:read', 'app:read', 'runs:submit', 'runs:read', 'runs:cancel',
  'evidence:read', 'runs:publish', 'runs:trusted',
]);
const MAX_BYTES = 65536;
const ownUid = typeof process.getuid === 'function' ? process.getuid() : null;
const fail = (code, status = 500) => Object.assign(new Error(code), { code, status });
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
  && !['__proto__', 'constructor', 'prototype', '_dashboard'].includes(id);
const validRepo = (repo) => typeof repo === 'string'
  && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)
  && !repo.split('/').some((part) => part === '.' || part === '..');
const plainObject = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validScopes = (scopes) => Array.isArray(scopes) && scopes.length > 0
  && scopes.length <= MANAGEMENT_SCOPES.length
  && scopes.every((scope) => MANAGEMENT_SCOPES.includes(scope))
  && new Set(scopes).size === scopes.length;
const validRepos = (repos) => Array.isArray(repos) && repos.length <= 100
  && repos.every(validRepo) && new Set(repos).size === repos.length;
const needsRepos = (scopes) => scopes.some((scope) => scope.startsWith('runs:') || scope === 'evidence:read');
const digest = (salt, secret) => createHash('sha256').update(salt).update(secret).digest('hex');

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await lstat(directory); }
  catch (error) {
    if (!create && error.code === 'ENOENT') return false;
    throw fail('unsafe_storage');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (ownUid !== null && stat.uid !== ownUid)) throw fail('unsafe_storage');
  return true;
}

async function secureRead(filename) {
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('unsafe_storage');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
        || (ownUid !== null && stat.uid !== ownUid) || stat.size > MAX_BYTES) throw fail('unsafe_storage');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw fail('unsafe_storage');
    return bytes.subarray(0, total).toString('utf8');
  } finally { await file.close(); }
}

function parseStore(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { throw fail('unsafe_storage'); }
  if (!plainObject(data) || data.version !== 1 || !plainObject(data.principals)
      || Object.keys(data.principals).length > 1000) throw fail('unsafe_storage');
  for (const [id, entry] of Object.entries(data.principals)) {
    if (!validId(id) || !plainObject(entry) || typeof entry.salt !== 'string'
        || !/^[a-f0-9]{32}$/.test(entry.salt) || typeof entry.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.digest) || !validScopes(entry.scopes)
        || !validRepos(entry.repositories)
        || entry.repositories.some((repo) => repo !== repo.toLowerCase())
        || (needsRepos(entry.scopes) && !entry.repositories.length)) throw fail('unsafe_storage');
  }
  return data;
}

async function syncDirectory(directory) {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

async function replaceStore(directory, filename, data) {
  const bytes = JSON.stringify(data);
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('store_limit', 409);
  const temporary = join(directory, `.credentials-${randomBytes(16).toString('hex')}.tmp`);
  let replaced = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
    replaced = true;
    await syncDirectory(directory);
  } catch (error) {
    // A failed directory sync cannot promise the preceding replacement survived a crash.
    if (replaced) throw fail('credential_outcome_unknown', 503);
    throw error?.code === 'store_limit' ? error : fail('storage_unavailable', 503);
  } finally { await rm(temporary, { force: true }); }
}

const principal = (id, entry) => Object.freeze({
  id, scopes: Object.freeze([...entry.scopes]), repositories: Object.freeze([...entry.repositories]),
});

/** Owner-controlled credential provisioning. Secrets enter through stdin in the caller, never output. */
export class CredentialStore {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('directory required');
    this.directory = directory;
    this.path = join(directory, 'credentials.json');
  }

  async #change(mutate) {
    await privateDirectory(this.directory, true);
    const lock = join(this.directory, '.credentials.lock');
    let handle;
    try { handle = await open(lock, 'wx', 0o600); }
    catch { throw fail('provision_busy', 409); }
    try {
      const raw = await secureRead(this.path);
      const data = raw === null ? { version: 1, principals: Object.create(null) } : parseStore(raw);
      const result = mutate(data);
      if (result.changed) await replaceStore(this.directory, this.path, data);
      return result.value;
    } finally {
      await handle.close();
      await rm(lock);
      await syncDirectory(this.directory);
    }
  }

  async provision({ id, secret, scopes, repositories = [] }) {
    if (!validId(id) || typeof secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(secret)
        || !validScopes(scopes) || !validRepos(repositories)) throw fail('invalid_credential', 400);
    const canonical = repositories.map((repo) => repo.toLowerCase());
    if (new Set(canonical).size !== canonical.length) throw fail('invalid_credential', 400);
    if (needsRepos(scopes) && !canonical.length) throw fail('repositories_required', 400);
    return this.#change((data) => {
      if (!Object.hasOwn(data.principals, id) && Object.keys(data.principals).length >= 1000) throw fail('store_limit', 409);
      const salt = randomBytes(16).toString('hex');
      data.principals[id] = { salt, digest: digest(salt, secret), scopes: [...scopes], repositories: canonical };
      return { changed: true, value: principal(id, data.principals[id]) };
    });
  }

  async revoke(id) {
    if (!validId(id)) throw fail('invalid_credential', 400);
    return this.#change((data) => {
      const present = Object.hasOwn(data.principals, id);
      if (present) delete data.principals[id];
      return { changed: present, value: present };
    });
  }

  async authenticate(authorization, { scope, repo } = {}) {
    const deny = () => fail('unauthorized', 401);
    if (typeof authorization !== 'string' || authorization.length > 590) throw deny();
    const match = /^Bearer ([A-Za-z0-9_-]{1,64})\.([\x21-\x7e]{32,512})$/.exec(authorization);
    if (!match || !validId(match[1])) throw deny();
    if (!await privateDirectory(this.directory)) throw deny();
    const raw = await secureRead(this.path);
    if (raw === null) throw deny();
    const data = parseStore(raw);
    if (!Object.hasOwn(data.principals, match[1])) throw deny();
    const entry = data.principals[match[1]];
    const actual = Buffer.from(digest(entry.salt, match[2]), 'hex');
    if (!timingSafeEqual(actual, Buffer.from(entry.digest, 'hex'))) throw deny();
    if (scope && !entry.scopes.includes(scope)) throw fail('forbidden', 403);
    if (repo && (!validRepo(repo) || !entry.repositories.includes(repo.toLowerCase()))) throw fail('forbidden', 403);
    return principal(match[1], entry);
  }
}
