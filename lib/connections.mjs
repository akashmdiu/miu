// How Miu reaches each AI engine, set in the dashboard under AI connections.
// Each engine is connected one way at a time:
//   plan   an account sign-in (OAuth), billed to the plan: the Claude
//          subscription (a `claude setup-token` token from "Sign in with
//          Claude", a pasted one, or the CLI's own login) or a ChatGPT plan
//          ("Sign in with ChatGPT", kept in Miu's own Codex folder so the
//          user's personal Codex sign-in is untouched; without it, runs use
//          the personal one)
//   api    an API key, billed per token by Anthropic or OpenAI
//   off    the engine's models are not offered
// The mode is in the dashboard config (runs/.config.json, no secrets). Tokens
// and keys are in ~/.config/miu/keys.enc.json, readable by this user only and
// encrypted (AES-256-GCM) with a key that is not stored beside it: a systemd
// credential on a server (LoadCredentialEncrypted=miu-secrets-key, sealed with
// the machine's own secret), the login Keychain on a Mac, or MIU_SECRETS_KEY_FILE.
// Without one of those they stay in plain keys.json, as before. They are
// never sent to the browser (only their last four characters) and never put in
// the agent's environment where its shell could print them:
//   - a Claude API key reaches the CLI through apiKeyHelper (lib/keyhelper.mjs)
//   - a Codex API key goes in CODEX_API_KEY, which Codex keeps out of the
//     commands it runs (it drops *KEY* variables from their environment)
// The Claude subscription token is the exception: the CLI only reads it from
// CLAUDE_CODE_OAUTH_TOKEN. scrub() removes every known secret from a report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexBinary } from './codex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(os.homedir(), '.config', 'miu');
const KEYS_FILE = path.join(DIR, 'keys.json');
// Miu's own CODEX_HOME: only its sign-in lives there (runs pass --ignore-user-config and --ephemeral).
const CODEX_HOME = path.join(DIR, 'codex');
const miuCodex = () => fs.existsSync(path.join(CODEX_HOME, 'auth.json'));
// Where an earlier version kept the subscription token; still read.
const OLD_TOKEN_FILE = process.env.QA_CLAUDE_TOKEN_FILE ?? path.join(os.homedir(), '.config/miu/claude-token');

export const MODES = ['plan', 'api', 'off'];
export const DEFAULT_MODES = { claude: 'plan', codex: 'plan' };

const ENC_FILE = path.join(DIR, 'keys.enc.json');

// The 32-byte key that seals keys.enc.json, and where it came from.
let sealKey;
function secretsKey() {
  if (sealKey !== undefined) return sealKey;
  sealKey = null;
  const fromFile = (file, from) => {
    try { const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'); if (k.length === 32) sealKey = { key: k, from }; } catch { /* not there */ }
  };
  if (process.env.MIU_SECRETS_KEY_FILE) fromFile(process.env.MIU_SECRETS_KEY_FILE, 'a key file');
  else if (process.env.CREDENTIALS_DIRECTORY) fromFile(path.join(process.env.CREDENTIALS_DIRECTORY, 'miu-secrets-key'), 'a systemd credential');
  if (!sealKey && process.platform === 'darwin') {
    // A locked Keychain can wait on a dialog; never hold Miu up for it.
    const find = () => spawnSync('security', ['find-generic-password', '-a', 'miu', '-s', 'miu-secrets-key', '-w'], { encoding: 'utf8', timeout: 5000 });
    let r = find();
    if (r.status !== 0) {
      spawnSync('security', ['add-generic-password', '-a', 'miu', '-s', 'miu-secrets-key', '-l', 'Miu secrets key', '-w', crypto.randomBytes(32).toString('hex')], { timeout: 5000 });
      r = find();
    }
    const k = r.status === 0 ? Buffer.from(r.stdout.trim(), 'hex') : null;
    if (k?.length === 32) sealKey = { key: k, from: 'the macOS Keychain' };
  }
  return sealKey;
}
export const storage = () => { const s = secretsKey(); return { encrypted: !!s, keyFrom: s?.from ?? null }; };

function readKeys() {
  const s = secretsKey();
  if (fs.existsSync(ENC_FILE)) {
    if (!s) { console.error('keys.enc.json is sealed but no key was found (MIU_SECRETS_KEY_FILE, systemd credential or Keychain).'); return {}; }
    try {
      const box = JSON.parse(fs.readFileSync(ENC_FILE, 'utf8'));
      const d = crypto.createDecipheriv('aes-256-gcm', s.key, Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
    } catch (e) { console.error('keys.enc.json could not be opened:', e.message); return {}; }
  }
  let k; try { k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { return {}; }
  if (s) writeKeys(k); // a plain file from before: seal it now
  return k;
}
function writeKeys(k) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const s = secretsKey();
  if (!s) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2), { mode: 0o600 });
    fs.chmodSync(KEYS_FILE, 0o600);
    return;
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', s.key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(k), 'utf8'), c.final()]);
  const tmp = ENC_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  fs.renameSync(tmp, ENC_FILE);
  fs.chmodSync(ENC_FILE, 0o600);
  // The plain copy goes once the sealed one is in place.
  if (fs.existsSync(KEYS_FILE)) { try { fs.writeFileSync(KEYS_FILE, '0'.repeat(fs.statSync(KEYS_FILE).size)); } catch { /* best effort */ } fs.rmSync(KEYS_FILE, { force: true }); }
}

// What a secret looks like, so a pasted value that is plainly something else
// is turned away before it is saved.
const SHAPE = {
  // A person's GitHub token, for repos the Miu App is not installed on (lib/github.mjs).
  'github:token': /^(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/,
  // The collaborator's own GitHub sign-in through the Miu App (lib/ghuser.mjs):
  // comments go out as that person, with the App's badge.
  'github:user': /^ghu_[A-Za-z0-9]{20,}$/,
  'github:userRefresh': /^ghr_[A-Za-z0-9]{20,}$/,
  'github:userLogin': /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  // The collaborator's own personal token, used only to push fixes (bin/qa-fix)
  // when the App sign-in may not write code.
  'github:pushToken': /^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/,
  // Where report screenshots go (lib/publish.mjs, lib/cloudinary.mjs).
  'cloudinary:url': /^cloudinary:\/\/\d+:[\w-]+@[\w-]+$/,
  'claude:apiKey': /^sk-ant-api\d*-[\w-]{20,}$/,
  'claude:token': /^sk-ant-oat\d*-[\w-]{20,}$/,
  'codex:apiKey': /^sk-[\w-]{20,}$/,
};
export function saveSecret(engine, kind, value) {
  const v = String(value ?? '').trim();
  const shape = SHAPE[`${engine}:${kind}`];
  if (!shape) throw new Error('Unknown secret');
  if (v && !shape.test(v)) throw new Error(kind === 'pushToken' ? 'That is not a GitHub personal token (it starts with ghp_ or github_pat_).' : kind === 'token' ? 'That is not a Claude subscription token (it starts with sk-ant-oat).' : engine === 'claude' ? 'That is not an Anthropic API key (it starts with sk-ant-api).' : 'That is not an OpenAI API key (it starts with sk-).');
  const k = readKeys();
  k[engine] ??= {};
  if (v) k[engine][kind] = v; else delete k[engine][kind];
  writeKeys(k);
}
export const readSecret = (engine, kind) => readKeys()[engine]?.[kind] ?? null;
const last4 = (s) => (s ? '…' + s.slice(-4) : null);

// The subscription token for Claude: saved here, the old token file, the
// environment, then ~/.zshrc (a dashboard started from an editor never loads it).
function claudeToken() {
  const saved = readSecret('claude', 'token');
  if (saved) return { token: saved, from: 'saved in Miu' };
  try { const t = fs.readFileSync(OLD_TOKEN_FILE, 'utf8').trim(); if (t) return { token: t, from: 'token file' }; } catch { /* none */ }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, from: 'environment' };
  if (!process.env.CI) {
    const r = spawnSync('zsh', ['-c', 'source ~/.zshrc >/dev/null 2>&1; printf %s "$CLAUDE_CODE_OAUTH_TOKEN"'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout.trim()) return { token: r.stdout.trim(), from: '~/.zshrc' };
  }
  return null;
}

// How a run reaches the engine in `mode`: environment to set, environment to
// remove, Claude settings and Codex arguments. Applied by bin/qa-run and by
// test() below.
export function authFor(engine, mode) {
  const unset = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  if (engine === 'claude' && mode === 'plan') {
    const t = claudeToken();
    return { env: t ? { CLAUDE_CODE_OAUTH_TOKEN: t.token } : {}, unset, how: t ? `subscription token (${t.from})` : `CLI sign-in (${process.platform === 'darwin' ? 'Keychain' : '~/.claude'})` };
  }
  if (engine === 'claude' && mode === 'api') {
    if (!readSecret('claude', 'apiKey')) throw new Error('No Anthropic API key is saved. Add one under AI connections.');
    return { env: {}, unset, settings: { apiKeyHelper: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'lib/keyhelper.mjs'))} claude` }, how: 'Anthropic API key' };
  }
  if (engine === 'codex' && mode === 'plan') return { env: miuCodex() ? { CODEX_HOME } : {}, unset, args: ['-c', 'forced_login_method="chatgpt"'], how: miuCodex() ? "Miu's ChatGPT sign-in" : 'your own Codex sign-in (~/.codex)' };
  if (engine === 'codex' && mode === 'api') {
    const key = readSecret('codex', 'apiKey');
    if (!key) throw new Error('No OpenAI API key is saved. Add one under AI connections.');
    return { env: { CODEX_API_KEY: key }, unset, args: ['-c', 'forced_login_method="api"'], how: 'OpenAI API key' };
  }
  throw new Error(`${engine} is turned off under AI connections`);
}

export function applyAuth(env, auth) {
  const out = { ...env };
  for (const k of auth.unset ?? []) delete out[k];
  return Object.assign(out, auth.env ?? {});
}

// Every secret Miu knows, longest first, for scrub().
export function secrets() {
  const k = readKeys();
  const list = [k.claude?.apiKey, k.claude?.token, k.codex?.apiKey, k.github?.token, k.github?.user, k.github?.userRefresh, k.github?.pushToken, k.cloudinary?.url, claudeToken()?.token, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY];
  return [...new Set(list.filter((s) => typeof s === 'string' && s.length >= 16))].sort((a, b) => b.length - a.length);
}
export function scrub(text, list = secrets()) {
  let out = String(text ?? '');
  for (const s of list) out = out.split(s).join('[secret removed]');
  return out;
}

const run = (bin, args, opts = {}) => new Promise((resolve) => {
  const child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 20000);
  child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
  child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

function claudeBinary() {
  if (process.env.QA_CLAUDE_BIN) return process.env.QA_CLAUDE_BIN;
  const r = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The account behind a plan sign-in, from the CLIs' own files (shown on this
// machine only).
function claudeAccount() {
  try { const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).oauthAccount; return a?.emailAddress ? `${a.emailAddress}${a.organizationName ? ', ' + a.organizationName : ''}` : null; } catch { return null; }
}
function codexAccount(home) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(home ?? path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8')).tokens?.id_token;
    const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    const plan = c['https://api.openai.com/auth']?.chatgpt_plan_type;
    return c.email ? `${c.email}${plan ? ', ChatGPT ' + plan : ''}` : null;
  } catch { return null; }
}

// What the dashboard shows for each engine. Spawning the CLIs takes a second,
// so the answer is kept for a minute unless asked fresh.
let cache = null;
// What the sign-in is right now: changes when a person signs in again, saves a
// new token or key, or switches mode. A refused sign-in (lib/authrefused.mjs)
// stays refused only while this is the same.
export function signInStamp(engine, mode = DEFAULT_MODES[engine]) {
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return JSON.stringify([engine, mode, last4(readSecret(engine, 'apiKey')), last4(readSecret(engine, 'token')),
    engine === 'codex' ? mtime(path.join(CODEX_HOME, 'auth.json')) : mtime(path.join(os.homedir(), '.claude', '.credentials.json'))]);
}

export async function statusAll(modes, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60000 && JSON.stringify(cache.modes) === JSON.stringify(modes)) return cache.value;
  const value = await Promise.all(['claude', 'codex'].map((e) => status(e, modes[e] ?? DEFAULT_MODES[e])));
  cache = { at: Date.now(), modes, value };
  return value;
}

async function status(engine, mode) {
  const bin = engine === 'claude' ? claudeBinary() : codexBinary();
  const out = { engine, label: engine === 'claude' ? 'Claude' : 'Codex', mode, cli: null, plan: null, api: { saved: last4(readSecret(engine, 'apiKey')) }, storage: storage(), ready: false, problem: null };
  if (engine === 'claude') out.plan = { token: last4(readSecret('claude', 'token')) };
  if (!bin) { out.problem = engine === 'claude' ? 'The claude CLI is not installed.' : 'The Codex CLI was not found (install the ChatGPT extension or set QA_CODEX_BIN).'; return out; }
  const v = await run(bin, ['--version'], { timeout: 10000 });
  out.cli = { version: (v.out || v.err).trim().split('\n')[0] || null };
  if (mode === 'off') return out;
  if (mode === 'api') {
    out.ready = !!out.api.saved;
    if (!out.ready) out.problem = `Add an ${engine === 'claude' ? 'Anthropic' : 'OpenAI'} API key.`;
    return out;
  }
  if (engine === 'claude') {
    const auth = authFor('claude', 'plan');
    const r = await run(bin, ['auth', 'status'], { env: applyAuth(process.env, auth), timeout: 15000 });
    let s = null; try { s = JSON.parse(r.out); } catch { /* old CLI */ }
    out.ready = !!s?.loggedIn;
    out.plan.how = auth.how;
    out.plan.account = out.ready ? claudeAccount() : null;
    if (!out.ready) out.problem = 'Not signed in. Sign in with a Claude account, or paste a token.';
  } else {
    const auth = authFor('codex', 'plan');
    const r = await run(bin, ['login', 'status'], { env: applyAuth(process.env, auth), timeout: 15000 });
    const text = (r.out + r.err).trim();
    out.ready = r.code === 0 && /logged in/i.test(text) && !/api key/i.test(text);
    out.plan = { how: auth.how, own: miuCodex(), account: out.ready ? codexAccount(auth.env.CODEX_HOME) : null };
    if (!out.ready) out.problem = /api key/i.test(text) ? 'Codex is signed in with an API key, not a ChatGPT plan. Sign in with ChatGPT, or switch to API key here.' : 'Not signed in. Sign in with a ChatGPT account.';
  }
  return out;
}

// One tiny request through the engine, the way a run makes it, so "connected"
// means a model really answered.
export async function test(engine, mode) {
  const t0 = Date.now();
  let auth;
  try { auth = authFor(engine, mode); } catch (e) { return { ok: false, error: e.message }; }
  const env = applyAuth(process.env, auth);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-test-'));
  try {
    let r, text;
    if (engine === 'claude') {
      const bin = claudeBinary();
      if (!bin) return { ok: false, error: 'The claude CLI is not installed.' };
      const args = ['-p', 'Reply with the single word OK.', '--model', 'claude-haiku-5-5', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--tools', ''];
      if (auth.settings) args.push('--settings', JSON.stringify(auth.settings));
      r = await run(bin, args, { cwd, env, timeout: 60000 });
      let j = null; try { j = JSON.parse(r.out); } catch { /* not JSON */ }
      if (r.code !== 0 || !j || j.is_error) return { ok: false, error: scrub((j?.result || r.err || r.out || 'No answer').trim().slice(0, 300)) };
      text = j.result;
    } else {
      const bin = codexBinary();
      if (!bin) return { ok: false, error: 'The Codex CLI was not found.' };
      r = await run(bin, ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-6-luna', ...(auth.args ?? []), 'Reply with the single word OK. Do not run any tools.'], { cwd, env, timeout: 90000 });
      const events = r.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      text = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text).join(' ');
      const err = events.find((e) => e.type === 'error' || e.type === 'turn.failed');
      if (!text) return { ok: false, error: scrub((err?.message ?? err?.error?.message ?? r.err ?? 'No answer').trim().slice(0, 300)) };
    }
    return { ok: true, ms: Date.now() - t0, reply: String(text).trim().slice(0, 40), how: auth.how };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

// "Sign in with ChatGPT": `codex login` into Miu's own Codex folder. It
// prints the ChatGPT sign-in page and waits for the browser to come back to a
// local port, so the sign-in finishes by itself. One at a time.
let codexLogin = null;
export function codexSignIn() {
  const bin = codexBinary();
  if (!bin) return Promise.resolve({ error: 'The Codex CLI was not found.' });
  if (codexLogin?.proc.exitCode === null && codexLogin.code) return Promise.resolve({ url: codexLogin.url, code: codexLogin.code });
  fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  // Device code sign-in: the person opens OpenAI's page and types the code.
  // The browser-redirect sign-in returns to port 1455 on the machine running
  // Miu, which a browser elsewhere cannot reach once Miu is on a server.
  const proc = spawn(bin, ['login', '--device-auth'], { env: { ...applyAuth(process.env, { unset: ['OPENAI_API_KEY', 'CODEX_API_KEY'] }), CODEX_HOME, BROWSER: '/usr/bin/true', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  codexLogin = { proc, url: null, code: null };
  proc.on('exit', () => { cache = null; });
  setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 10 * 60 * 1000).unref();
  return new Promise((resolve) => {
    let seen = '';
    const look = (d) => {
      seen += String(d).replace(/\x1b\[[0-9;]*m/g, '');
      const url = seen.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
      const code = seen.match(/one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/)?.[1];
      if (url && code && !codexLogin.code) { codexLogin.url = url; codexLogin.code = code; resolve({ url, code }); }
    };
    proc.stdout.on('data', look); proc.stderr.on('data', look);
    proc.on('exit', () => resolve({ error: 'The Codex sign-in stopped before it gave a code.' }));
    setTimeout(() => resolve({ error: 'The Codex sign-in did not start.' }), 20000);
  });
}
// Back to the personal Codex sign-in; the personal one is not touched.
export async function codexSignOut() {
  const bin = codexBinary();
  if (bin && miuCodex()) await run(bin, ['logout'], { env: { ...process.env, CODEX_HOME }, timeout: 15000 });
  fs.rmSync(path.join(CODEX_HOME, 'auth.json'), { force: true });
  cache = null;
  return { ok: true };
}

// "Sign in with Claude": `claude setup-token` through lib/claude-oauth.py.
// The Claude page shows a code after sign-in; the dashboard sends it to
// claudeCode(), and the year-long token it returns is saved like a pasted one.
let claudeLogin = null;
export function claudeSignIn() {
  const bin = claudeBinary();
  if (!bin) return Promise.resolve({ error: 'The claude CLI is not installed.' });
  claudeLogin?.proc.kill();
  const proc = spawn('python3', [path.join(ROOT, 'lib/claude-oauth.py'), bin], { env: applyAuth(process.env, { unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] }), stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = [];
  claudeLogin = { proc, waiting };
  readline.createInterface({ input: proc.stdout }).on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } waiting.shift()?.(m); });
  proc.on('exit', () => { for (const w of waiting.splice(0)) w({ error: 'The sign-in stopped.' }); if (claudeLogin?.proc === proc) claudeLogin = null; });
  setTimeout(() => proc.kill(), 10 * 60 * 1000).unref();
  return new Promise((resolve) => { waiting.push(resolve); setTimeout(() => resolve({ error: 'The Claude sign-in did not start.' }), 30000); });
}
export function claudeCode(code) {
  if (!claudeLogin) return Promise.resolve({ error: 'Start the sign-in again: press Sign in with Claude.' });
  const { proc, waiting } = claudeLogin;
  return new Promise((resolve) => {
    waiting.push((m) => {
      if (m.token) { try { saveSecret('claude', 'token', m.token); cache = null; resolve({ ok: true }); } catch (e) { resolve({ error: e.message }); } proc.kill(); }
      else resolve({ error: m.error ?? 'No token came back.' });
    });
    proc.stdin.write(JSON.stringify({ code: String(code ?? '').trim() }) + '\n');
    setTimeout(() => resolve({ error: 'Claude did not answer. Start the sign-in again.' }), 60000);
  });
}
