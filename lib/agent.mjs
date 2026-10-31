// Runs the QA agent. runAgent picks the engine from the model (lib/engines.mjs):
// Codex models go to lib/codex.mjs, the rest run here.
//
// Claude runs go through the Claude Agent SDK, in streaming input mode so
// the model can be changed while it works (Query.setModel). The SDK starts
// the locally installed `claude` CLI, so the run uses the Claude subscription
// that CLI is signed in with.
//
// Model switches come from <run-dir>/control.json, written by bin/qa-dashboard:
//   { "seq": 3, "model": "claude-opus-5-5" }
// Each switch is applied within two seconds and appended to models.jsonl.
// Instructions a person sends from the dashboard (lib/steer.mjs) go into the
// same input stream and reach the agent at its next tool call.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { ALLOWED_TOOLS, DISALLOWED_TOOLS, toolRule, recordMcpEvidence, siteRule, REXENV_TOOLS } from './rules.mjs';
import { engineOf } from './engines.mjs';
import { AGENT_USER, AGENT_REX, agentBin } from './agentuser.mjs';
import * as steer from './steer.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export { ALLOWED_TOOLS, DISALLOWED_TOOLS, toolRule, REXENV_TOOLS };

function claudeBinary() {
  if (process.env.QA_CLAUDE_BIN) return process.env.QA_CLAUDE_BIN;
  const r = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export async function runAgent(opts) {
  if (engineOf(opts.model) === 'codex') return (await import('./codex.mjs')).runCodex(opts);
  return runClaude(opts);
}

// workDir: where the agent works, when not the run folder (the fix agent
// edits a worktree). rule: the tool rule to enforce instead of the QA one.
// rexenv: false for an agent that tests nothing on a site; 'site' for one
// that has its own QA site and makes no scratch sites (the fix agent).
async function runClaude({ prompt, runDir, model, env, maxTurns, timeoutMin, permissionMode, log, settings, effort, workDir = runDir, rule = toolRule, rexenv = true }) {
  const transcript = fs.createWriteStream(path.join(runDir, 'agent-transcript.jsonl'), { flags: 'a' });
  const modelsLog = path.join(runDir, 'models.jsonl');
  const controlFile = path.join(runDir, 'control.json');
  const note = (m) => fs.appendFileSync(modelsLog, JSON.stringify({ at: new Date().toISOString(), model: m }) + '\n');

  // Streaming input: the task, then the stream stays open until the agent
  // finishes, so setModel and a person's instructions can still reach it.
  let finish, ended = false;
  const done = new Promise((r) => { finish = () => { ended = true; r(); }; });
  const queue = [];
  let wake = () => {};
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' };
    for (;;) {
      while (queue.length) yield queue.shift();
      if (await Promise.race([done.then(() => true), new Promise((r) => { wake = () => r(false); })])) return;
    }
  }
  // 'next': at the agent's next tool call, not after it has finished.
  const deliver = () => {
    if (ended) return;
    const list = steer.pending(runDir);
    if (!list.length) return;
    steer.markDone(runDir, list.map((s) => s.id), 'live');
    for (const s of list) transcript.write(steer.transcriptLine(s));
    queue.push({ type: 'user', message: { role: 'user', content: steer.message(list) }, parent_tool_use_id: null, session_id: '', priority: 'next' });
    log(`instruction from ${[...new Set(list.map((s) => s.by))].join(', ')} sent to the agent`);
    wake();
  };

  // Sites this run may touch: the QA sites, plus scratch sites it creates.
  const allowedSites = new Set();
  try {
    const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8'));
    for (const w of Object.values(qa)) if (w?.id) allowedSites.add(w.id);
  } catch { /* no QA sites (light run or Hub): scratch sites only */ }

  // As its own account the CLI is started through bin/agent-claude, and the
  // rexenv MCP server through sudo back to Miu's account (lib/agentuser.mjs).
  const cliEnv = AGENT_USER ? { ...env, MIU_AGENT_USER: AGENT_USER, MIU_AGENT_CLAUDE_BIN: agentBin('claude'), MIU_AGENT_CWD: workDir } : env;
  const q = query({
    prompt: input(),
    options: {
      model,
      ...(effort ? { effort } : {}),
      cwd: workDir,
      env: cliEnv,
      additionalDirectories: [...new Set([workDir, runDir])],
      allowedTools: rexenv === 'site' ? ALLOWED_TOOLS.filter((t) => !t.startsWith('mcp__rexenv__scratch_')) : rexenv ? ALLOWED_TOOLS : ALLOWED_TOOLS.filter((t) => !t.startsWith('mcp__')),
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode,
      maxTurns,
      // Nothing from the user's own setup: no settings files (their allow
      // rules), no CLAUDE.md, no MCP servers such as Slack or live sites.
      settingSources: [],
      // An API-key connection: apiKeyHelper prints the key (lib/connections.mjs).
      ...(settings ? { settings } : {}),
      strictMcpConfig: true,
      // rexenv is the test environment: scratch WordPress sites, wp-cli, the
      // database, logs and caught mail, through rexenv's own MCP server.
      mcpServers: rexenv ? { rexenv: { type: 'stdio', command: AGENT_USER ? AGENT_REX : process.env.QA_REX_BIN ?? 'rex', args: ['mcp'] } } : {},
      hooks: {
        PreToolUse: [{
          matcher: '^(Bash|Write|Edit|Read|Grep|Glob)$',
          hooks: [async (input) => {
            const why = rule(input.tool_name, input.tool_input ?? {});
            if (!why) return {};
            log(`refused ${input.tool_name}: ${why.split('.')[0]}`);
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
          }],
        }, {
          matcher: '^mcp__rexenv__',
          hooks: [async (input) => {
            const tool = input.tool_name.replace('mcp__rexenv__', '');
            const why = siteRule(tool, input.tool_input ?? {}, allowedSites);
            if (!why) return {};
            log(`refused rexenv ${tool} on site ${input.tool_input?.site_id ?? '(none)'}`);
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
          }],
        }],
        PostToolUse: [{
          matcher: '^mcp__rexenv__',
          hooks: [async (input) => {
            try {
              const id = recordMcpEvidence(runDir, input);
              if (input.tool_name === 'mcp__rexenv__scratch_create_site') {
                const r = input.tool_response; const text = typeof r === 'string' ? r : Array.isArray(r) ? r.map((c) => c.text ?? '').join('') : JSON.stringify(r);
                try { const made = JSON.parse(text); if (made.id) allowedSites.add(made.id); } catch { /* no id */ }
              }
              return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Recorded as evidence ${id}. Cite it as "${id}".` } };
            } catch (e) { log(`could not record rexenv evidence: ${e.message}`); return {}; }
          }],
        }],
      },
      pathToClaudeCodeExecutable: AGENT_USER ? path.join(ROOT, 'bin/agent-claude') : claudeBinary(),
      stderr: (d) => process.stderr.write(d),
    },
  });

  note(model);
  let current = model;
  let seen = 0;
  try { seen = JSON.parse(fs.readFileSync(controlFile, 'utf8')).seq ?? 0; } catch { /* no control file yet */ }
  deliver();
  const poll = setInterval(async () => {
    try { deliver(); } catch (e) { log(`could not send an instruction: ${e.message}`); }
    let c;
    try { c = JSON.parse(fs.readFileSync(controlFile, 'utf8')); } catch { return; }
    if (!c?.seq || c.seq === seen || !c.model) return;
    seen = c.seq;
    if (c.model === current) return;
    try {
      await q.setModel(c.model);
      log(`model switched ${current} -> ${c.model}`);
      current = c.model;
      note(c.model);
    } catch (e) {
      log(`model switch to ${c.model} failed: ${e.message}`);
    }
  }, 2000);

  const timer = setTimeout(async () => {
    log('agent timeout, interrupting');
    try { await q.interrupt(); } catch { /* already stopping */ }
    finish();
  }, timeoutMin * 60 * 1000);

  // An instruction that arrives as the agent finishes starts one more turn
  // right away, so the stream stays open a moment after each result.
  let result = null, closing = null;
  try {
    for await (const msg of q) {
      transcript.write(JSON.stringify(msg) + '\n');
      clearTimeout(closing);
      if (msg.type === 'result') { result = msg; closing = setTimeout(finish, 3000); }
    }
  } catch (e) {
    log(`agent error: ${e.message}`);
    result ??= { subtype: 'error', error: e.message };
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    clearTimeout(closing);
    finish();
    transcript.end();
  }
  return { ok: result?.subtype === 'success', result };
}
