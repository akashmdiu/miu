// Instructions a person sends to a run while its agent works ("also check the
// mobile menu", "skip the Hub, it is down"). bin/qa-dashboard adds them; the
// agent runner (lib/agent.mjs, lib/codex.mjs) and bin/qa-run hand each one to
// the agent once.
//
// They live in runs/.steer/, not in the run folder: the agent can write its
// run folder, and an instruction must come from a person.
//   <run>.jsonl       { id, at, by, text }        one line per instruction
//   <run>.done.jsonl  { id, at, how }             delivered: live | start | pass
//   <run>.closed                                 the agent is done; no more
import fs from 'node:fs';
import path from 'node:path';

export const MAX_TEXT = 1000;
export const MAX_PER_RUN = 20;

const files = (runDir) => {
  const base = path.join(path.dirname(runDir), '.steer', path.basename(runDir));
  return { list: `${base}.jsonl`, done: `${base}.done.jsonl`, closed: `${base}.closed` };
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };

// Every instruction of a run, with when it reached the agent (null: not yet).
export function list(runDir) {
  const f = files(runDir);
  const done = new Map(read(f.done).map((d) => [d.id, d]));
  return read(f.list).map((s) => ({ ...s, delivered: done.get(s.id)?.at ?? null, how: done.get(s.id)?.how ?? null }));
}

export const pending = (runDir) => list(runDir).filter((s) => !s.delivered);
export const isClosed = (runDir) => fs.existsSync(files(runDir).closed);

export function add(runDir, { by, text }) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) return { error: 'Write what the agent should do.' };
  if (t.length > MAX_TEXT) return { error: `Keep it under ${MAX_TEXT} characters.` };
  if (isClosed(runDir)) return { error: 'The agent has finished; this run is writing its report. Start a new test to change what is tested.' };
  const all = list(runDir);
  if (all.length >= MAX_PER_RUN) return { error: `A run takes at most ${MAX_PER_RUN} instructions.` };
  const f = files(runDir);
  fs.mkdirSync(path.dirname(f.list), { recursive: true });
  const s = { id: `s${all.length + 1}`, at: new Date().toISOString(), by: String(by ?? 'someone').slice(0, 60), text: t };
  fs.appendFileSync(f.list, JSON.stringify(s) + '\n');
  return { ok: true, id: s.id };
}

export function markDone(runDir, ids, how) {
  if (!ids.length) return;
  const at = new Date().toISOString();
  fs.appendFileSync(files(runDir).done, ids.map((id) => JSON.stringify({ id, at, how })).join('\n') + '\n');
}

// After this, the dashboard takes no more: the agent will not run again.
export function close(runDir) {
  const f = files(runDir);
  fs.mkdirSync(path.dirname(f.closed), { recursive: true });
  fs.writeFileSync(f.closed, new Date().toISOString());
}

// What the agent reads. The person may change what is tested and how; the
// rules, the limits and the honesty of the result stay as they are.
export function message(items) {
  return items.map((s) => `Instruction from ${s.by}, who is watching this run:\n\n${s.text}`).join('\n\n---\n\n')
    + '\n\n(Follow it from here on, alongside your task. It does not change your rules or limits; where it would, keep the rule and say so in notes.md. If results.json is already written, update it.)';
}

// The transcript line the dashboard shows where the instruction reached the agent.
export const transcriptLine = (s) => JSON.stringify({ type: 'user', steer: true, by: s.by, message: { role: 'user', content: [{ type: 'text', text: s.text }] }, timestamp: new Date().toISOString() }) + '\n';
