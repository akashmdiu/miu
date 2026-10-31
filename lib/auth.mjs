// Sign-in for the dashboard: when it is required, sessions, and "Sign in with
// GitHub" through this Miu's own GitHub App. Who may come in, and with which
// role, is lib/users.mjs.
//
// - OAuth with state and PKCE. The user's GitHub token is used once, to learn
//   who they are, and is not kept.
// - Sessions: a random 32-byte id in an HttpOnly, SameSite=Lax cookie (Secure
//   on https); the server stores only its SHA-256, with the login and an
//   expiry, in runs/.sessions.json (mode 600). 12 hours.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as users from './users.mjs';
import { readApp, APP_FILE } from './ghapp.mjs';

const SESSION_HOURS = 12;
const COOKIE = 'miu_session';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');

export function authConfig({ port, host }) {
  const app = readApp();
  const publicUrl = (process.env.MIU_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const clientSecret = process.env.MIU_GH_CLIENT_SECRET || app?.client_secret || null;
  return {
    publicUrl,
    secure: publicUrl.startsWith('https://'),
    // Sign-in is on once this Miu has an account (lib/users.mjs), and always
    // off the local machine. Before the first account it serves the set-up page.
    required: users.hasUsers() || process.env.MIU_AUTH === 'github' || !loopback,
    ready: !!(app?.client_id && clientSecret),
    clientId: app?.client_id ?? null,
    clientSecret,
  };
}

// The client secret is created in the App's settings and pasted once.
export function saveClientSecret(secret) {
  if (!/^[0-9a-f]{40}$/i.test(secret)) throw new Error('That does not look like a GitHub App client secret (40 hex characters).');
  const app = readApp();
  if (!app) throw new Error('Create the App first.');
  fs.writeFileSync(APP_FILE, JSON.stringify({ ...app, client_secret: secret }, null, 2), { mode: 0o600 });
}

// ---- sessions
export function sessionStore(runsDir) {
  const file = path.join(runsDir, '.sessions.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 }); } catch { /* runs dir missing */ } };
  const prune = () => { const now = Date.now(); for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k]; };
  return {
    create(user) {
      prune();
      const id = b64url(crypto.randomBytes(32));
      all[sha(id)] = { ...user, exp: Date.now() + SESSION_HOURS * 3600 * 1000 };
      save();
      return id;
    },
    get(id) {
      if (!id || id.length > 100) return null;
      const s = all[sha(id)];
      if (!s || s.exp < Date.now()) return null;
      return s;
    },
    drop(id) { if (id) { delete all[sha(id)]; save(); } },
  };
}

export const readCookie = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1] ?? null;
export const sessionCookie = (id, cfg) => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${cfg.secure ? '; Secure' : ''}`;
export const clearCookie = (cfg) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.secure ? '; Secure' : ''}`;

// ---- OAuth with state + PKCE
const pending = new Map(); // state -> { verifier, at, next }
export function loginRedirect(cfg, next = '/', invite = null) {
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { verifier, at: Date.now(), next: next.startsWith('/') && !next.startsWith('//') ? next : '/', invite });
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: `${cfg.publicUrl}/auth/callback`, state, allow_signup: 'false',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  return `https://github.com/login/oauth/authorize?${q}`;
}

export async function finishLogin(cfg, url, repos) {
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  const p = state && pending.get(state);
  if (!p || !code) throw new Error('This sign-in link is not valid or has expired. Start again.');
  pending.delete(state);
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'miu' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: `${cfg.publicUrl}/auth/callback`, code_verifier: p.verifier }),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error(`GitHub did not sign you in (${tok.error_description || tok.error || 'no token'}).`);
  const me = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'miu' } }).then((r) => r.json());
  if (!me?.login) throw new Error('GitHub did not say who you are.');
  // Who may come in is decided by this Miu's members (lib/users.mjs), by the caller.
  return { github: { login: me.login, name: me.name || me.login, avatar: me.avatar_url }, next: p.next, invite: p.invite };
}

