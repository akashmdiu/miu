import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home of its own: the sign-in files live under it.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-auth-'));
const { refusalIn, recordRefusal, refusal } = await import('../lib/authrefused.mjs');
const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-runs-'));
const run = (name, lines) => { const d = path.join(runs, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'agent-codex.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return d; };

test('a sign-in the service refused is found in the CLI errors', () => {
  const d = run('refused', [{ type: 'thread.started' }, { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery unauthorized (401))' }, { type: 'turn.failed', error: { message: 'workspace routing discovery unauthorized (401)' } }]);
  assert.match(refusalIn(d), /unauthorized \(401\)/);
});

test('a 401 from the site under test is not a refused sign-in', () => {
  const d = run('tested', [{ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'HTTP/1.1 401 Unauthorized from /wp-json/shop/v1/settings' } }, { type: 'turn.completed' }]);
  assert.equal(refusalIn(d), null);
});

test('the queue stays held until the sign-in changes', () => {
  recordRefusal(runs, 'codex', 'plan', 'unauthorized (401)');
  assert.ok(refusal(runs, 'codex', 'plan'));
  assert.equal(refusal(runs, 'claude', 'plan'), null);
  fs.mkdirSync(path.join(process.env.HOME, '.config/miu/codex'), { recursive: true });
  fs.writeFileSync(path.join(process.env.HOME, '.config/miu/codex/auth.json'), '{}');
  assert.equal(refusal(runs, 'codex', 'plan'), null);
  assert.ok(!fs.existsSync(path.join(runs, '.auth-refused.json')));
});
