// The instructions every run gives the agent, editable in Settings →
// Instructions. Each one ships in this repo; an edit is saved under
// runs/.instructions/<id>.md, so a deploy of new code does not overwrite it,
// and "Reset to default" removes the edit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const INSTRUCTIONS = [
  { id: 'qa-agent', file: 'prompts/qa-agent.md', title: 'Testing a pull request', help: 'What the agent is told on every run: the phases, its tools and limits, how to judge, and the business rules a PR must fit.' },
  { id: 'methodology', file: 'docs/methodology.md', title: 'QA method', help: 'The team\'s method. The agent reads it first, and the report follows its sections.' },
  { id: 'resolve', file: 'prompts/resolve.md', title: 'Settling open claims', help: 'Sent back to the agent for every claim still not proven after its run, so no claim stays open.' },
  { id: 'steer', file: 'prompts/steer.md', title: 'An instruction during a run', help: 'When someone sends the agent an instruction from a run\'s page that no pass has read yet: follow it, then update the results.' },
  { id: 'finish', file: 'prompts/finish.md', title: 'Out of time', help: 'When a run hits its turn or time limit before writing results: write them from the evidence so far.' },
  { id: 'fix-agent', file: 'prompts/fix-agent.md', title: 'Fixing a pull request', help: 'What the fix agent is told when it fixes what a test found, before Miu commits the change to the pull request\'s branch.' },
  { id: 'results-example', file: 'prompts/results-example.md', title: 'Results format', help: 'The shape of results.json the agent writes. The report and the verdict are built from it, so change it with care.' },
];

const byId = new Map(INSTRUCTIONS.map((i) => [i.id, i]));
const editFile = (runsDir, id) => path.join(runsDir, '.instructions', `${id}.md`);

export function readInstruction(id, runsDir) {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown instruction ${id}`);
  try { const t = fs.readFileSync(editFile(runsDir, id), 'utf8'); if (t.trim()) return t; } catch { /* not edited */ }
  return fs.readFileSync(path.join(ROOT, def.file), 'utf8');
}

export function listInstructions(runsDir) {
  return INSTRUCTIONS.map((i) => ({ id: i.id, title: i.title, help: i.help, text: readInstruction(i.id, runsDir), edited: fs.existsSync(editFile(runsDir, i.id)) }));
}

export function saveInstruction(runsDir, { id, text, reset }) {
  if (!byId.has(id)) throw new Error('Unknown instruction');
  const f = editFile(runsDir, id);
  if (reset) { fs.rmSync(f, { force: true }); return listInstructions(runsDir); }
  if (typeof text !== 'string' || !text.trim()) throw new Error('The instructions cannot be empty. Use Reset to go back to the default.');
  if (text.length > 60000) throw new Error('Keep it under 60,000 characters; every run sends it to the agent.');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text.replace(/\r\n/g, '\n'), { mode: 0o640 });
  return listInstructions(runsDir);
}
