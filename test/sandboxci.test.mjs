import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxCi, sandboxCiProblem, changesCiDefinition } from '../lib/sandboxci.mjs';

const WORKER = fileURLToPath(new URL('../bin/miu-sandbox-ci', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miu-sandboxci-'));
const check = { label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml' } };
const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

// A pull request's checkout: one commit, plus a file that was never committed.
function repo(extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const files = { '.github/workflows/test.yml': 'on: push\n', 'code.php': '<?php\n', ...extra };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'not in the commit');
  return dir;
}

// `sudo` is the only stand-in on the way: it records how it was called and
// runs the worker, the same as the rule install.sh writes.
function server({ worker, home }) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  script(path.join(bin, 'sudo'), `printf '%s\\n' "$@" > "${bin}/sudo-argv"\nshift 4\nexec "$@"`);
  script(path.join(bin, 'timeout'), 'shift 3\nexec "$@"');
  script(path.join(bin, 'docker'), 'exit 0');
  return {
    env: { ...process.env, HOME: home ?? tmp, PATH: `${bin}:${process.env.PATH}`, MIU_SANDBOX_USER: 'ubuntu', MIU_SANDBOX_WORKER: worker ?? WORKER },
    sudoArgv: () => fs.readFileSync(path.join(bin, 'sudo-argv'), 'utf8').trim().split('\n'),
  };
}

// A stand-in worker: takes the tar, prints what the test asks for.
function fakeWorker({ stdout = '', stderr = '', exit = 0, sleep = 0 }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'worker-'));
  fs.writeFileSync(path.join(dir, 'stdout'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr'), stderr);
  const worker = path.join(dir, 'worker');
  script(worker, `cat > /dev/null\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat "${dir}/stdout"\ncat "${dir}/stderr" >&2\nsleep ${sleep}\nexit ${exit}`);
  return { ...server({ worker }), worker, argv: () => fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n'), ran: () => fs.existsSync(path.join(dir, 'argv')) };
}

// The real worker, with a stand-in `sb` that keeps what it was given.
function sandboxHome({ stdout = '{"ok":true,"cells":[{"label":"a","status":"passed","exit_code":0}]}' } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const sb = path.join(home, 'sandbox/sb-src/sb');
  fs.mkdirSync(path.dirname(sb), { recursive: true });
  script(sb, `printf '%s\\n' "$@" > "${home}/argv"\nproject="$6"\nfind "$project" -path "$project/.git" -prune -o -type f -print | sed "s#^$project/##" | sort > "${home}/files"\ngit -C "$project" rev-parse --is-inside-work-tree > "${home}/git"\ncat "$XDG_CONFIG_HOME/act/actrc" > "${home}/actrc"\necho '${stdout}'`);
  return { home, read: (f) => fs.readFileSync(path.join(home, f), 'utf8').trim() };
}

const report = (cells) => JSON.stringify({ ok: cells.every((c) => c.status === 'passed'), cells }) + '\n';

test('goes through the one sudo rule, as the configured account', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0 }]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', jobs: ['php', 'js'], runtime: 'sandbox', event: 'push', timeout_minutes: 5 } }, repo(), s.env);
  assert.equal(r.status, 0);
  assert.deepEqual(s.sudoArgv().slice(0, 4), ['-n', '-H', '-u', 'ubuntu']);
  assert.equal(s.sudoArgv()[4], s.worker);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'push', '300', 'sandbox', 'php', 'js']);
});

test('defaults: every job, a pull request, no site, 30 minutes', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0 }]) });
  await runSandboxCi(check, repo(), s.env);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'pull_request', '1800', 'none']);
});

test('the worker runs the commit on this server and never asks for deploy steps', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', jobs: ['php'] } }, repo(), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
  const argv = sandbox.read('argv').split('\n');
  assert.deepEqual(argv.slice(0, 2), ['ci', 'run']);
  assert.match(argv[2], /\/\.github\/workflows\/test\.yml$/);
  assert.ok(argv.includes('--local'));
  assert.ok(!argv.includes('--remote'));
  assert.ok(!argv.includes('--allow-deploy'));
  assert.equal(argv[argv.indexOf('--job') + 1], 'php');
  assert.equal(argv[argv.indexOf('--runtime') + 1], 'none');
  assert.equal(sandbox.read('files'), '.github/workflows/test.yml\ncode.php');
  assert.equal(sandbox.read('git'), 'true');
});

test('jobs do not get the Docker socket, and a committed .actrc is ignored', async () => {
  const sandbox = sandboxHome();
  await runSandboxCi(check, repo({ '.actrc': '--privileged\n' }), server({ home: sandbox.home }).env);
  assert.equal(sandbox.read('actrc'), '--container-daemon-socket=-');
  assert.doesNotMatch(sandbox.read('files'), /actrc/);
});

test('a site needs the repository to declare one', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', runtime: 'sandbox' } }, repo(), server({ home: sandbox.home }).env);
  assert.match(r.notRun, /sandbox\.config\.json/);
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('the worker refuses arguments Miu would never send', () => {
  const sandbox = sandboxHome();
  for (const args of [['../../etc/passwd', 'push', '60', 'none'], ['.github/workflows/a.yml', 'push;id', '60', 'none'], ['.github/workflows/a.yml', 'push', 'x', 'none'], ['.github/workflows/a.yml', 'push', '60', 'host'], ['.github/workflows/a.yml', 'push', '60', 'none', '--allow-deploy']]) {
    const r = spawnSync(WORKER, args, { input: '', env: { ...process.env, HOME: sandbox.home } });
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('a job that fails is a failure, with the output of what failed', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'good', status: 'passed', exit_code: 0, output: 'all fine' },
    { label: 'bad', matrix: { php: '8.1' }, status: 'failed', exit_code: 1, output: 'PHPUnit: 2 failures' },
  ]) });
  const r = await runSandboxCi(check, repo(), s.env);
  assert.equal(r.status, 1);
  assert.equal(r.notRun, undefined);
  assert.match(r.out, /PHPUnit: 2 failures/);
  assert.doesNotMatch(r.out, /all fine/);
});

test('a real failure is reported even when another cell could not start', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'bad', status: 'failed', exit_code: 2, output: 'assertion' },
    { label: 'down', status: 'provision_failed', error: 'no port' },
  ]) });
  assert.equal((await runSandboxCi(check, repo(), s.env)).status, 1);
});

// A broken server must never read as a broken pull request.
for (const [name, sb, expected] of [
  ['a cell that could not start', { exit: 1, stdout: report([{ label: 'a', status: 'provision_failed', error: 'no port left' }]) }, /no port left/],
  ['a cell that timed out', { exit: 1, stdout: report([{ label: 'a', status: 'failed', error: 'timed out after 900s' }]) }, /timed out/],
  ['a run with no cells', { stdout: report([]) }, /no jobs/i],
  ['a CLI that dies before running anything', { exit: 1, stderr: 'act not found\n' }, /act not found/],
  ['output that is not a report', { exit: 1, stdout: 'Traceback\n' }, /no result/i],
  ['a workflow the runner refuses', { exit: 1, stdout: JSON.stringify({ ok: false, code: 'ci_preflight_blocked', preflight: { blocking: [{ id: 'artifact-paths' }] } }) + '\n' }, /artifact-paths/],
]) {
  test(`not run, not failed: ${name}`, async () => {
    const r = await runSandboxCi(check, repo(), fakeWorker(sb).env);
    assert.match(r.notRun, expected);
    assert.equal(r.status, undefined);
  });
}

test('finds the report after anything else the CLI prints', async () => {
  const s = fakeWorker({ stdout: `notice: running locally\n${report([{ label: 'a', status: 'passed', exit_code: 0 }])}` });
  assert.equal((await runSandboxCi(check, repo(), s.env)).status, 0);
});

test('not set up: nothing runs, and the report says how to fix it', async () => {
  const r = await runSandboxCi(check, repo(), { PATH: process.env.PATH });
  assert.match(r.notRun, /--sandbox-user/);
});

test('without the Sandbox CLI on the server: not run, and says where it looked', async () => {
  const home = fs.mkdtempSync(path.join(tmp, 'empty-'));
  const r = await runSandboxCi(check, repo(), server({ home }).env);
  assert.match(r.notRun, /no Sandbox CLI at/);
});

test('stops a run that passes its time limit', async () => {
  const s = fakeWorker({ sleep: 30 });
  const r = await runSandboxCi(check, repo(), s.env, { limitMs: 200 });
  assert.match(r.notRun, /time limit/);
});

test('an invalid check is refused before anything runs', async () => {
  const s = fakeWorker({ stdout: report([]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '../../etc/passwd' } }, repo(), s.env);
  assert.match(r.notRun, /workflow/);
  assert.equal(s.ran(), false);
});

test('profile validation names what is wrong', () => {
  assert.equal(sandboxCiProblem({ label: 'tests', cmd: 'composer test' }), null);
  assert.equal(sandboxCiProblem(check), null);
  assert.equal(sandboxCiProblem({ sandbox_ci: { workflow: '.github/workflows/a.yaml', jobs: ['php-8'], event: 'push', runtime: 'sandbox', timeout_minutes: 45 } }), null);
  for (const [bad, field] of [
    [{ sandbox_ci: 'ci.yml' }, 'object'],
    [{ cmd: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml' } }, 'cmd'],
    [{ sandbox_ci: { workflow: 'ci.yml' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/../../a.yml' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', jobs: 'php' } }, 'jobs'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', jobs: ['--allow-deploy'] } }, 'jobs'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', event: 'Push!' } }, 'event'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', runtime: 'docker' } }, 'runtime'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', timeout_minutes: 0 } }, 'timeout_minutes'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', timeout_minutes: 241 } }, 'timeout_minutes'],
  ]) assert.match(sandboxCiProblem(bad), new RegExp(field), JSON.stringify(bad));
});

test('a pull request cannot choose what the server runs', () => {
  assert.equal(changesCiDefinition(['src/a.php', '.github/workflows/test.yml']), true);
  assert.equal(changesCiDefinition(['.github/actions/setup/action.yml']), true);
  assert.equal(changesCiDefinition(['.actrc']), true);
  assert.equal(changesCiDefinition(['sandbox.config.json']), true);
  assert.equal(changesCiDefinition(['sandbox.config.php81.json']), true);
  assert.equal(changesCiDefinition(['src/a.php', 'docs/.github-notes.md', 'sub/sandbox.config.json']), false);
});
