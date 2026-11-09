// A repository's GitHub Actions workflow as a fast check, run by the Sandbox
// CLI on the server Miu runs on (`sb ci run --local`). Miu's account has no
// Docker access, so it sends the commit to bin/miu-sandbox-ci, which runs as the
// account that owns Sandbox.
//
// The caller gets one of two answers. { status, out } means the workflow ran:
// status 0 passed, 1 failed. { notRun } means the server could not run it, and
// says why, so that a broken server is never reported as a broken pull request.
import { spawn } from 'node:child_process';

const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;
const JOB = /^\w[\w-]*$/;
const EVENT = /^[a-z_]{1,64}$/;
const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 240;
// bin/miu-sandbox-ci stops Sandbox a minute after the limit; this is for when it cannot.
const GRACE_MS = 2 * 60 * 1000;
// A worker in another account may not stop when asked. Miu moves on regardless.
const STOP_WAIT_MS = 30 * 1000;

// What is wrong with a fast check's sandbox_ci block; null when nothing is.
export function sandboxCiProblem(check) {
  if (check.sandbox_ci === undefined) return null;
  const ci = check.sandbox_ci;
  const name = check.label ?? 'a fast check';
  if (!ci || typeof ci !== 'object' || Array.isArray(ci)) return `The "sandbox_ci" of ${name} must be an object.`;
  if (check.cmd !== undefined) return `${name} has both "cmd" and "sandbox_ci". Keep one.`;
  if (typeof ci.workflow !== 'string' || !WORKFLOW.test(ci.workflow)) return `The "sandbox_ci.workflow" of ${name} must be a file directly in .github/workflows, like .github/workflows/test.yml.`;
  if (ci.jobs !== undefined && (!Array.isArray(ci.jobs) || !ci.jobs.every((j) => typeof j === 'string' && JOB.test(j)))) return `The "sandbox_ci.jobs" of ${name} must be a list of job ids.`;
  if (ci.event !== undefined && (typeof ci.event !== 'string' || !EVENT.test(ci.event))) return `The "sandbox_ci.event" of ${name} must be a GitHub event name.`;
  if (ci.timeout_minutes !== undefined && !(Number.isInteger(ci.timeout_minutes) && ci.timeout_minutes >= 1 && ci.timeout_minutes <= MAX_MINUTES)) return `The "sandbox_ci.timeout_minutes" of ${name} must be a whole number from 1 to ${MAX_MINUTES}.`;
  return null;
}

// A pull request must not choose what runs on the server, or which of the
// server's CI secrets a workflow reads. act takes options from .actrc.
export const changesCiDefinition = (files) => files.some((f) => f.startsWith('.github/') || f === '.actrc');

const secondsOf = (ci) => (ci.timeout_minutes ?? DEFAULT_MINUTES) * 60;
const workerArgs = (ci) => [ci.workflow, ci.event ?? 'pull_request', String(secondsOf(ci)), ...(ci.jobs ?? [])];
const SEND_COMMIT = 'git -C "$1" archive --format=tar HEAD | sudo -n -H -u "$2" "$3" "${@:4}"';

const lastLine = (text) => text.trim().split('\n').pop()?.trim().slice(0, 300) ?? '';

function reportIn(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* an unrelated line */ }
  }
  return null;
}

// act exits non-zero for a job that failed and also when Docker, the runner
// image or an action was not there. Only the first ends with this line.
const ranAndFailed = (cell) => cell.status === 'failed' && Number.isInteger(cell.exit_code) && cell.exit_code !== 0 && /Job failed/.test(cell.output ?? '');
const passed = (cell) => cell.status === 'passed';

function resultOf({ stdout, stderr }) {
  const report = reportIn(stdout);
  if (!report) return { notRun: lastLine(stderr) || 'the Sandbox CLI gave no result' };
  if (report.code === 'ci_preflight_blocked') {
    const ids = (report.preflight?.blocking ?? []).map((b) => b.id).join(', ');
    return { notRun: `Sandbox refused this workflow${ids ? `: ${ids}` : ''}` };
  }
  const cells = report.cells ?? [];
  if (!cells.length) return { notRun: 'the workflow has no jobs to run' };
  const failed = cells.filter(ranAndFailed);
  if (failed.length) {
    const out = failed.map((c) => [`## ${c.label}${c.matrix ? ` ${JSON.stringify(c.matrix)}` : ''} (exit ${c.exit_code})`, c.output ?? ''].join('\n')).join('\n\n');
    return { status: 1, out };
  }
  const stuck = cells.find((c) => !passed(c));
  if (stuck) return { notRun: `${stuck.label}: ${lastLine(String(stuck.error ?? (stuck.output || stuck.status)))}` };
  return { status: 0, out: `${cells.length} of ${cells.length} passed` };
}

export function runSandboxCi(check, dir, env = process.env, { limitMs, stopWaitMs = STOP_WAIT_MS } = {}) {
  const problem = sandboxCiProblem(check);
  if (problem) return Promise.resolve({ notRun: problem });
  const user = env.MIU_SANDBOX_USER;
  const worker = env.MIU_SANDBOX_WORKER;
  if (!user || !worker) return Promise.resolve({ notRun: 'Sandbox CI is not set up on this server; run install.sh with --sandbox-user' });
  const limit = limitMs ?? secondsOf(check.sandbox_ci) * 1000 + GRACE_MS;
  return new Promise((resolve) => {
    // Its own process group, so that stopping it also stops what it started.
    const child = spawn('bash', ['-c', SEND_COMMIT, 'miu-sandbox-ci', dir, user, worker, ...workerArgs(check.sandbox_ci)], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let giveUp;
    const TOO_LONG = { notRun: 'Sandbox CI passed its time limit and was stopped' };
    const finish = (result) => { clearTimeout(timer); clearTimeout(giveUp); resolve(result); };
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      giveUp = setTimeout(() => { child.unref(); child.stdout.destroy(); child.stderr.destroy(); finish(TOO_LONG); }, stopWaitMs);
    }, limit);
    child.on('close', () => finish(timedOut ? TOO_LONG : resultOf({ stdout, stderr })));
    child.on('error', (e) => finish({ notRun: `could not start Sandbox CI: ${e.message}` }));
  });
}
