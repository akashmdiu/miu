// Miu's own GitHub identity: a GitHub App, so comments, labels and statuses
// show as "Miu [bot]" instead of the person whose gh login runs the harness.
//
// The App is made once from the dashboard (/github-app) with GitHub's manifest
// flow; its id and private key are kept outside the repo, in
// ~/.config/miu/github-app.json (mode 600). An installation token lasts an
// hour, so it is minted before each write phase. Until the App is installed on
// the owner of the profiles' repos, Miu falls back to the local gh login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { project, profiles } from './project.mjs';

export const APP_FILE = process.env.MIU_APP_FILE ?? path.join(os.homedir(), '.config', 'miu', 'github-app.json');
// The account the App is installed on: the owner of the repos Miu tests, or,
// before any repo has a profile, the account the App was first installed on.
export const owner = () => project().owner ?? readApp()?.account ?? null;
const repoNames = () => profiles().filter((p) => p.repo.split('/')[0].toLowerCase() === String(owner()).toLowerCase()).map((p) => p.repo.split('/')[1]);

// What the App may do: write comments, labels and statuses, read code. It
// cannot push, merge or approve.
export function manifest(redirectUrl) {
  return {
    // App names are unique on GitHub, so each Miu's carries its owner.
    name: `Miu ${owner() ?? ''}`.trim().slice(0, 34),
    url: 'https://github.com/akashmdiu/miu',
    description: 'Tests pull requests in a real environment: reproduces each claim on the base branch, checks it on the pull request, and reports with evidence.',
    redirect_url: redirectUrl,
    public: true, // only a public App can be installed on an org it does not belong to
    default_permissions: { issues: 'write', pull_requests: 'write', statuses: 'write', contents: 'read', metadata: 'read' },
    default_events: [],
    hook_attributes: { url: 'https://example.invalid/miu-no-webhook', active: false },
  };
}

export function readApp() {
  try { return JSON.parse(fs.readFileSync(APP_FILE, 'utf8')); } catch { return null; }
}

// GitHub hands the App's credentials back once, for the code in the redirect.
export async function convertManifest(code) {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miu' } });
  if (!res.ok) throw new Error(`GitHub refused the App code: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const a = await res.json();
  const keep = { id: a.id, slug: a.slug, name: a.name, owner: a.owner?.login, html_url: a.html_url, client_id: a.client_id, pem: a.pem, created_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(APP_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(APP_FILE, JSON.stringify(keep, null, 2), { mode: 0o600 });
  return keep;
}

const b64url = (b) => Buffer.from(b).toString('base64url');
function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(app.id) }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), app.pem).toString('base64url');
  return `${head}.${body}.${sig}`;
}

async function api(pathname, { method = 'GET', token, jwt } = {}) {
  const res = await fetch(`https://api.github.com${pathname}`, { method, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miu', Authorization: jwt ? `Bearer ${jwt}` : `token ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${pathname}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

// Where the App stands: not made, made but not installed on the org, or ready.
export async function appStatus() {
  const app = readApp();
  if (!app) return { state: 'none' };
  const base = { slug: app.slug, name: app.name, owner: app.owner, settingsUrl: `https://github.com/settings/apps/${app.slug}`, installUrl: `https://github.com/apps/${app.slug}/installations/new` };
  try {
    const installs = await api('/app/installations', { jwt: appJwt(app) });
    if (!owner() && installs[0]?.account?.login) {
      fs.writeFileSync(APP_FILE, JSON.stringify({ ...app, account: installs[0].account.login }, null, 2), { mode: 0o600 });
    }
    const org = installs.find((i) => i.account?.login?.toLowerCase() === String(owner()).toLowerCase());
    if (!org) return { ...base, state: 'not_installed' };
    const tok = await api(`/app/installations/${org.id}/access_tokens`, { method: 'POST', jwt: appJwt(app) });
    const repos = (await api('/installation/repositories?per_page=100', { token: tok.token })).repositories.map((r) => r.name);
    const missing = repoNames().filter((r) => !repos.includes(r));
    return { ...base, state: missing.length ? 'partial' : 'ready', installationId: org.id, repos, missing };
  } catch (e) {
    return { ...base, state: 'error', error: e.message };
  }
}

// Installation tokens, one per owner (org), cached until 15 minutes before
// they expire. null when the App is not set up or not installed there.
const tokens = new Map();
export async function installationToken(owner) {
  const app = readApp();
  if (!app || !owner) return null;
  const hit = tokens.get(owner.toLowerCase());
  if (hit && Date.parse(hit.expires_at) - Date.now() > 15 * 60 * 1000) return hit.token;
  const installs = await api('/app/installations', { jwt: appJwt(app) });
  const inst = installs.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
  if (!inst) return null;
  const t = await api(`/app/installations/${inst.id}/access_tokens`, { method: 'POST', jwt: appJwt(app) });
  tokens.set(owner.toLowerCase(), t);
  return t.token;
}

// Runs fn with whether GitHub writes go out as the App. The GitHub client
// picks the App token on its own; nothing here changes the environment.
export async function withAppToken(fn, log = () => {}) {
  const asApp = !!(await installationToken(owner()).catch(() => null));
  if (!asApp && readApp()) log(`github: the App is not installed on ${owner()} yet, writing with the fallback token`);
  return fn(asApp);
}
