import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { withGitHubPolicy } from '../lib/github-policy.mjs';

mock.module('../lib/project.mjs', { exports: { project: () => ({ owner: 'owner' }), profiles: () => [] } });
const { installationToken, withAppToken, APP_FILE } = await import('../lib/ghapp.mjs');

test('App token minting and cache are bound to the exact repository set', async (t) => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = { id: 1, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const originalRead = fs.readFileSync;
  mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (filename === APP_FILE) return JSON.stringify(app);
    return originalRead(filename, ...args);
  });
  const minted = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/app/installations')) return new Response(JSON.stringify([{ id: 2, account: { login: 'owner' } }]));
    assert.equal(url.endsWith('/app/installations/2/access_tokens'), true);
    const body = options.body ? JSON.parse(options.body) : null;
    minted.push(body);
    return new Response(JSON.stringify({ token: crypto.randomBytes(24).toString('hex'), expires_at: new Date(Date.now() + 3600000).toISOString() }));
  });
  t.after(() => mock.restoreAll());
  await installationToken('owner', { repositories: ['first'] });
  assert.deepEqual(minted[0], { repositories: ['first'] });
  await installationToken('owner', { repositories: ['second'] });
  assert.deepEqual(minted[1], { repositories: ['second'] });
  await installationToken('OWNER', { repositories: ['first'] });
  assert.equal(minted.length, 2);
  await installationToken('owner');
  assert.equal(minted.length, 3);
  assert.equal(minted[2], null);
  await assert.rejects(installationToken('owner', { repositories: [] }), { code: 'invalid_repository_scope' });
  await withGitHubPolicy({ mode: 'app-only', repositories: ['owner/first'] }, async () => {
    assert.equal(await withAppToken((asApp) => asApp), true);
    assert.equal(minted.length, 3);
  });
});
