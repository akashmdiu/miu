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
const check = { label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'a' } };
// The worker's workflow policy needs PyYAML, which the installer adds on a server.
const hasYaml = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const needsYaml = { skip: hasYaml ? false : 'needs python3 with PyYAML' };
const OK = 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n';
const script = (file, body) => fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const git = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

// A pull request's checkout: one commit, plus a file that was never committed.
function repo(extra = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'repo-'));
  const files = { '.github/workflows/test.yml': OK, 'code.php': '<?php\n', ...extra };
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
function server({ worker, home, docker = 'exit 0' }) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  script(path.join(bin, 'sudo'), `printf '%s\\n' "$@" > "${bin}/sudo-argv"\nshift 4\nexec "$@"`);
  script(path.join(bin, 'timeout'), 'shift 3\nexec "$@"');
  script(path.join(bin, 'docker'), docker);
  if (!hasYaml) script(path.join(bin, 'python3'), 'exit 0');
  return {
    env: { ...process.env, HOME: home ?? tmp, PATH: `${bin}:${process.env.PATH}`, MIU_SANDBOX_USER: 'ubuntu', MIU_SANDBOX_WORKER: worker ?? WORKER },
    sudoArgv: () => fs.readFileSync(path.join(bin, 'sudo-argv'), 'utf8').trim().split('\n'),
  };
}

// A stand-in worker: takes the tar, prints what the test asks for.
function fakeWorker({ stdout = '', stderr = '', exit = 0, sleep = 0, ignoreTerm = false }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'worker-'));
  fs.writeFileSync(path.join(dir, 'stdout'), stdout);
  fs.writeFileSync(path.join(dir, 'stderr'), stderr);
  const worker = path.join(dir, 'worker');
  script(worker, `${ignoreTerm ? "trap '' TERM\n" : ''}cat > /dev/null\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat "${dir}/stdout"\ncat "${dir}/stderr" >&2\nsleep ${sleep}\nexit ${exit}`);
  return { ...server({ worker }), worker, argv: () => fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n'), ran: () => fs.existsSync(path.join(dir, 'argv')) };
}

// The real worker, with a stand-in `sb` that keeps what it was given.
function sandboxHome({ stdout = '{"ok":true,"cells":[{"label":"a","status":"passed","exit_code":0,"output":"[t/a]   🏁  Job succeeded"}]}', plan = '{"jobs":[{"id":"a","cells":[{"matrix":{}}]}]}' } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const sb = path.join(home, 'sandbox/sb-src/sb');
  fs.mkdirSync(path.dirname(sb), { recursive: true });
  script(sb, `if [ "$2" = plan ]; then echo '${plan}'; exit 0; fi\nprintf '%s\\n' "$@" > "${home}/argv"\nproject="$6"\necho "$project" > "${home}/project"\nfind "$project" -path "$project/.git" -prune -o -type f -print | sed "s#^$project/##" | sort > "${home}/files"\ngit -C "$project" rev-parse --is-inside-work-tree > "${home}/git"\ncat "$XDG_CONFIG_HOME/act/actrc" > "${home}/actrc"\necho '${stdout}'`);
  return { home, read: (f) => fs.readFileSync(path.join(home, f), 'utf8').trim() };
}

const report = (cells) => JSON.stringify({ ok: cells.every((c) => c.status === 'passed'), cells }) + '\n';

test('goes through the one sudo rule, as the configured account', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'php', matrix: { php: 8.3, db: 'mysql' }, event: 'push', timeout_minutes: 5 } }, repo(), s.env);
  assert.equal(r.status, 0);
  assert.deepEqual(s.sudoArgv().slice(0, 4), ['-n', '-H', '-u', 'ubuntu']);
  assert.equal(s.sudoArgv()[4], s.worker);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'push', '300', 'php', 'php=8.3', 'db=mysql']);
});

test('defaults: a pull request, 30 minutes', async () => {
  const s = fakeWorker({ stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }]) });
  await runSandboxCi(check, repo(), s.env);
  assert.deepEqual(s.argv(), ['.github/workflows/test.yml', 'pull_request', '1800', 'a']);
});

test('the worker runs the commit on this server and never asks for deploy steps', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo(), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
  const argv = sandbox.read('argv').split('\n');
  assert.deepEqual(argv.slice(0, 2), ['ci', 'run']);
  assert.match(argv[2], /\/\.github\/workflows\/test\.yml$/);
  assert.ok(argv.includes('--local'));
  assert.ok(!argv.includes('--remote'));
  assert.ok(!argv.includes('--allow-deploy'));
  assert.equal(argv[argv.indexOf('--job') + 1], 'a');
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

test('files the tar brings cannot run or read anything on the server', async () => {
  const sandbox = sandboxHome();
  const dir = repo();
  fs.symlinkSync('/etc/hosts', path.join(dir, '.env'));
  fs.writeFileSync(path.join(dir, '.vars'), 'PLAIN=1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'links');
  await runSandboxCi(check, dir, server({ home: sandbox.home }).env);
  const files = sandbox.read('files').split('\n');
  assert.ok(!files.includes('.env'));
  assert.ok(files.includes('.vars'));
});

test('a .git in the tar is thrown away, hooks and all', () => {
  const sandbox = sandboxHome();
  const src = fs.mkdtempSync(path.join(tmp, 'evil-'));
  const marker = path.join(sandbox.home, 'hook-ran');
  fs.mkdirSync(path.join(src, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(src, '.github/workflows/test.yml'), OK);
  fs.mkdirSync(path.join(src, '.git/hooks'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git/hooks/post-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const tar = spawnSync('tar', ['-c', '-C', src, '.']);
  const { env } = server({ home: sandbox.home });
  const r = spawnSync(WORKER, ['.github/workflows/test.yml', 'push', '60', 'a'], { input: tar.stdout, env });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(sandbox.read('git'), 'true');
});

test('removes the containers of its own run, and no others', async () => {
  const sandbox = sandboxHome();
  const log = path.join(sandbox.home, 'docker-log');
  const docker = `case "$1" in
ps) echo mine; echo other ;;
inspect) if [ "$4" = mine ]; then cat "${sandbox.home}/project"; else echo /somewhere/else; fi ;;
rm) echo "$3" >> "${log}" ;;
esac`;
  await runSandboxCi(check, repo(), server({ home: sandbox.home, docker }).env);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'mine');
});

test('the worker never asks Sandbox for a site', async () => {
  const sandbox = sandboxHome();
  await runSandboxCi(check, repo({ 'sandbox.config.json': '{}' }), server({ home: sandbox.home }).env);
  const argv = sandbox.read('argv').split('\n');
  assert.equal(argv[argv.indexOf('--runtime') + 1], 'none');
});

const refusals = [
  ['a job container that mounts the server', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: x\n      volumes: ["/:/host"]\n    steps: [{ run: id }]\n', /volumes/],
  ['a privileged service', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: x\n        options: --health-interval=1s --privileged\n    steps: [{ run: id }]\n', /--privileged/],
  ['options built from an expression', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      image: x\n      options: ${{ matrix.o }}\n    steps: [{ run: id }]\n', /plain text/],
  ['a workflow from another repository', 'jobs:\n  a:\n    uses: evil/repo/.github/workflows/x.yml@main\n', /calls another workflow/],
  ['a local workflow outside .github', 'jobs:\n  a:\n    uses: ./payload.yml\n', /calls another workflow/],
  ['options that hide flags behind escaped lines', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      db:\n        image: x\n        options: |\n          \\\n          --privileged\n    steps: [{ run: id }]\n', /plain text/],
  ['keys hidden behind a YAML alias', 'x: &m\n  image: x\n  volumes: ["/:/host"]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container: *m\n    steps: [{ run: id }]\n', /volumes/],
  ['a matrix name that is a number', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        1: [x, y]\n        include:\n          - { "1": "None" }\n    steps: [{ run: id }]\n', /not text/],
  ['a number hidden in a matrix include', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include:\n          - { 1: x }\n    steps: [{ run: id }]\n', /not text/],
  ['a label that hides a forged result line', 'jobs:\n  a:\n    runs-on: "x\\n[f] 🏁 Job succeeded\\ny"\n    steps: [{ run: id }]\n', /must run on/],
  ['a label from the matrix', 'jobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    steps: [{ run: id }]\n', /must run on/],
  ['a needed job on a label with no runner', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: b\n    steps: [{ run: id }]\n  b:\n    runs-on: windows-latest\n    steps: [{ run: id }]\n', /job b must run on/],
  ['a skipped job whose prerequisite ran', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n    needs: b\n    if: false\n    steps: [{ run: id }]\n  b:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n', /condition/],
  ['YAML that cannot be read', 'jobs: [\n', /YAML/],
];
for (const [name, workflow, why] of refusals) {
  test(`the worker refuses ${name}`, needsYaml, async () => {
    const sandbox = sandboxHome();
    const r = await runSandboxCi(check, repo({ '.github/workflows/test.yml': workflow }), server({ home: sandbox.home }).env);
    assert.match(r.notRun, why);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
  });
}

test('other files in .github/workflows do not matter', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo({ '.github/workflows/other.yml': 'on: push\n' }), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
});

test('a check that would start more than one act is refused', needsYaml, async () => {
  const plan = '{"jobs":[{"id":"a","cells":[{"matrix":{"php":"8.1"}},{"matrix":{"php":"8.3"}}]}]}';
  const sandbox = sandboxHome({ plan });
  const r = await runSandboxCi(check, repo(), server({ home: sandbox.home }).env);
  assert.match(r.notRun, /2 matching runs/);
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('matrix values pick out the one to run', needsYaml, async () => {
  const plan = '{"jobs":[{"id":"a","cells":[{"matrix":{"php":"8.1"}},{"matrix":{"php":"8.3"}}]}]}';
  const sandbox = sandboxHome({ plan });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '.github/workflows/test.yml', job: 'a', matrix: { php: '8.3' } } }, repo(), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
  const argv = sandbox.read('argv').split('\n');
  assert.equal(argv[argv.indexOf('--matrix-filter') + 1], 'php=8.3');
});

test('the worker refuses a workflow that is a symbolic link', async () => {
  const sandbox = sandboxHome();
  const dir = repo({ 'ci.yml': OK });
  fs.rmSync(path.join(dir, '.github/workflows/test.yml'));
  fs.symlinkSync('../../ci.yml', path.join(dir, '.github/workflows/test.yml'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'link');
  const r = await runSandboxCi(check, dir, server({ home: sandbox.home }).env);
  assert.match(r.notRun, /symbolic link/);
});

test('an ordinary WordPress CI workflow is allowed', async () => {
  const sandbox = sandboxHome();
  const r = await runSandboxCi(check, repo({ '.github/workflows/test.yml': 'jobs:\n  php:\n    runs-on: ubuntu-latest\n    container: php:${{ matrix.php }}\n    services:\n      mysql:\n        image: mysql:${{ matrix.db }}\n        env: { MYSQL_ROOT_PASSWORD: root }\n        ports: ["3306:3306"]\n        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-retries=5\n    steps: [{ run: composer test }]\n  a:\n    runs-on: ubuntu-latest\n    steps: [{ run: id }]\n' }), server({ home: sandbox.home }).env);
  assert.equal(r.status, 0, JSON.stringify(r));
});

test('the worker refuses arguments Miu would never send', () => {
  const sandbox = sandboxHome();
  for (const args of [['../../etc/passwd', 'push', '60', 'a'], ['.github/workflows/a.yml', 'push;id', '60', 'a'], ['.github/workflows/a.yml', 'push', 'x', 'a'], ['.github/workflows/a.yml', 'push', '60', '--allow-deploy'], ['.github/workflows/a.yml', 'push', '60', 'a', '--runtime=sandbox']]) {
    const r = spawnSync(WORKER, args, { input: '', env: { ...process.env, HOME: sandbox.home } });
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(sandbox.home, 'argv')), false);
});

test('a job that fails is a failure, with the output of what failed', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'good', status: 'passed', exit_code: 0, output: 'all fine\n[t/a]   🏁  Job succeeded' },
    { label: 'bad', matrix: { php: '8.1' }, status: 'failed', exit_code: 1, output: 'PHPUnit: 2 failures\n[t/bad]   🏁  Job failed' },
  ]) });
  const r = await runSandboxCi(check, repo(), s.env);
  assert.equal(r.status, 1);
  assert.equal(r.notRun, undefined);
  assert.match(r.out, /PHPUnit: 2 failures/);
  assert.doesNotMatch(r.out, /all fine/);
});

test('a real failure is reported even when another cell could not start', async () => {
  const s = fakeWorker({ exit: 1, stdout: report([
    { label: 'bad', status: 'failed', exit_code: 2, output: 'assertion\n[t/bad]   🏁  Job failed' },
    { label: 'down', status: 'provision_failed', error: 'no port' },
  ]) });
  assert.equal((await runSandboxCi(check, repo(), s.env)).status, 1);
});

// A broken server must never read as a broken pull request.
for (const [name, sb, expected] of [
  ['a cell that could not start', { exit: 1, stdout: report([{ label: 'a', status: 'provision_failed', error: 'no port left' }]) }, /no port left/],
  ['act failing before the job ran', { exit: 1, stdout: report([{ label: 'a', status: 'failed', exit_code: 1, output: 'Error: No such image: catthehacker/ubuntu:act-22.04' }]) }, /No such image/],
  ['act exiting 0 without running a job', { stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: 'nothing selected' }]) }, /no job ran/],
  ['a skipped job whose label says it succeeded', { stdout: report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a] 🚧  Skipping unsupported platform -- Try running with -P Job succeeded=image' }]) }, /no job ran/],
  ['a step that prints the failure line', { exit: 1, stdout: report([{ label: 'a', status: 'failed', exit_code: 1, output: '[t/a]   | 🏁  Job failed\nError: No such image' }]) }, /No such image/],
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
  const s = fakeWorker({ stdout: `notice: running locally\n${report([{ label: 'a', status: 'passed', exit_code: 0, output: '[t/a]   🏁  Job succeeded' }])}` });
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

test('moves on from a worker that will not stop', async () => {
  const s = fakeWorker({ sleep: 3, ignoreTerm: true });
  const started = Date.now();
  const r = await runSandboxCi(check, repo(), s.env, { limitMs: 100, stopWaitMs: 100 });
  assert.match(r.notRun, /time limit/);
  assert.ok(Date.now() - started < 2500);
});

test('an invalid check is refused before anything runs', async () => {
  const s = fakeWorker({ stdout: report([]) });
  const r = await runSandboxCi({ label: 'CI', sandbox_ci: { workflow: '../../etc/passwd', job: 'a' } }, repo(), s.env);
  assert.match(r.notRun, /workflow/);
  assert.equal(s.ran(), false);
});

test('profile validation names what is wrong', () => {
  assert.equal(sandboxCiProblem({ label: 'tests', cmd: 'composer test' }), null);
  assert.equal(sandboxCiProblem(check), null);
  assert.equal(sandboxCiProblem({ sandbox_ci: { workflow: '.github/workflows/a.yaml', job: 'php-8', matrix: { php: 8.3 }, event: 'push', timeout_minutes: 45 } }), null);
  for (const [bad, field] of [
    [{ sandbox_ci: 'ci.yml' }, 'object'],
    [{ cmd: 'x', sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a' } }, 'cmd'],
    [{ sandbox_ci: { workflow: 'ci.yml', job: 'a' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/../../a.yml', job: 'a' } }, 'workflow'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml' } }, 'job'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', matrix: ['php'] } }, 'matrix'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: '--allow-deploy' } }, 'job'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', matrix: { php: '8;id' } } }, 'matrix'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', event: 'Push!' } }, 'event'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', timeout_minutes: 0 } }, 'timeout_minutes'],
    [{ sandbox_ci: { workflow: '.github/workflows/a.yml', job: 'a', timeout_minutes: 241 } }, 'timeout_minutes'],
  ]) assert.match(sandboxCiProblem(bad), new RegExp(field), JSON.stringify(bad));
});

test('a pull request cannot choose what the server runs', () => {
  assert.equal(changesCiDefinition(['src/a.php', '.github/workflows/test.yml']), true);
  assert.equal(changesCiDefinition(['.github/actions/setup/action.yml']), true);
  assert.equal(changesCiDefinition(['.actrc']), true);
  assert.equal(changesCiDefinition(['src/a.php', 'docs/.github-notes.md']), false);
});
