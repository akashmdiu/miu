#!/usr/bin/env node
// rexenv's MCP server behind a guard, for engines without Claude's tool hooks
// (Codex). The engine starts this instead of `rex mcp`; it starts `rex mcp`
// and passes messages both ways, with the limits a Claude run gets from its
// hooks in lib/agent.mjs:
//   - only the tools in REXENV_TOOLS are listed or callable
//   - a call with a site_id reaches only the QA sites (context/sites.json) and
//     scratch sites this run made; anything else is refused
//   - every call is written to the evidence ledger, and its reply says the id
//
//   node lib/mcp-guard.mjs <run-dir>
// Refusals are logged to <run-dir>/mcp-guard.log.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENT_USER, AGENT_QASITE } from './agentuser.mjs';
import { REXENV_TOOLS, recordMcpEvidence, siteRule } from './rules.mjs';

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(runDir)) { console.error('usage: mcp-guard.mjs <run-dir>'); process.exit(2); }
const TOOLS = new Set(REXENV_TOOLS.map((t) => t.replace('mcp__rexenv__', '')));
const FIX = (() => { try { return 'fix' in JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')); } catch { return false; } })();
if (FIX) for (const t of [...TOOLS]) if (t.startsWith('scratch_')) TOOLS.delete(t);

// qasite as MCP tools. Codex's sandbox forbids sudo, which the shell's qasite
// needs once the agent has its own account; this guard runs outside that
// sandbox, so it can run qasite for the agent.
const QASITE_TOOLS = {
  qa_site_reset: { sub: 'reset', description: 'Put a QA site back to its clean snapshot in about a second (database, drop-ins and cache folders). The same as `qasite reset pr|dev`. Run it before every combo.' },
  qa_site_login: { sub: 'login', description: 'A one-time wp-admin sign-in link for a QA site, valid for two minutes. The same as `qasite login pr|dev`.' },
};
// The QA sites of this run (context/sites.json): pr and dev for a test, fix
// for a fix. A fix has its own site, so it makes no scratch sites.
let siteMap = {};
try { siteMap = JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')); } catch { /* none */ }
const NAMES = Object.keys(siteMap).filter((w) => ['pr', 'dev', 'fix'].includes(w));
const WHAT = { pr: 'pr = qa-pr.rex (the PR build)', dev: 'dev = qa-dev.rex (the base branch)', fix: 'fix = qa-fix.rex (the code being fixed)' };
const qasiteDefs = NAMES.length ? Object.entries(QASITE_TOOLS).map(([name, t]) => ({
  name, description: t.description,
  inputSchema: { type: 'object', properties: { site: { type: 'string', enum: NAMES, description: NAMES.map((w) => WHAT[w]).join(', ') } }, required: ['site'] },
})) : [];
function runQasite(name, args) {
  const site = args?.site;
  if (!NAMES.includes(site)) return { text: `site must be one of: ${NAMES.join(', ') || 'none in this run'}.`, error: true };
  const r = AGENT_USER
    ? spawnSync(AGENT_QASITE, [QASITE_TOOLS[name].sub, site], { encoding: 'utf8', timeout: 5 * 60 * 1000 })
    : spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'warmsites.mjs'), QASITE_TOOLS[name].sub, site], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  return { text: ((r.stdout || '') + (r.stderr || '')).trim() || `exit ${r.status}`, error: r.status !== 0 };
}
const sites = new Set();
try { for (const w of Object.values(JSON.parse(fs.readFileSync(path.join(runDir, 'context/sites.json'), 'utf8')))) if (w?.id) sites.add(w.id); } catch { /* no QA sites: scratch sites only */ }
const note = (m) => fs.appendFileSync(path.join(runDir, 'mcp-guard.log'), `[${new Date().toISOString()}] ${m}\n`);

const rex = spawn(process.env.QA_REX_BIN ?? 'rex', ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
rex.on('exit', (code) => process.exit(code ?? 0));
process.stdin.on('end', () => rex.stdin.end());
const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const pending = new Map(); // request id -> { kind: 'list' } | { kind: 'call', tool, args }

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { rex.stdin.write(line + '\n'); return; }
  if (msg.method === 'tools/list' && msg.id != null) pending.set(msg.id, { kind: 'list' });
  if (msg.method === 'tools/call' && msg.id != null && QASITE_TOOLS[msg.params?.name]) {
    const tool = msg.params.name;
    const args = msg.params.arguments ?? {};
    const out = runQasite(tool, args);
    const content = [{ type: 'text', text: out.text }];
    try {
      const id = recordMcpEvidence(runDir, { tool_name: `mcp__rexenv__${tool}`, tool_input: args, tool_response: content });
      content.push({ type: 'text', text: `Recorded as evidence ${id}. Cite it as "${id}".` });
    } catch (e) { note(`could not record evidence for ${tool}: ${e.message}`); }
    toClient({ jsonrpc: '2.0', id: msg.id, result: { content, isError: out.error } });
    return;
  }
  if (msg.method === 'tools/call' && msg.id != null) {
    const tool = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    let why = null;
    if (!TOOLS.has(tool)) why = `${tool} is not available in a QA run.`;
    else why = siteRule(tool, args, sites);
    if (why) {
      note(`refused ${tool}: ${why}`);
      toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: why }], isError: true } });
      return;
    }
    pending.set(msg.id, { kind: 'call', tool, args });
  }
  rex.stdin.write(JSON.stringify(msg) + '\n');
});

readline.createInterface({ input: rex.stdout }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  const req = msg.id != null && pending.get(msg.id);
  if (req) pending.delete(msg.id);
  if (req?.kind === 'list' && Array.isArray(msg.result?.tools)) {
    msg.result.tools = [...msg.result.tools.filter((t) => TOOLS.has(t.name)), ...qasiteDefs];
  }
  if (req?.kind === 'call' && msg.result) {
    try {
      const content = msg.result.content ?? [];
      const id = recordMcpEvidence(runDir, { tool_name: `mcp__rexenv__${req.tool}`, tool_input: req.args, tool_response: content });
      if (req.tool === 'scratch_create_site') {
        try { const made = JSON.parse(content.map((c) => c.text ?? '').join('')); if (made.id) sites.add(made.id); } catch { /* no id */ }
      }
      msg.result.content = [...content, { type: 'text', text: `Recorded as evidence ${id}. Cite it as "${id}".` }];
    } catch (e) { note(`could not record evidence for ${req.tool}: ${e.message}`); }
  }
  toClient(msg);
});
