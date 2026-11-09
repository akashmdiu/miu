import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CredentialStore } from '../lib/management-auth.mjs';
import { RequestStore } from '../lib/management-store.mjs';

test('actual dashboard enforces separate service auth and browser sign-in even on loopback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-dashboard-contract-'));
  const home = path.join(root, 'home'), runs = path.join(root, 'runs'), directory = path.join(root, 'management');
  const profiles = path.join(root, 'profiles');
  for (const item of [home, runs, profiles]) fs.mkdirSync(item, { mode: 0o700 });
  fs.writeFileSync(path.join(runs, '.config.json'), JSON.stringify({ autoTest: false,
    connections: { claude: 'off', codex: 'off' }, fix: { enabled: false } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profiles, 'fixture.json'), JSON.stringify({ repo: 'owner/repo' }), { mode: 0o600 });
  const secret = crypto.randomBytes(32).toString('base64url');
  await new CredentialStore({ directory }).provision({ id: 'fixture', secret, scopes: ['health:read'] });
  await new CredentialStore({ directory }).provision({ id: 'runner', secret,
    scopes: ['runs:submit', 'runs:trusted', 'runs:read'], repositories: ['owner/repo'] });
  const seeded = new RequestStore({ directory });
  seeded.reserve({ principalId: '_dashboard', requestId: 'fixture-held', runName: 'fixture-held', intent: { repo: 'owner/repo' } });
  seeded.finish('_dashboard', 'fixture-held', { state: 'failed', exitCode: 1, processStopped: true, cleanupComplete: true });
  seeded.close();
  const child = spawn(process.execPath, ['bin/qa-dashboard', '--host', '127.0.0.1', '--port', '0',
    '--runs', runs, '--management', '--management-dir', directory], {
    cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: '/tmp', MIU_PROFILES: profiles },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      let timer;
      try {
        const result = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
        if (!result) { child.kill('SIGKILL'); await closed; }
      } finally { clearTimeout(timer); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  child.stderr.on('data', (chunk) => { assert.equal(chunk.toString().includes(secret), false); });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('dashboard did not start')), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('dashboard closed before readiness')); });
    child.stdout.on('data', (chunk) => {
      assert.equal(chunk.toString().includes(secret), false);
      output = (output + chunk.toString()).slice(-8192);
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match && Number(match[1]) > 0) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const call = (target, headers = {}) => fetch(`http://127.0.0.1:${port}${target}`,
    { headers, signal: AbortSignal.timeout(3000) });
  assert.equal((await call('/management/v1/health')).status, 401);
  const headers = { Authorization: `Bearer fixture.${secret}` };
  const health = await call('/management/v1/health', headers);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.apiVersion, 1);
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal((await call('/management/v1/health', { ...headers, Cookie: 'session=fixture' })).status, 403);
  const browser = await call('/');
  assert.equal(browser.status, 200);
  assert.equal((await browser.text()).includes('Create the owner account'), true);
  const disabled = await fetch(`http://127.0.0.1:${port}/management/v1/requests`, {
    method: 'POST', signal: AbortSignal.timeout(3000), headers: { Authorization: `Bearer runner.${secret}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'disabled-engine' },
    body: JSON.stringify({ repo: 'owner/repo', pr: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      model: 'gpt-6.1-sol', trust: 'trusted' }),
  });
  assert.equal(disabled.status, 400);
  const requests = await call('/management/v1/requests', { Authorization: `Bearer runner.${secret}` });
  assert.deepEqual((await requests.json()).requests, []);
  for (const action of ['fix', 'model', 'review', 'post']) {
    const controlled = await fetch(`http://127.0.0.1:${port}/api/runs/fixture-held/${action}`, {
      method: 'POST', headers: { 'X-QA-Dashboard': '1', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
    });
    assert.equal(controlled.status, 401);
  }
});
