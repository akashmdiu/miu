// Accounts for a self-hosted Miu: who may sign in and what each may do.
//
// Roles, highest first:
//   owner   everything, including who is owner
//   admin   settings, AI connections, instructions, rules and members
//   member  starts and stops tests, posts reports, reviews findings
//   viewer  reads reports
// Sign-in is an email and password (always there), or GitHub through the
// installation's own GitHub App when it is set up. A new install has no
// accounts: the first one, the owner, is made with a one-time setup code the
// server prints to its log, so whoever reaches the page first cannot take it.
// Others join by an invite link, by email or by GitHub username.
//
// Stored in ~/.config/miu/users.json (mode 600): passwords only as scrypt
// hashes, invite links only as their SHA-256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), '.config', 'miu');
const FILE = process.env.MIU_USERS_FILE ?? path.join(DIR, 'users.json');
const SETUP_FILE = path.join(DIR, 'setup-code');
export const ROLES = ['owner', 'admin', 'member', 'viewer'];
const RANK = { owner: 4, admin: 3, member: 2, viewer: 1 };
export const atLeast = (role, need) => (RANK[role] ?? 0) >= (RANK[need] ?? 99);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64url = (b) => Buffer.from(b).toString('base64url');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { users: d.users ?? [], invites: d.invites ?? [] }; } catch { return { users: [], invites: [] }; }
}
function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// ---- passwords: scrypt, compared in constant time
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw).normalize('NFKC'), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), n: SCRYPT.N };
}
function checkPassword(pw, rec) {
  if (!rec?.salt) return false;
  const want = Buffer.from(rec.hash, 'base64');
  const got = crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(rec.salt, 'base64'), want.length, { ...SCRYPT, N: rec.n ?? SCRYPT.N });
  return crypto.timingSafeEqual(want, got);
}
function strongEnough(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('Use a password of at least 10 characters.');
  if (pw.length > 200) throw new Error('That password is too long.');
}

// What the page may see of a user: never the password hash. The picture is
// the GitHub one, else the Gravatar for the email (d=404: none, and the page
// shows initials).
const picture = (u) => (u.github ? `https://github.com/${u.github}.png?size=64` : u.email ? `https://gravatar.com/avatar/${sha(u.email.trim().toLowerCase())}?s=80&d=404` : null);
const pub = (u) => ({ id: u.id, name: u.name, email: u.email ?? null, github: u.github ?? null, role: u.role, created: u.created, lastSeen: u.lastSeen ?? null, avatar: picture(u) });

export const hasUsers = () => load().users.length > 0;
export const get = (id) => { const u = load().users.find((x) => x.id === id); return u ? pub(u) : null; };
export const list = () => { const d = load(); return { users: d.users.map(pub), invites: d.invites.filter((i) => i.exp > Date.now()).map(({ tokenHash, ...i }) => ({ ...i, id: tokenHash.slice(0, 12) })) }; };

// ---- the one-time setup code for the first account
export function setupCode() {
  if (hasUsers()) { fs.rmSync(SETUP_FILE, { force: true }); return null; }
  try { const c = fs.readFileSync(SETUP_FILE, 'utf8').trim(); if (c) return c; } catch { /* make one */ }
  const c = b64url(crypto.randomBytes(9));
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETUP_FILE, c, { mode: 0o600 });
  return c;
}

export function createOwner({ code, name, email, password }) {
  if (hasUsers()) throw new Error('This Miu has an owner already.');
  const want = setupCode();
  if (!want || !code || !crypto.timingSafeEqual(Buffer.from(sha(String(code).trim())), Buffer.from(sha(want)))) throw new Error('That setup code is not right. It is in the server log, and in ~/.config/miu/setup-code.');
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error('Enter an email address.');
  strongEnough(password);
  const user = { id: b64url(crypto.randomBytes(9)), name: String(name || '').trim().slice(0, 80) || email, email, role: 'owner', pw: hashPassword(password), created: new Date().toISOString() };
  save({ users: [user], invites: [] });
  fs.rmSync(SETUP_FILE, { force: true });
  return pub(user);
}

// ---- sign-in: a few wrong tries, then a short wait (per email and per address)
const tries = new Map();
function throttle(key) {
  const t = tries.get(key);
  if (t && t.until > Date.now()) throw new Error('Too many tries. Wait a few minutes and try again.');
}
function failed(key) {
  const t = tries.get(key) ?? { n: 0, until: 0 };
  t.n += 1;
  if (t.n >= 5) { t.until = Date.now() + 5 * 60 * 1000; t.n = 0; }
  tries.set(key, t);
}

export function signInPassword(email, password, ip = '') {
  email = String(email || '').trim().toLowerCase();
  throttle(email); throttle(ip);
  const d = load();
  const u = d.users.find((x) => x.email === email);
  // The same work and the same answer whether or not the account exists.
  const ok = checkPassword(password, u?.pw ?? { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', hash: 'A'.repeat(43) + '=' });
  if (!u || !ok) { failed(email); failed(ip); throw new Error('That email and password do not match an account here.'); }
  tries.delete(email);
  return pub(u);
}

export function signInGithub(login) {
  const d = load();
  const u = d.users.find((x) => x.github && x.github.toLowerCase() === String(login).toLowerCase());
  return u ? pub(u) : null;
}

export function touch(id) {
  const d = load();
  const u = d.users.find((x) => x.id === id);
  if (!u) return;
  const now = Date.now();
  if (u.lastSeen && now - Date.parse(u.lastSeen) < 5 * 60 * 1000) return;
  u.lastSeen = new Date(now).toISOString();
  save(d);
}

// ---- invites: a link with a random token; only its hash is kept
export function invite({ email, github, role }, by) {
  if (!ROLES.includes(role) || role === 'owner') throw new Error('Invite as admin, member or viewer.');
  if (role === 'admin' && !atLeast(by.role, 'admin')) throw new Error('Only an admin can invite an admin.');
  email = String(email || '').trim().toLowerCase();
  github = String(github || '').trim().replace(/^@/, '');
  if (!email && !github) throw new Error('Give an email address or a GitHub username.');
  if (email && !EMAIL.test(email)) throw new Error('That email address does not look right.');
  if (github && !LOGIN.test(github)) throw new Error('That is not a GitHub username.');
  const d = load();
  if (d.users.some((u) => (email && u.email === email) || (github && u.github?.toLowerCase() === github.toLowerCase()))) throw new Error('That person is a member already.');
  const token = b64url(crypto.randomBytes(24));
  d.invites = d.invites.filter((i) => i.exp > Date.now() && !((email && i.email === email) || (github && i.github?.toLowerCase() === github.toLowerCase())));
  d.invites.push({ tokenHash: sha(token), email: email || null, github: github || null, role, by: by.name, created: new Date().toISOString(), exp: Date.now() + 7 * 86400 * 1000 });
  save(d);
  return token;
}

export function inviteFor(token) {
  const i = load().invites.find((x) => x.tokenHash === sha(token) && x.exp > Date.now());
  return i ? { email: i.email, github: i.github, role: i.role, by: i.by } : null;
}

// Joins with a password (an email invite) or with the GitHub account the
// invite names (a GitHub invite, after GitHub sign-in).
export function acceptInvite(token, { name, password, githubLogin }) {
  const d = load();
  const i = d.invites.find((x) => x.tokenHash === sha(token) && x.exp > Date.now());
  if (!i) throw new Error('This invite has expired or was already used. Ask for a new one.');
  const user = { id: b64url(crypto.randomBytes(9)), name: String(name || '').trim().slice(0, 80) || i.email || githubLogin, role: i.role, created: new Date().toISOString() };
  if (i.github) {
    if (!githubLogin || githubLogin.toLowerCase() !== i.github.toLowerCase()) throw new Error(`This invite is for the GitHub account ${i.github}. Sign in to GitHub as ${i.github}.`);
    user.github = githubLogin;
  }
  if (i.email) {
    strongEnough(password);
    user.email = i.email;
    user.pw = hashPassword(password);
  }
  d.users.push(user);
  d.invites = d.invites.filter((x) => x !== i);
  save(d);
  return pub(user);
}

export function revokeInvite(id) {
  const d = load();
  d.invites = d.invites.filter((i) => i.tokenHash.slice(0, 12) !== id);
  save(d);
}

// ---- changes to members
const owners = (d) => d.users.filter((u) => u.role === 'owner');
export function setRole(id, role, by) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  const d = load();
  const u = d.users.find((x) => x.id === id);
  if (!u) throw new Error('No such member.');
  if ((role === 'owner' || u.role === 'owner') && by.role !== 'owner') throw new Error('Only an owner can make or change an owner.');
  if (u.role === 'owner' && role !== 'owner' && owners(d).length === 1) throw new Error('This Miu needs at least one owner. Make someone else owner first.');
  if (!atLeast(by.role, 'admin')) throw new Error('Only an admin can change roles.');
  u.role = role;
  save(d);
  return list();
}

export function remove(id, by) {
  const d = load();
  const u = d.users.find((x) => x.id === id);
  if (!u) throw new Error('No such member.');
  if (u.role === 'owner' && by.role !== 'owner') throw new Error('Only an owner can remove an owner.');
  if (u.role === 'owner' && owners(d).length === 1) throw new Error('This Miu needs at least one owner.');
  d.users = d.users.filter((x) => x !== u);
  save(d);
  return list();
}

export function changePassword(id, current, next) {
  const d = load();
  const u = d.users.find((x) => x.id === id);
  if (!u) throw new Error('No such account.');
  if (!u.email) throw new Error('This account signs in with GitHub and has no password.');
  if (u.pw && !checkPassword(current, u.pw)) throw new Error('The current password is not right.');
  strongEnough(next);
  u.pw = hashPassword(next);
  save(d);
}
