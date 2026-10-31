// Runs the QA agent with the Codex CLI (`codex exec`), on the ChatGPT plan the
// CLI is signed in with. Called by runAgent in lib/agent.mjs for Codex models.
//
// Codex has no tool hooks a run can rely on (hooks need a trust step), so the
// limits a Claude run gets from its hooks come from elsewhere:
//   - writes: Codex's own sandbox (workspace-write) lets commands write only in
//     the run directory and the temp folder, so the worktrees, the site
//     folders and the user's repos are read-only to it
//   - rexenv: lib/mcp-guard.mjs sits in front of `rex mcp`, limits calls to
//     the QA sites and scratch sites, and records each call as evidence
//   - nothing from the user's setup: --ignore-user-config (no MCP servers, no
//     instructions), no AGENTS.md, no saved session
// Network stays on: the agent tests the QA sites and Hubs over HTTP.
//
// Codex's events are kept as they came in agent-codex.jsonl and translated
// into the transcript shape the dashboard and the report read
// (agent-transcript.jsonl): assistant text and tool calls, tool results, and a
// final result with the token counts.
//
// `codex exec` reads its task once, so a person's instruction (lib/steer.mjs)
// cannot reach a pass that is already going: it goes with the next pass, and
// bin/qa-run runs one for it when the main pass ends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REXENV_TOOLS } from './rules.mjs';
import { AGENT_USER, AGENT_REX, asAgent, agentBin } from './agentuser.mjs';
import * as steer from './steer.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-guard.mjs');

// QA_CODEX_BIN, then `codex` on the login shell's PATH, then the CLI inside the
// newest ChatGPT editor extension (the usual install on this box).
export function codexBinary() {
  const ok = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } };
  if (process.env.QA_CODEX_BIN) return process.env.QA_CODEX_BIN;
  const r = spawnSync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  if (r.status === 0 && ok(r.stdout.trim())) return r.stdout.trim();
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  const found = (fs.existsSync(ext) ? fs.readdirSync(ext) : []).filter((d) => d.startsWith('openai.chatgpt-')).sort().reverse()
    .flatMap((d) => ['macos-aarch64', 'macos-x86_64', 'linux-x86_64', 'linux-aarch64'].map((a) => path.join(ext, d, 'bin', a, 'codex')))
    .find(ok);
  return found ?? null;
}

const toml = (v) => JSON.stringify(v); // a JSON string or string array is valid TOML

// `/bin/zsh -lc 'echo hi'` -> `echo hi`, as the timeline shows commands.
function plainCommand(cmd = '') {
  const m = cmd.match(/^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return m ? m[2].replace(/'\\''/g, "'") : cmd;
}

// workDir and rexenv as in lib/agent.mjs: the fix agent works in a worktree,
// writes only there and in its run folder, and has no network and no rexenv.
export async function runCodex({ prompt, runDir, model, env, maxTurns, timeoutMin, log, extraArgs = [], effort, workDir = runDir, rexenv = true }) {
  const bin = AGENT_USER ? agentBin('codex') : codexBinary();
  if (!bin) {
    log('codex CLI not found (set QA_CODEX_BIN)');
    return { ok: false, result: { subtype: 'error', error: 'The Codex CLI was not found on this machine' } };
  }
  const transcript = fs.createWriteStream(path.join(runDir, 'agent-transcript.jsonl'), { flags: 'a' });
  const raw = fs.createWriteStream(path.join(runDir, 'agent-codex.jsonl'), { flags: 'a' });
  fs.appendFileSync(path.join(runDir, 'models.jsonl'), JSON.stringify({ at: new Date().toISOString(), model }) + '\n');
  const write = (ev) => transcript.write(JSON.stringify({ ...ev, timestamp: new Date().toISOString() }) + '\n');

  // As its own account, Codex gets a copy of Miu's ChatGPT sign-in in a
  // folder only it and Miu can open; what Codex refreshes there is copied
  // back when the run ends, so a rotated token is not lost.
  let codexHome = null;
  if (AGENT_USER && env.CODEX_HOME && fs.existsSync(path.join(env.CODEX_HOME, 'auth.json'))) {
    // Not under /tmp: Codex will not put its helpers in a temp folder.
    const base = process.env.MIU_AGENT_CODEX_DIR || os.tmpdir();
    fs.mkdirSync(base, { recursive: true, mode: 0o750 });
    codexHome = { from: env.CODEX_HOME, dir: fs.mkdtempSync(path.join(base, 'codex-')) };
    fs.copyFileSync(path.join(codexHome.from, 'auth.json'), path.join(codexHome.dir, 'auth.json'));
    spawnSync('setfacl', ['-R', '-m', `u:${AGENT_USER}:rwX,d:u:${AGENT_USER}:rwX,d:u:${os.userInfo().username}:rwX,m::rwx,d:m::rwx`, codexHome.dir]);
    env = { ...env, CODEX_HOME: codexHome.dir };
  }
  const agentHome = AGENT_USER ? `/home/${AGENT_USER}` : null;
  const mcpEnv = AGENT_USER
    ? { PATH: env.PATH, HOME: agentHome, QA_REX_BIN: AGENT_REX }
    : { PATH: env.PATH, HOME: env.HOME ?? os.homedir(), ...(env.QA_REX_BIN ? { QA_REX_BIN: env.QA_REX_BIN } : {}) };
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-C', workDir, '-m', model,
    ...(workDir !== runDir ? ['--add-dir', runDir] : []),
    '-s', 'workspace-write',
    '-c', `sandbox_workspace_write.network_access=${!!rexenv}`,
    '-c', 'approval_policy="never"',
    '-c', `model_reasoning_effort=${toml(effort ?? process.env.QA_CODEX_EFFORT ?? 'medium')}`,
    '-c', 'project_doc_max_bytes=0',
    '-c', 'tools.web_search=false',
    ...(rexenv ? [
      '-c', `mcp_servers.rexenv.command=${toml(AGENT_USER ? 'node' : process.execPath)}`,
      '-c', `mcp_servers.rexenv.args=${toml([GUARD, runDir])}`,
      '-c', `mcp_servers.rexenv.env={${Object.entries(mcpEnv).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`,
      '-c', 'mcp_servers.rexenv.startup_timeout_sec=60',
      '-c', 'mcp_servers.rexenv.tool_timeout_sec=600',
      // Codex asks before a tool that writes, and a run cannot answer. The guard
      // has already checked each call, so rexenv's listed tools run unasked.
      '-c', 'mcp_servers.rexenv.default_tools_approval_mode="approve"',
      '-c', `mcp_servers.rexenv.enabled_tools=${toml([...REXENV_TOOLS.map((t) => t.replace('mcp__rexenv__', '')).filter((t) => rexenv !== 'site' || !t.startsWith('scratch_')), 'qa_site_reset', 'qa_site_login'])}`,
    ] : []),
    // Which sign-in to use: the ChatGPT plan or an API key (lib/connections.mjs).
    ...extraArgs,
    '-',
  ];
  const [vCmd, vArgs] = asAgent(bin, ['--version']);
  log(`codex: ${bin.startsWith(os.homedir() + '/') ? '~' + bin.slice(os.homedir().length) : bin}${AGENT_USER ? ` as ${AGENT_USER}` : ''} (${spawnSync(vCmd, vArgs, { encoding: 'utf8', env: { ...env, MIU_AGENT_CWD: runDir } }).stdout?.trim() || 'version unknown'})`);
  // QA_SANDBOXED tells lib/shot.mjs and lib/clip.mjs to start Chromium in the
  // mode that works inside Codex's sandbox.
  const asked = steer.pending(runDir);
  if (asked.length) {
    steer.markDone(runDir, asked.map((s) => s.id), 'start');
    for (const s of asked) transcript.write(steer.transcriptLine(s));
    prompt += `\n\n---\n\n${steer.message(asked)}\n`;
    log(`instruction from ${[...new Set(asked.map((s) => s.by))].join(', ')} sent with the task`);
  }
  const [cmd, cmdArgs] = asAgent(bin, args);
  const child = spawn(cmd, cmdArgs, { cwd: workDir, env: { ...env, QA_SANDBOXED: '1', MIU_AGENT_CWD: workDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
  child.stderr.on('data', (d) => process.stderr.write(d));

  const started = Date.now();
  // A turn is one model step, as Claude counts them: tool calls started
  // together (in parallel) are one turn, so both engines get the same budget.
  let turns = 0, inFlight = 0, msgN = 0, stopWhy = null, failed = null, sawTurnEnd = false;
  const usage = { input: 0, cached: 0, output: 0 };
  const stop = (why) => {
    if (stopWhy) return;
    stopWhy = why;
    log(`codex: stopping (${why})`);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10000).unref();
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMin * 60 * 1000);
  const say = (content) => write({ type: 'assistant', message: { id: `codex-${++msgN}`, role: 'assistant', model, content, usage: {} } });
  const toolResult = (id, text, isError) => write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(text ?? '').slice(0, 20000), is_error: !!isError }] } });
  const started_items = new Set();

  // An item becomes a tool call when it starts (so the timeline shows it
  // running) and gets its result when it completes.
  function toolUse(it) {
    if (started_items.has(it.id)) return;
    started_items.add(it.id);
    if (it.type === 'command_execution') say([{ type: 'tool_use', id: it.id, name: 'Bash', input: { command: plainCommand(it.command) } }]);
    else if (it.type === 'mcp_tool_call') say([{ type: 'tool_use', id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments ?? {} }]);
    else if (it.type === 'file_change') say([{ type: 'tool_use', id: it.id, name: 'Edit', input: { file_path: (it.changes ?? []).map((c) => path.relative(workDir, c.path)).join(', ') } }]);
    else if (it.type === 'web_search') say([{ type: 'tool_use', id: it.id, name: 'WebSearch', input: { query: it.query ?? '' } }]);
    else return;
    if (inFlight++ === 0 && ++turns > maxTurns) stop('turn limit');
  }
  const finished = new Set();
  const toolDone = (it) => { if (started_items.has(it.id) && !finished.has(it.id)) { finished.add(it.id); inFlight = Math.max(0, inFlight - 1); } };

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    raw.write(line + '\n');
    let ev; try { ev = JSON.parse(line); } catch { return; }
    const it = ev.item ?? {};
    if (ev.type === 'item.started') toolUse(it);
    else if (ev.type === 'item.completed') {
      if (it.type === 'agent_message' && it.text?.trim()) say([{ type: 'text', text: it.text }]);
      else if (it.type === 'reasoning' && it.text?.trim()) say([{ type: 'thinking', thinking: it.text }]);
      else if (it.type === 'error') log(`codex: ${it.message}`);
      else {
        toolUse(it);
        toolDone(it);
        if (it.type === 'command_execution') toolResult(it.id, it.aggregated_output, it.exit_code !== 0);
        else if (it.type === 'mcp_tool_call') toolResult(it.id, it.error?.message ?? (it.result?.content ?? []).map((c) => c.text ?? JSON.stringify(c)).join('\n'), it.status === 'failed' || !!it.error);
        else if (it.type === 'file_change') toolResult(it.id, (it.changes ?? []).map((c) => `${c.kind} ${path.relative(workDir, c.path)}`).join('\n'), it.status === 'failed');
        else if (it.type === 'web_search') toolResult(it.id, '', false);
      }
    } else if (ev.type === 'turn.completed') {
      sawTurnEnd = true;
      const u = ev.usage ?? {};
      usage.input += u.input_tokens ?? 0; usage.cached += u.cached_input_tokens ?? 0; usage.output += (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
    } else if (ev.type === 'turn.failed') failed = ev.error?.message ?? 'turn failed';
    else if (ev.type === 'error') { failed = ev.message ?? 'error'; log(`codex: ${failed}`); }
  });

  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (codexHome) {
    try {
      const a = fs.readFileSync(path.join(codexHome.dir, 'auth.json'));
      if (!a.equals(fs.readFileSync(path.join(codexHome.from, 'auth.json')))) { fs.writeFileSync(path.join(codexHome.from, 'auth.json'), a, { mode: 0o600 }); log('codex: kept the refreshed ChatGPT sign-in'); }
    } catch (e) { log(`codex: could not copy the sign-in back: ${e.message}`); }
    const [rc, ra] = asAgent('rm', ['-rf', '--', codexHome.dir]);
    spawnSync(rc, ra, { stdio: 'ignore' });
    fs.rmSync(codexHome.dir, { recursive: true, force: true });
  }
  const subtype = stopWhy === 'turn limit' ? 'error_max_turns' : stopWhy === 'timeout' ? 'error_timeout' : failed ? 'error_during_execution' : code === 0 && sawTurnEnd ? 'success' : 'error';
  const result = {
    type: 'result', subtype, num_turns: turns, duration_ms: Date.now() - started, is_error: subtype !== 'success',
    ...(failed ? { error: failed } : {}),
    usage: { input_tokens: Math.max(0, usage.input - usage.cached), cache_read_input_tokens: usage.cached, cache_creation_input_tokens: 0, output_tokens: usage.output },
  };
  write(result);
  await new Promise((r) => transcript.end(r));
  raw.end();
  return { ok: subtype === 'success', result };
}
