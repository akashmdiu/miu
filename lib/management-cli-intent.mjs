const VALUES = new Set(['--repo', '--pr', '--model', '--auth', '--labels', '--effort', '--note',
  '--max-turns', '--timeout-min', '--credit', '--run-dir', '--request-id', '--management-dir']);
const SWITCHES = new Set(['--dry-run', '--publish', '--full', '--force', '--test-conflicts',
  '--keep-env', '--keep-src', '--skip-agent', '--plan', '--slack']);
const INTERNAL = new Set(['--run-dir', '--request-id', '--management-dir']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** Option values stay data even when a note happens to resemble a flag. */
export function parseQaArguments(args) {
  const values = new Map(), flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (VALUES.has(name)) {
      const value = args[++index];
      if (!values.has(name)) values.set(name, value);
    } else flags.add(name);
  }
  return { option: (name, fallback) => values.has(name) ? values.get(name) : fallback,
    flag: (name) => flags.has(name), has: (name) => flags.has(name) || values.has(name) };
}

/** Bind control flags and execution policy before any managed admission. */
export function prepareCliArguments(args, { repo, pr, model, authMode }) {
  if (!['plan', 'api'].includes(authMode)) fail('engine_unavailable');
  if (!Array.isArray(args) || args.length > 200 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) fail('invalid_arguments');
  const argv = [], seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag) || (!VALUES.has(flag) && !SWITCHES.has(flag))) fail('invalid_arguments');
    seen.add(flag);
    if (VALUES.has(flag)) {
      const value = args[++index];
      if (value === undefined) fail('invalid_arguments');
      if (flag === '--auth' && value !== authMode) fail('engine_unavailable');
      if (!INTERNAL.has(flag)) argv.push(flag, value);
    } else if (flag !== '--publish') argv.push(flag);
  }
  if (seen.has('--publish') && seen.has('--dry-run')) fail('invalid_arguments');
  const mode = seen.has('--publish') ? 'publish' : 'report-only';
  if (!seen.has('--repo')) argv.push('--repo', repo);
  if (!seen.has('--pr')) argv.push('--pr', String(pr));
  if (!seen.has('--model')) argv.push('--model', model);
  if (!seen.has('--auth')) argv.push('--auth', authMode);
  if (mode === 'report-only' && !seen.has('--dry-run')) argv.push('--dry-run');
  if (Buffer.byteLength(JSON.stringify(argv)) > 15000) fail('invalid_arguments');
  return { argv, mode, authMode };
}
