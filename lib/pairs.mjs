// Pull requests that belong together across the profiles' repos (a plugin,
// its add-on, the app they talk to), so one run tests them as a pair: the PR
// side of the QA sites runs every PR of the pair and talks to the PR app, the
// dev side runs dev everywhere.
//
// Two PRs are a pair when, both open:
//   - their head branches have the same name, or
//   - one's body names the other: a GitHub link, "owner/repo#478", or the
//     short form with the profile's word ("Hub #478", "Pro PR #316").
// The body of either side counts, so a Hub PR that never names the Pro PR is
// still found from the Pro PR's body.
import { restAll, validRepo } from './github.mjs';
import { roles } from './project.mjs';

export const roleOf = (repo) => { const r = roles(); return Object.keys(r).find((k) => r[k].repo === repo) ?? null; };

// Numbers of `target`'s PRs that `body` names.
export function namedIn(body = '', target) {
  const t = roles()[target];
  if (!t) return [];
  const name = t.repo.replace('/', '\\/');
  const out = new Set();
  const res = [
    new RegExp(`github\\.com\\/${name}\\/pull\\/(\\d+)`, 'gi'),
    // "owner/plugin#1" must not match inside "owner/plugin-pro#1".
    new RegExp(`(?<![\\w/-])${name}#(\\d+)`, 'gi'),
    new RegExp(`\\b${t.word}(?:\\s+PR)?\\s*#(\\d+)`, 'gi'),
  ];
  for (const re of res) for (const m of body.matchAll(re)) out.add(Number(m[1]));
  return [...out];
}

const openList = new Map(); // repo -> { at, list }
async function openPulls(repo) {
  const hit = openList.get(repo);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.list;
  const list = (await restAll(`repos/${repo}/pulls?state=open`, { max: 300 })).map((p) => ({
    number: p.number, title: p.title, body: p.body ?? '', headRefName: p.head?.ref, headRefOid: p.head?.sha, url: p.html_url, state: 'OPEN', isDraft: !!p.draft,
  }));
  openList.set(repo, { at: Date.now(), list });
  return list;
}

// { free?, pro?, hub? } for the PR, without its own role. Each entry:
// { role, repo, label, number, title, headRefName, headRefOid, url, how }.
export async function findPartners(repo, prData) {
  if (!validRepo(repo)) throw new Error('not a repo name');
  const self = roleOf(repo);
  const out = {};
  if (!self) return out;
  const all = roles();
  for (const role of Object.keys(all).filter((r) => r !== self)) {
    const t = all[role];
    const open = await openPulls(t.repo);
    const named = namedIn(prData.body, role);
    const tries = [
      ['same branch name', (p) => p.headRefName === prData.headRefName && !['dev', 'main', 'master'].includes(p.headRefName)],
      ["named in this PR's body", (p) => named.includes(p.number)],
      ['its body names this PR', (p) => namedIn(p.body, self).includes(prData.number)],
    ];
    for (const [how, test] of tries) {
      const p = open.find(test);
      if (p) { out[role] = { role, repo: t.repo, label: t.label, ...p, body: undefined, how }; break; }
    }
  }
  return out;
}

export const keyOf = (p) => `${p.repo}#${p.number}`;

// The pair of an open PR, from the open-PR lists alone (the dashboard asks
// this before it queues a PR).
export async function partnersOf(repo, number) {
  const self = (await openPulls(repo)).find((p) => p.number === number);
  return self ? findPartners(repo, self) : {};
}
