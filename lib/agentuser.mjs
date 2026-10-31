// Running the agent as its own account (MIU_AGENT_USER, e.g. qa-agent).
//
// Miu itself runs as one account (qa) that holds the GitHub App key, the
// sealed tokens and rexenv. The agent has a shell, so on a server it runs as a
// second account that cannot read any of that: Miu starts the agent CLI
// through sudo and a root-owned script, /usr/local/lib/miu/agent-exec, which
// is the only thing sudo lets qa run as the agent account. The agent reaches
// rexenv and the QA sites through two more root-owned scripts it may run as
// qa, rex-mcp and qasite, and nothing else. docs/runner-setup.md has the setup.
//
// Without MIU_AGENT_USER (a Mac, a laptop) the agent runs as Miu's account, as
// before, and none of this applies.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const AGENT_USER = process.env.MIU_AGENT_USER || null;
const LIB = process.env.MIU_AGENT_LIB || '/usr/local/lib/miu';
export const AGENT_EXEC = `${LIB}/agent-exec`;
// rexenv's MCP server, as seen from the agent: through sudo to Miu's account.
export const AGENT_REX = `${LIB}/rex-as-qa`;
export const AGENT_QASITE = `${LIB}/qasite-as-qa`;

// [command, args] that run cmd as the agent account (unchanged without one).
export function asAgent(cmd, args = []) {
  return AGENT_USER ? ['sudo', ['-n', '-E', '-u', AGENT_USER, AGENT_EXEC, cmd, ...args]] : [cmd, args];
}

// The agent account's own CLIs; Miu's are in a home it cannot enter.
export const agentBin = (name) => process.env[`MIU_AGENT_${name.toUpperCase()}`] || `/home/${AGENT_USER}/.local/node/bin/${name}`;

// The agent account's PATH under the run's own bin: the bwrap link first (Codex's
// sandbox needs the copy bundled with it), then its Node. The installer sets it.
export const agentBasePath = () => process.env.MIU_AGENT_BASE_PATH || `/home/${AGENT_USER}/.local/miu-bin:/home/${AGENT_USER}/.local/node/bin:/usr/local/bin:/usr/bin:/bin`;

// Let the agent account into one run folder, and keep Miu able to read and
// remove what it writes there (default ACLs on every folder below).
export function shareRunDir(dir) {
  if (!AGENT_USER) return;
  const r = spawnSync('setfacl', ['-R', '-m', `u:${AGENT_USER}:rwX,d:u:${AGENT_USER}:rwX,d:u:${process.env.USER || 'qa'}:rwX,m::rwx,d:m::rwx`, dir], { encoding: 'utf8' });
  // Files the agent made in an earlier run (a test cache in a reused worktree)
  // are its own: setfacl may not change them, and the agent needs no grant there.
  const other = (r.stderr || '').split('\n').filter((l) => l.trim() && !/Operation not permitted/.test(l));
  if (r.status !== 0 && (other.length || !(r.stderr || '').trim())) throw new Error(`setfacl on the run folder failed: ${(other[0] || r.stderr || '').trim()}`);
}

// Remove a path that may hold files the agent account made with modes Miu's
// account cannot override (a tool that made a 0755 folder): as the agent.
export function rmAny(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return; } catch (e) {
    if (!AGENT_USER || !['EACCES', 'EPERM', 'ENOTEMPTY'].includes(e.code)) throw e;
  }
  const [cmd, args] = asAgent('rm', ['-rf', '--', p]);
  spawnSync(cmd, args, { stdio: 'ignore' });
}
