// Two QA sites in rexenv that stay up between runs, so a test starts at once:
//   qa-pr.rex    runs the pull request's code
//   qa-dev.rex   runs the base branch, for the "before" half of each claim
//   qa-fix.rex   runs a fix in progress (bin/qa-fix), so fixing never takes
//                a site a test is using
//
// Their plugin folders are symlinks into the git worktrees (lib/worktrees.mjs),
// so moving a worktree to another commit changes what the site runs. A clean
// database snapshot is taken once per site; reset() puts it back and removes
// what a test leaves on disk (drop-ins, cache folders), in about a second.
//
//   node lib/warmsites.mjs reset pr|dev|fix     clean state for the next combo
//   node lib/warmsites.mjs login pr|dev|fix     one-time wp-admin sign-in link
//   node lib/warmsites.mjs info             ids, URLs, what each site runs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withRex } from './rexmcp.mjs';
import { CACHE } from './worktrees.mjs';
import { project } from './project.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SITES = { pr: 'qa-pr.rex', dev: 'qa-dev.rex', fix: 'qa-fix.rex' };
const SITES_DIR = process.env.QA_REX_SITES ?? path.join(os.homedir(), 'rexenv', 'Sites');
const SNAP_DIR = path.join(CACHE, 'snapshots');
// The guard the sites run is a copy in the cache, beside the project's hosts:
// Miu's account may not write its own code folder on a server.
const GUARD_SRC = path.join(ROOT, 'env/rexenv/qa-network-guard');
export const GUARD = path.join(CACHE, 'qa-network-guard');

const rexCli = (args) => {
  const r = spawnSync(process.env.QA_REX_BIN ?? 'rex', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`rex ${args.join(' ')}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return r.stdout;
};

// rexenv's edge can sit off 443 (a server where another web server holds it),
// and then every site URL carries the port. An older rexenv cannot say: 443.
let httpsPort;
const siteUrl = (domain) => {
  if (httpsPort === undefined) { try { httpsPort = Number(rexCli(['config', 'get', 'edge_https_port']).trim()) || 443; } catch { httpsPort = 443; } }
  return httpsPort === 443 ? `https://${domain}` : `https://${domain}:${httpsPort}`;
};

async function siteRecord(rex, domain) {
  const listed = await rex.call('list_sites');
  return (Array.isArray(listed) ? listed : listed.sites ?? []).find((s) => s.domain === domain) ?? null;
}

async function wp(rex, id, args) {
  const r = await rex.call('site_wp_run', { site_id: id, args });
  // rexenv's wp-cli reports "Could not open input file: <home>/Library/Application"
  // after a rewrite flush (an unquoted path with a space); wp-cli itself said Success.
  const okAnyway = /^Success:/m.test(r.stdout || '') && /Could not open input file/.test(r.stderr || '');
  if (!r.succeeded && !okAnyway) throw new Error(`wp ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout;
}

const pluginsDir = (domain) => path.join(SITES_DIR, domain, 'wp-content', 'plugins');

// Point a site's plugin folders at worktrees (null removes the plugin).
export function mount(which, plugins) {
  const dir = pluginsDir(SITES[which]);
  for (const [slug, target] of Object.entries(plugins)) {
    const link = path.join(dir, slug);
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { recursive: true, force: true });
    if (target) fs.symlinkSync(target, link);
  }
  // A link left from another checkout path dangles: existsSync is false for it, so check the link itself.
  const guard = path.join(dir, 'qa-network-guard');
  writeGuardHosts();
  let target = null; try { target = fs.readlinkSync(guard); } catch { /* none, or not a link */ }
  if (target !== GUARD) { fs.rmSync(guard, { recursive: true, force: true }); fs.symlinkSync(GUARD, guard); }
}

// The guard plugin and the project's live hosts for it to refuse (project.json).
export function writeGuardHosts() {
  fs.mkdirSync(GUARD, { recursive: true });
  const sync = (f, want) => { let have = null; try { have = fs.readFileSync(f, 'utf8'); } catch { /* first time */ } if (have !== want) fs.writeFileSync(f, want); };
  sync(path.join(GUARD, 'qa-network-guard.php'), fs.readFileSync(path.join(GUARD_SRC, 'qa-network-guard.php'), 'utf8'));
  sync(path.join(GUARD, 'hosts.txt'), project().live_hosts.map((h) => h.replace(/^\*\./, '')).join('\n') + '\n');
}

// Create the sites and their snapshots on first use; later calls only check.
// which: the sites a run needs (a test: pr and dev; a fix: fix).
export async function ensureSites(log = () => {}, wanted = ['pr', 'dev']) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  return withRex(async (rex) => {
    const out = {};
    for (const [which, domain] of Object.entries(SITES).filter(([w]) => wanted.includes(w))) {
      let rec = await siteRecord(rex, domain);
      if (!rec) {
        log(`rexenv: creating ${domain}`);
        rexCli(['site', 'create', domain, '--type', 'wordpress', '--php', '8.3', '--server', 'nginx', '--db', 'mysql']);
        rec = await siteRecord(rex, domain);
      }
      mount(which, {});
      const snap = path.join(SNAP_DIR, `${domain}.sql`);
      if (!fs.existsSync(snap)) {
        // The clean state every combo starts from: WordPress, debug logging,
        // pretty permalinks, and only the network guard active.
        await wp(rex, rec.id, ['config', 'set', 'WP_DEBUG', 'true', '--raw']);
        await wp(rex, rec.id, ['config', 'set', 'WP_DEBUG_LOG', 'true', '--raw']);
        await wp(rex, rec.id, ['config', 'set', 'WP_DEBUG_DISPLAY', 'false', '--raw']);
        await wp(rex, rec.id, ['rewrite', 'structure', '/%postname%/']);
        await wp(rex, rec.id, ['plugin', 'deactivate', '--all']);
        await wp(rex, rec.id, ['plugin', 'activate', 'qa-network-guard']);
        await wp(rex, rec.id, ['db', 'export', snap]);
        log(`rexenv: clean snapshot saved for ${domain}`);
      }
      out[which] = { id: rec.id, domain, url: siteUrl(domain), snapshot: snap };
    }
    let all = {}; try { all = JSON.parse(fs.readFileSync(path.join(CACHE, 'sites.json'), 'utf8')); } catch { /* first time */ }
    fs.writeFileSync(path.join(CACHE, 'sites.json'), JSON.stringify({ ...all, ...out }, null, 2));
    return out;
  });
}

// Back to the clean snapshot, and remove what a test can leave on disk.
export async function reset(which) {
  const domain = SITES[which];
  const content = path.join(SITES_DIR, domain, 'wp-content');
  for (const f of ['advanced-cache.php', 'object-cache.php', 'db.php', 'debug.log', 'qa-blocked-http.log']) fs.rmSync(path.join(content, f), { force: true });
  const proj = project();
  for (const d of ['cache', 'upgrade', ...proj.reset_dirs]) fs.rmSync(path.join(content, d), { recursive: true, force: true });
  // The fix site starts each replay from nothing a fix agent left: its probe's
  // setup has to make what the steps need, so Miu can replay it on its own.
  if (which === 'fix') fs.rmSync(path.join(content, 'mu-plugins'), { recursive: true, force: true });
  for (const d of fs.existsSync(path.join(content, 'uploads')) ? fs.readdirSync(path.join(content, 'uploads')) : []) {
    if (proj.reset_upload_prefix && d.startsWith(proj.reset_upload_prefix)) fs.rmSync(path.join(content, 'uploads', d), { recursive: true, force: true });
  }
  return withRex(async (rex) => {
    const rec = await siteRecord(rex, domain);
    const snap = path.join(SNAP_DIR, `${domain}.sql`);
    // wp db import fails under rexenv's MySQL 9 client (it rejects SOURCE);
    // rexenv's own importer does the same job in a few hundred milliseconds.
    rexCli(['db', 'import', domain, snap, '--yes']);
    // WP_CACHE is written by the page cache; the snapshot does not cover wp-config.
    await wp(rex, rec.id, ['config', 'delete', 'WP_CACHE']).catch(() => {});
    await wp(rex, rec.id, ['cache', 'flush']).catch(() => {});
    return { domain, id: rec.id, url: siteUrl(domain) };
  });
}

// wp-config constants that outlive reset() (the snapshot is the database
// only). A value of null removes the constant.
export async function setConstants(which, consts) {
  return withRex(async (rex) => {
    const rec = await siteRecord(rex, SITES[which]);
    for (const [name, value] of Object.entries(consts)) {
      if (value === null) await wp(rex, rec.id, ['config', 'delete', name]).catch(() => {});
      else await wp(rex, rec.id, ['config', 'set', name, String(value), ...(typeof value === 'boolean' ? ['--raw'] : [])]);
    }
  });
}

export async function loginUrl(which) {
  return withRex(async (rex) => {
    const rec = await siteRecord(rex, SITES[which]);
    const r = await rex.call('wp_user', { site_id: rec.id, action: 'login_url' });
    return r.result?.loginUrl ?? r.loginUrl ?? r.url ?? JSON.stringify(r);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, which] = process.argv.slice(2);
  const t0 = Date.now();
  const done = (o) => { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); };
  try {
    if (cmd === 'reset' && SITES[which]) done({ ...(await reset(which)), reset_ms: Date.now() - t0 });
    else if (cmd === 'login' && SITES[which]) done(await loginUrl(which));
    else if (cmd === 'info') done(JSON.parse(fs.readFileSync(path.join(CACHE, 'sites.json'), 'utf8')));
    else if (cmd === 'ensure') done(await ensureSites(console.log, which ? [which] : undefined));
    else { console.error('usage: warmsites.mjs reset|login pr|dev|fix, or info, or ensure'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
