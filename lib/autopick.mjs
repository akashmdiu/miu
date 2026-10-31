// "Auto" model and effort: picked per pull request from its triage (depth and
// the areas it touches), within the engine that is connected. A small or
// docs-only PR gets the fast model and low effort; a large or risky one the
// strongest model and high effort. The passes after the main one (settling
// open claims, writing results when time ran out) are narrow, so they run one
// effort level lower.
const MODEL = {
  claude: { quick: 'claude-sonnet-5-5', standard: 'claude-opus-5-5', deep: 'claude-opus-5-5' },
  codex: { quick: 'gpt-6.1-sol', standard: 'gpt-6.1-sol', deep: 'gpt-6-astra' },
};
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Areas where a miss is costly: a security hole, data loss, a licence leak.
const RISKY = ['security', 'db', 'licence', 'license', 'cache_engine'];

export function autoPick({ engine, depth, areas = {} }) {
  const d = MODEL[engine] && MODEL[engine][depth] ? depth : 'standard';
  const risky = RISKY.filter((a) => areas[a]);
  const model = MODEL[engine]?.[d] ?? MODEL.codex[d];
  const effort = d === 'quick' ? 'low' : d === 'standard' ? (risky.length ? 'high' : 'medium') : (risky.includes('security') ? 'xhigh' : 'high');
  const why = `${d} pull request${risky.length ? ` touching ${risky.join(', ')}` : ''}`;
  return { model, effort, why };
}

// One level lower, never below low: for the resolve and out-of-time passes.
export const lowerEffort = (effort) => (effort && LEVELS.includes(effort) ? LEVELS[Math.max(0, LEVELS.indexOf(effort) - 1)] : effort);
