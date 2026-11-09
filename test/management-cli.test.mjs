import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('owner bootstrap cannot display a code or create private state in a captured process', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-owner-display-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['bin/miu-manage', 'owner-setup'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: '/tmp' },
  });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'human_terminal_required' });
  assert.deepEqual(fs.readdirSync(home), []);
});

test('credential CLI accepts protected stdin and emits metadata only', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-manage-cli-'));
  fs.chmodSync(home, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, 'management');
  const secret = crypto.randomBytes(32).toString('base64url');
  const call = (args, input = '') => {
    const result = spawnSync(process.execPath, ['bin/miu-manage', ...args], {
      cwd: path.resolve(import.meta.dirname, '..'), input, encoding: 'utf8', timeout: 5000,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: '/tmp' },
    });
    assert.equal((result.stdout + result.stderr).includes(secret), false);
    return result;
  };
  const provision = call(['credential-set', '--directory', directory, '--id', 'sandbox', '--scope', 'health:read', '--stdin'], `${secret}\n`);
  assert.equal(provision.status, 0);
  assert.deepEqual(JSON.parse(provision.stdout), { ok: true, principal: { id: 'sandbox', scopes: ['health:read'], repositories: [] } });
  const rejected = call(['credential-set', '--directory', directory, '--id', 'sandbox', '--scope', 'health:read', '--secret', 'forbidden']);
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stdout).code, 'invalid_arguments');
  const revoked = call(['credential-revoke', '--directory', directory, '--id', 'sandbox']);
  assert.equal(revoked.status, 0);
  assert.deepEqual(JSON.parse(revoked.stdout), { ok: true, revoked: true });
});

test('credential CLI refuses oversized stdin without logging input', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-manage-cli-limit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['bin/miu-manage', 'credential-set', '--directory', path.join(home, 'management'),
    '--id', 'sandbox', '--scope', 'health:read', '--stdin'], {
    cwd: path.resolve(import.meta.dirname, '..'), input: 'x'.repeat(1024), encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: '/tmp' },
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).code, 'invalid_input');
});
