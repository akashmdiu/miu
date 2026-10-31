import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as steer from '../lib/steer.mjs';

const runDir = () => { const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-steer-')); const d = path.join(runs, 'shop-1-run'); fs.mkdirSync(d); return d; };

test('an instruction is kept outside the run folder the agent writes', () => {
  const d = runDir();
  assert.deepEqual(steer.add(d, { by: 'akash', text: '  Also check the mobile menu  ' }), { ok: true, id: 's1' });
  assert.deepEqual(fs.readdirSync(d), []);
  assert.deepEqual(steer.pending(d).map((s) => [s.id, s.by, s.text]), [['s1', 'akash', 'Also check the mobile menu']]);
  steer.markDone(d, ['s1'], 'live');
  assert.equal(steer.pending(d).length, 0);
  assert.equal(steer.list(d)[0].how, 'live');
});

test('an empty, long or late instruction is refused', () => {
  const d = runDir();
  assert.match(steer.add(d, { by: 'a', text: '   ' }).error, /Write what/);
  assert.match(steer.add(d, { by: 'a', text: 'x'.repeat(steer.MAX_TEXT + 1) }).error, /under 1000/);
  for (let i = 0; i < steer.MAX_PER_RUN; i++) steer.add(d, { by: 'a', text: `n${i}` });
  assert.match(steer.add(d, { by: 'a', text: 'one more' }).error, /at most/);
  const e = runDir();
  steer.close(e);
  assert.match(steer.add(e, { by: 'a', text: 'too late' }).error, /finished/);
});

test('the agent is told who asked, and that its rules stay', () => {
  const m = steer.message([{ by: 'akash', text: 'Skip the Hub, it is down' }]);
  assert.match(m, /^Instruction from akash, who is watching this run:\n\nSkip the Hub/);
  assert.match(m, /does not change your rules or limits/);
});

// A stand-in for the Agent SDK: reads the input stream the way the CLI does
// and answers each prompt with one turn, so delivery can be checked without a sign-in.
test('a running Claude agent gets the instruction at its next step, and one sent as it finishes starts another turn', async () => {
  const seen = [];
  mock.module('@anthropic-ai/claude-agent-sdk', {
    exports: {
      query: ({ prompt }) => {
        const it = prompt[Symbol.asyncIterator]();
        async function* out() {
          let n = 0;
          for (;;) {
            const { value, done } = await it.next();
            if (done) return;
            seen.push(value);
            n++;
            if (n === 1) {
              yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
              // The person writes while the agent works.
              steer.add(d, { by: 'akash', text: 'Also check the mobile menu' });
              await new Promise((r) => setTimeout(r, 2300));
              continue;
            }
            yield { type: 'result', subtype: 'success', n };
            // ...and again just as it finishes.
            if (n === 2) steer.add(d, { by: 'akash', text: 'And the footer' });
          }
        }
        const g = out();
        return Object.assign(g, { setModel: async () => {}, interrupt: async () => {} });
      },
    },
  });
  const d = runDir();
  const { runAgent } = await import('../lib/agent.mjs');
  const r = await runAgent({ prompt: 'Test the PR', runDir: d, model: 'claude-sonnet-5-5', env: {}, maxTurns: 5, timeoutMin: 1, log: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((m) => m.priority ?? null), [null, 'next', 'next']);
  assert.match(seen[1].message.content, /Also check the mobile menu/);
  assert.match(seen[2].message.content, /And the footer/);
  assert.equal(steer.pending(d).length, 0);
  const shown = fs.readFileSync(path.join(d, 'agent-transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.steer);
  assert.deepEqual(shown.map((e) => e.message.content[0].text), ['Also check the mobile menu', 'And the footer']);
});
