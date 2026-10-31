import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home of its own, so the tests never touch the real accounts.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-users-'));
delete process.env.MIU_USERS_FILE;
const users = await import('../lib/users.mjs');
const pw = 'correct horse battery';

test('the owner needs the setup code, and only one owner is made that way', () => {
  assert.equal(users.hasUsers(), false);
  const code = users.setupCode();
  assert.ok(code);
  assert.throws(() => users.createOwner({ code: 'wrong', email: 'a@b.co', password: pw }), /setup code/);
  assert.throws(() => users.createOwner({ code, email: 'a@b.co', password: 'short' }), /10 characters/);
  const owner = users.createOwner({ code, name: 'Akash', email: 'A@B.co', password: pw });
  assert.equal(owner.role, 'owner');
  assert.equal(owner.email, 'a@b.co');
  assert.equal(owner.pw, undefined);
  assert.equal(users.setupCode(), null);
  assert.throws(() => users.createOwner({ code, email: 'c@d.co', password: pw }), /owner already/);
  const file = fs.readFileSync(path.join(process.env.HOME, '.config/miu/users.json'), 'utf8');
  assert.ok(!file.includes(pw));
  assert.equal(fs.statSync(path.join(process.env.HOME, '.config/miu/users.json')).mode & 0o777, 0o600);
});

test('password sign-in checks the password and slows down guessing', () => {
  assert.equal(users.signInPassword('a@b.co', pw, '1.1.1.1').role, 'owner');
  for (let i = 0; i < 5; i++) assert.throws(() => users.signInPassword('a@b.co', 'nope nope nope', '2.2.2.2'), /do not match/);
  assert.throws(() => users.signInPassword('a@b.co', pw, '3.3.3.3'), /Too many tries/);
  assert.throws(() => users.signInPassword('nobody@b.co', pw, '4.4.4.4'), /do not match/);
});

test('an invite works once, for the email or GitHub account it names', () => {
  const owner = users.list().users[0];
  assert.throws(() => users.invite({ email: 'm@b.co', role: 'owner' }, owner), /admin, member or viewer/);
  const t = users.invite({ email: 'm@b.co', role: 'member' }, owner);
  assert.equal(users.inviteFor(t).role, 'member');
  assert.equal(users.list().invites.length, 1);
  const m = users.acceptInvite(t, { name: 'Mim', password: pw });
  assert.equal(m.role, 'member');
  assert.throws(() => users.acceptInvite(t, { password: pw }), /expired or was already used/);
  assert.throws(() => users.invite({ email: 'm@b.co', role: 'viewer' }, owner), /member already/);

  const g = users.invite({ github: '@octo-cat', role: 'viewer' }, owner);
  assert.throws(() => users.acceptInvite(g, { githubLogin: 'someone' }), /octo-cat/);
  assert.equal(users.acceptInvite(g, { githubLogin: 'Octo-Cat' }).github, 'Octo-Cat');
  assert.equal(users.signInGithub('octo-cat').role, 'viewer');

  const r = users.invite({ email: 'r@b.co', role: 'viewer' }, owner);
  users.revokeInvite(users.list().invites[0].id);
  assert.equal(users.inviteFor(r), null);
});

test('roles: there is always an owner, and only an owner changes owners', () => {
  const all = () => users.list().users;
  const owner = all().find((u) => u.role === 'owner');
  const member = all().find((u) => u.email === 'm@b.co');
  assert.throws(() => users.setRole(owner.id, 'admin', owner), /at least one owner/);
  assert.throws(() => users.remove(owner.id, owner), /at least one owner/);
  users.setRole(member.id, 'admin', owner);
  const admin = all().find((u) => u.id === member.id);
  assert.throws(() => users.setRole(admin.id, 'owner', admin), /Only an owner/);
  assert.throws(() => users.remove(owner.id, admin), /Only an owner/);
  const viewer = all().find((u) => u.role === 'viewer');
  assert.throws(() => users.setRole(admin.id, 'member', viewer), /Only an admin/);
  users.setRole(admin.id, 'owner', owner);
  users.setRole(owner.id, 'member', owner);
  assert.equal(all().filter((u) => u.role === 'owner').length, 1);
  users.remove(viewer.id, admin);
  assert.equal(users.signInGithub('octo-cat'), null);
});

test('changing a password needs the current one', () => {
  const me = users.list().users.find((u) => u.email === 'a@b.co');
  assert.throws(() => users.changePassword(me.id, 'wrong password', 'a new password 1'), /not right/);
  users.changePassword(me.id, pw, 'a new password 1');
  // The old one no longer works and the new one does (sign-in for this email is still locked from the test above).
  assert.throws(() => users.changePassword(me.id, pw, 'another password'), /not right/);
  users.changePassword(me.id, 'a new password 1', pw);
});
