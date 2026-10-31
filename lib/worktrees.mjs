// Code for a run comes from git, not from a fresh clone and build.
//
// Layout, all inside .cache in Miu's folder and never in the user's own checkouts:
//   .cache/repos/<name>.git     one bare clone per repo, fetched before each run
//   .cache/wt/<name>-pr         worktree with the pull request's head
//   .cache/wt/<name>-dev        worktree with the base branch
//
// The worktrees are fixed slots and are reused: a run moves them to a commit
// with checkout + reset --hard + clean, so they never pile up. vendor/ and
// node_modules/ survive the clean and are reinstalled only when composer.lock
// or package-lock.json changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = process.env.QA_CACHE_DIR ?? path.join(ROOT, '.cache');
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();

const remoteUrl = (repo) => `https://github.com/${repo}.git`;
// authEnv comes from github.mjs gitAuthEnv(): the token travels in GIT_CONFIG_*
// environment variables, never in a URL or argument a process list shows.
const withAuth = (authEnv) => (authEnv ? { env: { ...process.env, ...authEnv } } : {});

// One bare clone per repo; created once, fetched every run.
export function ensureRepo(repo, authEnv, fallbackEnv) {
  const name = repo.split('/')[1];
  const bare = path.join(CACHE, 'repos', `${name}.git`);
  if (!fs.existsSync(path.join(bare, 'HEAD'))) {
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    // The App may not be installed on this repo: then the person's token.
    try { git(['clone', '--bare', '--quiet', remoteUrl(repo), bare], withAuth(authEnv)); }
    catch (e) { if (!fallbackEnv) throw e; fs.rmSync(bare, { recursive: true, force: true }); git(['clone', '--bare', '--quiet', remoteUrl(repo), bare], withAuth(fallbackEnv)); }
  }
  git(['-C', bare, 'worktree', 'prune']);
  return bare;
}

// Fetch a ref (a branch name, or refs/pull/N/head) and return its commit.
export function fetchRef(repo, ref, authEnv, fallbackEnv) {
  const bare = ensureRepo(repo, authEnv, fallbackEnv);
  const local = ref.startsWith('refs/pull/') ? `refs/qa/pr-${ref.split('/')[2]}` : `refs/qa/${ref}`;
  const args = ['-C', bare, 'fetch', '--quiet', '--force', remoteUrl(repo), `+${ref}:${local}`];
  try { git(args, withAuth(authEnv)); } catch (e) { if (!fallbackEnv) throw e; git(args, withAuth(fallbackEnv)); }
  return git(['-C', bare, 'rev-parse', local]);
}

export const redact = (t) => String(t).replace(/\b(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{30,}/g, '[secret removed]');

const hashFile = (f) => (fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') : 'none');

// Move a worktree slot to a commit, creating the slot on first use.
export function checkoutSlot(repo, slot, sha) {
  const name = repo.split('/')[1];
  const bare = path.join(CACHE, 'repos', `${name}.git`);
  const dir = path.join(CACHE, 'wt', `${name}-${slot}`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    git(['-C', bare, 'worktree', 'add', '--detach', '--force', dir, sha]);
  } else {
    git(['-C', dir, 'checkout', '--detach', '--force', '--quiet', sha]);
  }
  git(['-C', dir, 'reset', '--hard', '--quiet', sha]);
  // Untracked leftovers go; installed dependencies stay.
  git(['-C', dir, 'clean', '-ffdxq', '-e', 'vendor', '-e', 'node_modules']);
  return dir;
}

// Install dependencies only when their lock files changed since last time.
// Returns what it did, for the run log.
export function ensureDeps(dir, { build = false, env = process.env, fallbackEnv = null } = {}) {
  // The stamp lives outside the worktree, so git status there stays clean.
  const stamp = path.join(CACHE, 'deps', `${path.basename(dir)}.json`);
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  const before = fs.existsSync(stamp) ? JSON.parse(fs.readFileSync(stamp, 'utf8')) : {};
  const now = { composer: hashFile(path.join(dir, 'composer.lock')), npm: hashFile(path.join(dir, 'package-lock.json')) };
  const did = [];
  // The node that runs the harness goes first on PATH: a login shell can pick
  // a different node whose npm fails without a word.
  const runEnv = { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}` };
  const runWith = (cmd, extra) => {
    const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...runEnv, ...extra }, timeout: 15 * 60 * 1000 });
    if (r.status !== 0) {
      // The line that names the cause (Composer ends with its usage text).
      const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
      const cause = lines.filter((l) => /could not|failed to|error|not found|denied|\b40[134]\b|unable to|requires/i.test(l) && !/^install \[|^\[--/.test(l)).slice(0, 2).join(' ') || lines.slice(-3).join(' ');
      // Composer can echo COMPOSER_AUTH back in an error: no token-like string
      // leaves here (this message reaches logs and reports). Commit shas stay.
      throw new Error(`${cmd.split(' ').slice(0, 2).join(' ')} failed in ${path.basename(dir)}: ${redact(cause).slice(0, 300)}`);
    }
  };
  const run = (cmd) => runWith(cmd, {});
  if (fs.existsSync(path.join(dir, 'composer.json')) && (now.composer !== before.composer || !fs.existsSync(path.join(dir, 'vendor')))) {
    // A private package in a repo the App cannot see: once more with the person's token.
    try { run('composer install --no-interaction --no-progress --prefer-dist'); }
    catch (e) {
      if (!fallbackEnv || !/github|40[34]|could not be downloaded/i.test(e.message)) throw e;
      runWith('composer install --no-interaction --no-progress --prefer-dist', fallbackEnv);
    }
    did.push('composer install');
  }
  if (fs.existsSync(path.join(dir, 'package.json')) && (now.npm !== before.npm || !fs.existsSync(path.join(dir, 'node_modules')))) {
    run('npm ci --no-audit --no-fund --loglevel=error'); did.push('npm ci');
  }
  if (build) { run('npm run build --loglevel=error'); did.push('npm run build'); }
  fs.writeFileSync(stamp, JSON.stringify(now));
  return did;
}
