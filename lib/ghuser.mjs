// The collaborator: a person whose own GitHub sign-in Miu posts its PR
// comments with, through the Miu App. GitHub then shows each comment as that
// person's, with the App's badge on the avatar. Labels and commit statuses
// stay with the App itself (lib/publish.mjs).
//
// Sign-in is GitHub's device flow (no client secret): Miu shows a code, the
// person enters it at github.com/login/device. The App needs "Enable Device
// Flow" on, and with "User-to-server token expiration" opted out the token does
// not expire. The token is kept sealed with the other keys (lib/connections.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecret, saveSecret } from './connections.mjs';

const APP_FILE = process.env.MIU_APP_FILE ?? path.join(os.homedir(), '.config/miu/github-app.json');
const clientId = () => { try { return JSON.parse(fs.readFileSync(APP_FILE, 'utf8')).client_id; } catch { return null; } };

async function form(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) });
  return res.json();
}

// The connected person, or null.
export function collaborator() {
  const token = readSecret('github', 'user');
  const login = readSecret('github', 'userLogin');
  return token && login ? { token, login } : null;
}

let pending = null; // { code, uri, expires, error, login }
export const loginState = () => {
  const c = collaborator();
  const push = readSecret('github', 'pushToken');
  return { login: c?.login ?? null, pushToken: push ? { last4: push.slice(-4) } : null, pending: pending && !pending.done ? { code: pending.code, uri: pending.uri, expires: pending.expires } : null, error: pending?.error ?? null };
};

export async function startLogin() {
  const id = clientId();
  if (!id) throw new Error('The Miu App is not set up on this machine.');
  if (pending && !pending.done && Date.now() < pending.expires) return loginState();
  const d = await form('https://github.com/login/device/code', { client_id: id });
  if (d.error) throw new Error(d.error === 'device_flow_disabled' ? 'Turn on "Enable Device Flow" in the Miu App settings on GitHub first.' : d.error_description || d.error);
  pending = { code: d.user_code, uri: d.verification_uri, expires: Date.now() + d.expires_in * 1000, done: false, error: null };
  const mine = pending;
  let wait = (d.interval || 5) * 1000;
  (async () => {
    while (!mine.done && Date.now() < mine.expires) {
      await new Promise((r) => setTimeout(r, wait));
      let t; try { t = await form('https://github.com/login/oauth/access_token', { client_id: id, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); } catch { continue; }
      if (t.error === 'authorization_pending') continue;
      if (t.error === 'slow_down') { wait += 5000; continue; }
      if (t.error) { mine.error = t.error === 'access_denied' ? 'The sign-in was cancelled on GitHub.' : t.error_description || t.error; mine.done = true; return; }
      try {
        const me = await (await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'miu' } })).json();
        saveSecret('github', 'user', t.access_token);
        saveSecret('github', 'userLogin', me.login);
        if (t.refresh_token) saveSecret('github', 'userRefresh', t.refresh_token);
        mine.login = me.login;
        // An expiring token (8 hours) cannot be renewed without the App's client secret.
        if (t.expires_in) mine.error = 'Connected, but this token expires in 8 hours: opt out of "User-to-server token expiration" in the Miu App settings and connect again.';
      } catch (e) { mine.error = e.message; }
      mine.done = true;
      return;
    }
    if (!mine.done) { mine.error = 'The code expired. Connect again.'; mine.done = true; }
  })();
  return loginState();
}

// The collaborator's own personal token, for pushing fixes. A sign-in through
// the App can do only what the App may, and an App that may only read code
// cannot push; a person's own token has no App in between. It must be the
// connected person's, and able to push to the repos Miu tests.
export async function savePushToken(token, repos) {
  const c = collaborator();
  if (!c) throw new Error('Connect your GitHub account first; the token must be the same person\'s.');
  const t = String(token ?? '').trim();
  if (!t) { saveSecret('github', 'pushToken', ''); return loginState(); }
  const get = async (p) => { const r = await fetch(`https://api.github.com/${p}`, { headers: { Authorization: `Bearer ${t}`, 'User-Agent': 'miu', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const me = await get('user');
  if (me.status !== 200) throw new Error('GitHub did not accept that token.');
  if (String(me.body.login).toLowerCase() !== c.login.toLowerCase()) throw new Error(`That token is ${me.body.login}'s; it has to be ${c.login}'s, the connected account.`);
  const cannot = [];
  for (const r of repos) {
    const x = await get(`repos/${r}`);
    if (x.status !== 200 || !x.body.permissions?.push) cannot.push(r.split('/')[1]);
  }
  if (cannot.length === repos.length) throw new Error(`That token cannot push to ${cannot.join(', ')}. A classic token needs the repo scope; a fine-grained one needs Contents: Read and write on these repos (and the org may have to approve it).`);
  saveSecret('github', 'pushToken', t);
  return { ...loginState(), ...(cannot.length ? { warning: `Saved. It cannot push to ${cannot.join(', ')}.` } : {}) };
}

export function disconnect() {
  for (const k of ['user', 'userLogin', 'userRefresh', 'pushToken']) saveSecret('github', k, '');
  pending = null;
  return loginState();
}
