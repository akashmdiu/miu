import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MIU_AGENT_USER = 'synthetic-agent';
let fallbackStatus = 1;
mock.module('node:child_process', { exports: { spawnSync: () => ({ status: fallbackStatus }) } });
const { rmAny } = await import('../lib/agentuser.mjs');

test('cleanup refuses a failed agent fallback or a remaining target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-cleanup-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'owned');
  fs.mkdirSync(target);
  const remove = mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' }); });
  try {
    fallbackStatus = 1;
    assert.throws(() => rmAny(target), /cleanup_failed/);
    fallbackStatus = 0;
    assert.throws(() => rmAny(target), /cleanup_failed/);
    fs.rmdirSync(target);
    fs.symlinkSync(path.join(root, 'missing'), target);
    assert.throws(() => rmAny(target), /cleanup_failed/);
    fs.unlinkSync(target);
    assert.doesNotThrow(() => rmAny(target));
  } finally { remove.mock.restore(); }
});
