// What this Miu tests. Each repo has a test profile, profiles/<name>.json
// (MIU_PROFILES names another folder), and the repos share project.json and
// project.md beside them: the comment marker, the live hosts the agent must
// never reach, and the product's own rules. The rest of Miu names no product.
//
// A profile's role says how it pairs with the others: `main` (a plugin),
// `addon` (a plugin that runs on top of main) and `app` (a service the
// plugins talk to). Inside Miu they are the keys free, pro and hub.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILES_DIR = process.env.MIU_PROFILES ? path.resolve(process.env.MIU_PROFILES) : path.join(ROOT, 'profiles');

const ROLE = { main: 'free', addon: 'pro', app: 'hub', free: 'free', pro: 'pro', hub: 'hub' };
const ORDER = ['free', 'pro', 'hub'];
const DOCS_ONLY = '^(docs/|.*\\.md$|\\.github/)';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function profiles() {
  let files = [];
  try { files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json') && f !== 'project.json'); } catch { /* no folder yet */ }
  return files.map((f) => ({ file: f, ...readJson(path.join(PROFILES_DIR, f)) })).filter((p) => REPO_RE.test(p.repo ?? ''))
    .map((p) => ({
      kind: 'wp-plugin', base_branch: 'main', combos: ['A'], fast_checks: [], read_first: [], ...p,
      triage: { docs_only: DOCS_ONLY, ...p.triage },
      role: ROLE[p.role] ?? (p.kind === 'hub' || p.kind === 'app' ? 'hub' : 'free'), slug: p.slug ?? p.repo.split('/')[1], label: p.label ?? p.repo.split('/')[1],
    }))
    .sort((x, y) => ORDER.indexOf(x.role) - ORDER.indexOf(y.role) || x.repo.localeCompare(y.repo));
}

export const profileOf = (repo) => profiles().find((p) => p.repo.toLowerCase() === String(repo).toLowerCase()) ?? null;

// role -> { repo, label, word, slug }; `word` is how people name it in a PR
// body ("Pro #316").
export function roles() {
  const out = {};
  for (const p of profiles()) if (!out[p.role]) out[p.role] = { repo: p.repo, label: p.label, word: p.word ?? p.label, slug: p.slug };
  return out;
}

export function project() {
  const j = readJson(path.join(PROFILES_DIR, 'project.json')) ?? {};
  const first = profiles()[0]?.repo;
  return {
    name: j.name ?? 'Miu',
    owner: j.owner ?? (first ? first.split('/')[0] : null),
    // In every comment Miu posts, to find its own comments again.
    marker: /^[\w-]+$/.test(j.marker ?? '') ? j.marker : 'miu',
    cloudinary_folder: /^[\w-]+$/.test(j.cloudinary_folder ?? '') ? j.cloudinary_folder : 'miu',
    slack_channel: j.slack_channel ?? process.env.MIU_SLACK_CHANNEL ?? null,
    live_hosts: Array.isArray(j.live_hosts) ? j.live_hosts.filter((h) => typeof h === 'string') : [],
    // Folders under wp-content (and uploads/<prefix>*) a site reset removes.
    reset_dirs: Array.isArray(j.reset_dirs) ? j.reset_dirs.filter((d) => /^[\w.-]+$/.test(d)) : [],
    reset_upload_prefix: /^[\w-]+$/.test(j.reset_upload_prefix ?? '') ? j.reset_upload_prefix : null,
  };
}

// The product's rules and facts, appended to the agent's instructions.
export function projectText() {
  try { return fs.readFileSync(path.join(PROFILES_DIR, 'project.md'), 'utf8').trim(); } catch { return ''; }
}

// The plugin's main file: the profile's `main_file`, or <slug>.php.
export const mainFile = (p) => p?.main_file ?? (p?.slug ? `${p.slug}.php` : null);
