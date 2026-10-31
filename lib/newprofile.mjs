// A first test profile for a repo, read from the repo itself: its default
// branch, whether it is a WordPress plugin (a PHP file at the root with a
// "Plugin Name:" header) and which test commands it has. A person can refine
// it later; it is enough for the first run.
import fs from 'node:fs';
import path from 'node:path';
import { rest, validRepo } from './github.mjs';
import { PROFILES_DIR, profileOf } from './project.mjs';

const fileText = async (repo, name, ref) => {
  try {
    const f = await rest('GET', `repos/${repo}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(ref)}`);
    return f?.encoding === 'base64' ? Buffer.from(f.content, 'base64').toString('utf8') : null;
  } catch { return null; }
};

export async function draftProfile(repo) {
  if (!validRepo(repo)) throw new Error('Name the repo as owner/name.');
  const info = await rest('GET', `repos/${repo}`).catch((e) => {
    throw new Error(/HTTP 40[34]/.test(e.message) ? `GitHub does not show ${repo} to Miu: check the name, and that the Miu App is installed on it.` : e.message);
  });
  const branch = info.default_branch;
  const root = await rest('GET', `repos/${repo}/contents/?ref=${encodeURIComponent(branch)}`);
  const names = root.filter((f) => f.type === 'file').map((f) => f.name);
  let main = null;
  // The plugin's main file: the one WordPress reads the header from.
  for (const n of names.filter((x) => x.endsWith('.php')).sort((a, b) => (a === `${info.name}.php` ? -1 : b === `${info.name}.php` ? 1 : 0))) {
    if (/^[ \t/*#@]*Plugin Name:/im.test((await fileText(repo, n, branch))?.slice(0, 8192) ?? '')) { main = n; break; }
  }
  if (!main) throw new Error(`${repo} has no WordPress plugin header in a PHP file at its root. Miu tests WordPress plugins; write a profile by hand for anything else (docs/profiles.md).`);
  const scripts = {};
  for (const [file, key] of [['composer.json', 'composer'], ['package.json', 'npm']]) {
    if (!names.includes(file)) continue;
    try { scripts[key] = JSON.parse(await fileText(repo, file, branch) ?? '{}').scripts ?? {}; } catch { scripts[key] = {}; }
  }
  const fast_checks = [];
  if (scripts.composer?.test) fast_checks.push({ label: 'PHP tests', cmd: 'composer test', when: '\\.php$' });
  if (scripts.npm?.test) fast_checks.push({ label: 'JavaScript tests', cmd: 'npm test', when: '\\.(m?js|jsx?|tsx?)$|package(-lock)?\\.json$' });
  if (scripts.npm?.build) fast_checks.push({ label: 'build', cmd: 'npm run build', when: '\\.(m?js|jsx?|tsx?|s?css)$|package(-lock)?\\.json$' });
  return {
    repo: info.full_name,
    role: 'main',
    label: info.name,
    kind: 'wp-plugin',
    slug: info.name,
    main_file: main,
    base_branch: branch,
    combos: ['A'],
    read_first: ['README.md', 'readme.txt', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'].filter((f) => names.includes(f)),
    fast_checks,
    triage: { docs_only: '^(docs/|.*\\.md$|\\.github/)', ui: '^(src/|assets/)' },
  };
}

// Writes profiles/<name>.json; never over one that is there.
export async function addProfile(repo) {
  if (profileOf(repo)) throw new Error(`${repo} already has a test profile.`);
  const p = await draftProfile(repo);
  const file = path.join(PROFILES_DIR, `${p.repo.split('/')[1].replace(/[^\w.-]/g, '-')}.json`);
  if (fs.existsSync(file)) throw new Error(`${path.basename(file)} is taken by another repo's profile; rename one of them.`);
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n', { flag: 'wx' });
  return p;
}
