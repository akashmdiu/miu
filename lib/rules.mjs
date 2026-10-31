// The rules a QA agent works under, shared by every engine (lib/agent.mjs for
// Claude, lib/codex.mjs for Codex) and by the rexenv guard (lib/mcp-guard.mjs).
import fs from 'node:fs';
import path from 'node:path';

// rexenv tools the agent may use. Tools that take a site_id only reach the two
// QA sites (context/sites.json) and scratch sites this run made: a PreToolUse
// hook refuses any other site, so the user's own sites stay out of reach even
// though rexenv itself would allow them. Tools that manage sites or rexenv
// (site_delete, site_create, settings, stack, ...) are not listed at all.
export const REXENV_TOOLS = ['site_wp_run', 'site_logs', 'wp_user', 'scratch_create_site', 'scratch_delete_site', 'scratch_add_package', 'scratch_sync_package',
  'scratch_login_url', 'wp_run', 'db_query', 'tail_log', 'site_info', 'list_sites', 'stack_status', 'mail_list', 'mail_get', 'mail_inbox']
  .map((t) => `mcp__rexenv__${t}`);
export const ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', ...REXENV_TOOLS];
export const DISALLOWED_TOOLS = ['WebFetch', 'WebSearch', 'Workflow', 'Task', 'RemoteTrigger', 'PushNotification',
  'SendMessage', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'Skill'];

// Every rexenv call is written to the evidence ledger as it happens, and the
// agent is told the id, so MCP results can be cited like qa-evidence output.
// Whether a rexenv call may reach its site: only the QA sites and scratch sites
// this run made. Tools that act on a site must name one, since some treat a
// missing site_id as "rexenv's current site", which can be one of the user's.
const SITELESS = new Set(['list_sites', 'stack_status', 'scratch_create_site', 'mail_inbox']);
export function siteRule(tool, args, allowedSites) {
  if (SITELESS.has(tool)) return null;
  const id = args?.site_id;
  if (!id) return `${tool} needs a site_id: one of the ids in context/sites.json, or a scratch site you made.`;
  if (!allowedSites.has(id)) return `Only qa-pr.rex, qa-dev.rex and scratch sites made in this run can be used (site ${id} is none of them). Use the ids in context/sites.json.`;
  return null;
}

export function recordMcpEvidence(runDir, input) {
  const dir = path.join(runDir, 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'index.jsonl');
  const n = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0;
  const id = `ev-${String(n + 1).padStart(3, '0')}`;
  const tool = input.tool_name.replace('mcp__rexenv__', '');
  const resp = input.tool_response;
  const text = typeof resp === 'string' ? resp : Array.isArray(resp) ? resp.map((c) => c.text ?? JSON.stringify(c)).join('\n') : JSON.stringify(resp, null, 2);
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* plain text */ }
  const file = `${id}.log`;
  fs.writeFileSync(path.join(dir, file), `$ rexenv ${tool} ${JSON.stringify(input.tool_input)}\n${text}\n`);
  const args = input.tool_input ?? {};
  const label = `rexenv ${tool}${args.args ? ': wp ' + args.args.join(' ') : args.sql ? ': ' + args.sql : args.name ? ': ' + args.name : ''}`.slice(0, 200);
  const exit = parsed && typeof parsed.exitCode === 'number' ? parsed.exitCode : (parsed && parsed.succeeded === false ? 1 : null);
  fs.appendFileSync(ledger, JSON.stringify({ id, kind: 'mcp', label, file, exit, tool, at: new Date().toISOString() }) + '\n');
  return id;
}

// Rules the agent's own tools must follow, enforced before each call. Prompt
// guidance alone did not hold: runs wrapped wp-cli in their own scripts
// (wp --path=~/rexenv/Sites/...), which skipped the MCP site guard and the
// evidence ledger, and read code with cat/sed/grep instead of Read and Grep.
const SITE_FILES = /rexenv\/Sites|~\/rexenv|\$HOME\/rexenv|\/Users\/[^/\s]+\/rexenv/;
const RAW_TOOLS = /(^|[\s;&|(`'"])(wp|wp-cli|mysql|mysqldump|mariadb)(\s|$)|--path=|(^|[\s;&|(`'"])php\s+(?!-l\b)/;
const SHELL_READ = /^\s*(cd\s+[^;&|]+(;|&&)\s*)?(cat|head|tail|less|more|sed\s+-n|grep|egrep|rg|find|ls|jq|wc|tree)\b/;
const QA_SITE_DIR = /rexenv\/Sites\/qa-(pr|dev)\.rex\//;

// Both Hubs are started by the harness (context/hubs.json); a server the agent
// starts itself is outside the run's cleanup and its evidence trail.
const SERVER_START = /\bhubenv\s+(up|down)\b|dist\/server\.js|\btsx\b[^|;&]*\bserver|\bvite\b|\bnpm\s+(run\s+)?(dev|start|preview)\b|\bprisma\s+(migrate|db\s+push)/;
const SERVER_MSG = 'Both Hubs already run: context/hubs.json has pr (after) and dev (before). Do not start, stop or rebuild servers; use their URLs, and hubenv logs pr|dev.';

// Miu's own sign-ins and keys, and the ways to print an environment. The agent
// runs as the same account as Miu, so the file mode alone does not keep it out.
const SECRETS = /\.config\/miu|keys(\.enc)?\.json|CREDENTIALS_DIRECTORY|\/run\/credentials|\.codex\/auth\.json|\.claude\/\.credentials|CLAUDE_CODE_OAUTH_TOKEN|_API_KEY|\bprintenv\b|\/proc\/[^\s]*\/environ|(^|[;&|]\s*)(env|set|export -p)\s*($|[|;&>])/;
const SECRETS_MSG = 'Miu\'s sign-ins, keys and environment are off limits. Never read or print them.';

export function toolRule(name, input) {
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    if (SECRETS.test(cmd)) return SECRETS_MSG;
    if (SERVER_START.test(cmd)) return SERVER_MSG;
    // The worktrees serve the QA sites: reading history is fine, moving them is not.
    if (/\bgit\b[^|;&]*\b(checkout|switch|reset|clean|commit|stash|merge|rebase|pull|fetch|push|restore|am|apply|cherry-pick|worktree)\b/.test(cmd)) return 'The worktrees serve the QA sites; read their history (git log, git show, git diff) but never change them.';
    if (SITE_FILES.test(cmd)) return 'Do not touch site folders from the shell. Inspect a QA site with mcp__rexenv__site_wp_run (wp eval, file_exists, option get).';
    if (RAW_TOOLS.test(cmd)) return 'Run wp-cli and PHP on a site only through mcp__rexenv__site_wp_run, not wp, php, mysql or --path in the shell. It is recorded as evidence and limited to the QA sites.';
    if (SHELL_READ.test(cmd) && !/qa-evidence/.test(cmd)) return 'Read files with the Read tool, search with Grep, list with Glob. Use Bash to run things, and qa-evidence when the output is proof.';
  }
  if (name === 'Write' || name === 'Edit') {
    if (/(^|\/)(verdict\.json|posted\.json|waiting\.json|cleanup\.json|screenshots\.json|report\.md|comment[\w.-]*\.md)$/.test(String(input.file_path ?? ''))) return 'Miu writes the verdict, the report and the PR comment itself. Write results.json and notes.md only.';
    const text = String(input.content ?? input.new_string ?? '');
    if (SERVER_START.test(text)) return SERVER_MSG;
    if (SITE_FILES.test(text) || /\bwp\s+--path|\bwp\s+(option|plugin|eval|db|config|post|cache|cron)\b/.test(text)) return 'Do not write scripts that run wp-cli or reach site folders. Use mcp__rexenv__site_wp_run for each step instead.';
  }
  if (name === 'Read' || name === 'Grep' || name === 'Glob') {
    const target = String(input.file_path ?? input.path ?? input.pattern ?? '');
    if (SECRETS.test(target)) return SECRETS_MSG;
    if (/wp-config\.php/.test(target)) return 'wp-config.php is off limits; it holds the site keys.';
    if (SITE_FILES.test(target) && !QA_SITE_DIR.test(target)) return 'Only the QA sites (qa-pr.rex, qa-dev.rex) may be read.';
  }
  return null;
}

// The fix agent's rules. It edits the pull request's code in its own worktree
// (workDir) and writes fix.json in its run folder (fixDir); Miu commits and
// pushes, so the agent never needs git to change anything, or a token.
const FIX_OFF_LIMITS = /(^|\/)(vendor|node_modules|\.git|\.github)(\/|$)/;
export function fixToolRule(name, input, { workDir, fixDir }) {
  const inside = (p, dir) => { const r = path.relative(dir, path.resolve(dir, p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    if (SECRETS.test(cmd)) return SECRETS_MSG;
    if (/\bgit\b[^|;&]*\b(checkout|switch|reset|clean|commit|stash|merge|rebase|pull|fetch|push|restore|am|apply|cherry-pick|worktree|remote|config|tag|branch)\b/.test(cmd)) return 'Miu commits and pushes the fix itself. Read history with git log, git show, git diff and git status; change files with Edit and Write.';
    // The site under test is reachable; nothing else is.
    const hosts = [...cmd.matchAll(/https?:\/\/([^/\s:'"]+)/g)].map((m) => m[1]);
    if (/\b(nc|ssh|scp)\b/.test(cmd) || (/\b(curl|wget)\b/.test(cmd) && (!hosts.length || hosts.some((h) => !/(^|\.)rex$|^localhost$|^127\.0\.0\.1$/.test(h))))) return 'Only the QA site (qa-fix.rex) is reachable. Work from the code, the report, the site and the checks.';
    if (SITE_FILES.test(cmd)) return 'Do not touch site folders from the shell. Use mcp__rexenv__site_wp_run on the QA site.';
    if (/(^|[\s;&|(`'"])(wp|wp-cli|mysql|mysqldump|mariadb)(\s|$)|--path=/.test(cmd)) return 'Run wp-cli on the QA site only through mcp__rexenv__site_wp_run; it is recorded as evidence.';
  }
  if (name === 'Write' || name === 'Edit') {
    const f = String(input.file_path ?? '');
    if (inside(f, fixDir)) return /(^|\/)(fix\.json|notes\.md)$/.test(f) ? null : 'In the run folder, write fix.json and notes.md only.';
    if (!inside(f, workDir)) return `Change only the pull request's code, under ${workDir}.`;
    if (FIX_OFF_LIMITS.test(path.relative(workDir, path.resolve(workDir, f)))) return 'vendor/, node_modules/, .git/ and .github/ are not part of a fix.';
  }
  if (name === 'Read' || name === 'Grep' || name === 'Glob') {
    const target = String(input.file_path ?? input.path ?? input.pattern ?? '');
    if (SECRETS.test(target)) return SECRETS_MSG;
  }
  return null;
}
