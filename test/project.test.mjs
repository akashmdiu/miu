import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-profiles-'));
process.env.MIU_PROFILES = dir;
const put = (f, d) => fs.writeFileSync(path.join(dir, f), typeof d === 'string' ? d : JSON.stringify(d));
const { profiles, roles, project, profileOf } = await import('../lib/project.mjs');
const { namedIn, roleOf } = await import('../lib/pairs.mjs');

test('with no profiles, Miu still starts: no owner, the default marker', () => {
  assert.deepEqual(profiles(), []);
  assert.equal(project().owner, null);
  assert.equal(project().marker, 'miu');
});

test('roles come from the profiles, and names from the repo when unset', () => {
  put('shop.json', { repo: 'acme/shop', role: 'main', label: 'Free' });
  put('shop-pro.json', { repo: 'acme/shop-pro', role: 'addon', label: 'Pro' });
  put('hub.json', { repo: 'acme/hub', kind: 'hub' });
  put('notes.json', { not: 'a profile' });
  assert.deepEqual(Object.keys(roles()).sort(), ['free', 'hub', 'pro']);
  assert.equal(roles().hub.label, 'hub');
  assert.equal(profileOf('ACME/Shop').slug, 'shop');
  assert.equal(roleOf('acme/shop-pro'), 'pro');
  assert.equal(project().owner, 'acme');
});

test('a PR body names a partner by link, full name or the profile word, never inside a longer name', () => {
  assert.deepEqual(namedIn('Pairs with acme/shop-pro#7 and Pro #9', 'pro').sort(), [7, 9]);
  assert.deepEqual(namedIn('See acme/shop-pro#7', 'free'), []);
  assert.deepEqual(namedIn('https://github.com/acme/hub/pull/3', 'hub'), [3]);
});

test('project.json values that could break a regex or a path are ignored', () => {
  put('project.json', { marker: 'x"><script>', cloudinary_folder: '../up', reset_dirs: ['ok-dir', '../etc'], live_hosts: ['api.acme.com', 5] });
  const p = project();
  assert.equal(p.marker, 'miu');
  assert.equal(p.cloudinary_folder, 'miu');
  assert.deepEqual(p.reset_dirs, ['ok-dir']);
  assert.deepEqual(p.live_hosts, ['api.acme.com']);
});
