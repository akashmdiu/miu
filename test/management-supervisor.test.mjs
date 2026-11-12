import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('public QA help and missing arguments require no engine or private state', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-supervisor-help-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const call = (args) => spawnSync(process.execPath, ['bin/qa-run', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000,
    env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: '/tmp' },
  });
  const help = call(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /qa-run --repo/);
  const missing = call([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--repo/);
  assert.deepEqual(fs.readdirSync(home), []);
});
