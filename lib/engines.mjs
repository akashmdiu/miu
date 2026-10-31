// The models a run can use, and the engine (the local CLI) that runs each.
// Every engine runs on the subscription its CLI is signed in with on this box,
// never an API key:
//   claude  the Claude Code CLI, through the Agent SDK (lib/agent.mjs)
//   codex   the Codex CLI, `codex exec` (lib/codex.mjs)
// Adding an engine means a runner next to those two and its models here.
export const MODELS = [
  { id: 'claude-opus-5-5', engine: 'claude', label: 'Opus 5.5', note: 'Recommended. Finds the most.' },
  { id: 'claude-opus-5', engine: 'claude', label: 'Opus 5', note: 'Previous Opus.' },
  { id: 'claude-sonnet-5-5', engine: 'claude', label: 'Sonnet 5.5', note: 'Faster, uses less of the plan.' },
  { id: 'claude-haiku-5-5', engine: 'claude', label: 'Haiku 5.5', note: 'Fastest. Misses more.' },
  { id: 'gpt-6-astra', engine: 'codex', label: 'GPT-6 Astra', note: 'Codex. OpenAI\'s strongest model.' },
  { id: 'gpt-6.1-sol', engine: 'codex', label: 'GPT-6.1 Sol', note: 'Codex. Everyday model, faster.' },
  { id: 'gpt-6-luna', engine: 'codex', label: 'GPT-6 Luna', note: 'Codex. Fastest. Misses more.' },
];

// turns: the share of the depth's turn budget a run gets. Codex takes one
// small step per tool call where Claude does several in a turn (a Pro run
// spent 112 of its 150 steps on single wp commands in under nine minutes), so
// it gets twice the steps; the time limit is the same for both.
export const ENGINES = {
  claude: { label: 'Claude', switchable: true, turns: 1 },
  // codex exec cannot change the model of a session that is running.
  codex: { label: 'Codex', switchable: false, turns: 2 },
};

// How hard the model thinks on each step. Both engines take the same levels
// (Claude's effort, Codex's model_reasoning_effort). More effort finds more and
// costs more time and plan usage. "default" leaves each engine's own default:
// Claude decides per model, Codex runs at medium.
export const EFFORTS = [
  { id: 'auto', label: 'Auto' },
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

// The engine of a model id; ids not in the list go by their prefix, so a run
// asked for with --model gpt-… still reaches Codex.
export function engineOf(model) {
  const known = MODELS.find((m) => m.id === model);
  if (known) return known.engine;
  return /^(gpt-|o\d|codex)/.test(String(model)) ? 'codex' : 'claude';
}
