// The fix agent's rules: what in a report it may fix, what a fix may change,
// and what its commit may say. bin/qa-fix runs it; bin/qa-dashboard decides
// when.
//
// A fix goes onto the pull request's own branch, so the author does not wait
// for Miu: Miu finds the problem, fixes it, and tests the new commit. Nothing
// is forced: the push is a plain one, and GitHub refuses it if the branch moved
// since the test, so a person's newer commit always wins.
import path from 'node:path';

// Verdicts with something to fix. OK has only minor issues (if any), and the
// rest (no result, already fixed) have nothing a code change would settle.
export const FIXABLE_VERDICTS = ['not_ok', 'partial'];
// Automatic fix rounds per pull request, counted since the last commit a
// person pushed: after that, the author decides.
export const AUTO_ROUNDS = 2;
// A bigger change than this is kept as a patch for a person to look at.
export const MAX_LINES = 600;

// What the report asks to fix: confirmed blocker and major issues, broken
// business rules, and failed claims. Minor issues, unconfirmed leads and
// claims Miu could not prove stay with the author.
export function findings(results) {
  const out = [];
  for (const i of results.issues ?? []) {
    if (i.unconfirmed || !['blocker', 'major'].includes(i.severity)) continue;
    out.push({ kind: i.kind === 'business' ? 'rule' : 'issue', severity: i.severity, title: i.title, detail: [i.user_impact, i.claim_broken && `Claim it breaks: ${i.claim_broken}`, i.expected && `Expected: ${i.expected}`, i.actual && `Actual: ${i.actual}`, i.rule && `Rule: ${i.rule}`].filter(Boolean).join('\n'), steps: i.steps ?? [], code_ref: i.code_ref ?? null, suggested_fix: i.suggested_fix ?? null });
  }
  for (const b of results.business ?? []) {
    if (b.status !== 'conflicts' || out.some((f) => f.kind === 'rule' && f.detail.includes(b.rule))) continue;
    out.push({ kind: 'rule', severity: 'blocker', title: `Breaks: ${b.rule}`, detail: b.where ?? '', steps: [], code_ref: null, suggested_fix: null });
  }
  for (const c of results.criteria ?? []) {
    const failed = Object.entries(c.results ?? {}).filter(([, v]) => v.status === 'fail');
    if (!failed.length) continue;
    out.push({ kind: 'claim', severity: 'major', title: `Claim ${c.id} fails: ${c.claim}`, detail: failed.map(([col, v]) => `${col}: ${v.note ?? 'failed'}`).join('\n'), steps: [], code_ref: null, suggested_fix: null });
  }
  return out.map((f, k) => ({ id: `F${k + 1}`, ...f }));
}

// The findings as the agent reads them.
export function findingsMd(list) {
  return list.map((f) => [
    `## ${f.id}. ${f.title}`,
    `${f.kind === 'claim' ? 'Failed claim' : f.kind === 'rule' ? 'Project rule' : f.severity === 'blocker' ? 'Blocker' : 'Major issue'}`,
    f.detail,
    f.steps.length ? `Steps:\n${f.steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}` : '',
    f.code_ref ? `Where: \`${f.code_ref}\`` : '',
    f.suggested_fix ? `The tester suggested: ${f.suggested_fix}` : '',
  ].filter(Boolean).join('\n\n')).join('\n\n');
}

// Paths a fix may not change: dependencies, build output owned by tools, the
// CI that checks it, and git itself.
const OFF_LIMITS = /^(vendor|node_modules|\.git|\.github)\//;
// The version lives in a few headers and changes only at release.
const VERSION_LINE = /^[+-]\s*(\*\s*)?(Version:|Stable tag:|define\(\s*'XSPEED(_PRO)?_VERSION'|"version":)/m;

// Whether a change may be pushed. files: [{ path, added, removed }] from
// git diff --numstat; patch: the whole diff. Returns the reasons it may not.
export function checkChange(files, patch = '') {
  const why = [];
  if (!files.length) return ['the agent changed no files'];
  const bad = files.filter((f) => OFF_LIMITS.test(f.path) || path.isAbsolute(f.path) || f.path.split('/').includes('..'));
  if (bad.length) why.push(`it changes files a fix may not touch: ${bad.map((f) => f.path).slice(0, 5).join(', ')}`);
  const lines = files.reduce((n, f) => n + (f.added || 0) + (f.removed || 0), 0);
  if (lines > MAX_LINES) why.push(`it changes ${lines} lines, more than the ${MAX_LINES} a fix may change without a person`);
  if (VERSION_LINE.test(patch)) why.push('it changes a version number, which changes only at release');
  return why;
}

// The commit message: the agent's subject and body, without any line that
// names a model, a tool or AI (the repos do not allow it), and without
// trailers the agent might add.
const NAMES = /\b(claude|anthropic|codex|openai|chatgpt|gpt-?\d|llm|ai|a\.i\.|artificial intelligence|generated (by|with)|co-authored-by)\b/i;
export function commitMessage(agent, list, { round, sha }) {
  const keep = (s) => String(s ?? '').split('\n').filter((l) => !NAMES.test(l)).join('\n').trim();
  let subject = keep(agent?.subject).split('\n')[0].slice(0, 72);
  if (!subject) subject = list.length === 1 ? `Fix: ${list[0].title}`.slice(0, 72) : `Fix ${list.length} problems found in QA round ${round}`;
  const body = keep(agent?.body);
  const fixed = list.length ? `Fixes what Miu found at ${sha.slice(0, 7)}:\n${list.map((f) => `- ${f.title}`).join('\n')}` : '';
  return [subject, body, fixed].filter(Boolean).join('\n\n') + '\n';
}

// Which findings the agent says it fixed, matched to the list by id.
// With a site, a fix counts only when Miu's own replay of its probe showed
// the problem on the original code and not on the fix (proven: id -> true, or
// the reason it did not hold). The agent's evidence ids are kept for the record.
export function outcome(agent, list, { site = false, proven = () => true } = {}) {
  const ids = new Set(list.map((f) => f.id));
  const claimed = (agent?.fixed ?? []).filter((x) => ids.has(x.id));
  const unproven = new Map();
  const fixed = claimed.filter((x) => {
    if (!site) return true;
    const r = proven(x.id);
    if (r !== true) { unproven.set(x.id, `the fix was not proven: ${r}`); return false; }
    return true;
  });
  const done = new Set(fixed.map((x) => x.id));
  const left = list.filter((f) => !done.has(f.id)).map((f) => ({ id: f.id, title: f.title, why: unproven.get(f.id) ?? (agent?.not_fixed ?? []).find((x) => x.id === f.id)?.why ?? 'not attempted' }));
  const ev = (xs) => (Array.isArray(xs) ? xs.filter((x) => /^ev-\d+$/.test(x)) : []);
  return {
    fixed: fixed.map((x) => ({ id: x.id, title: list.find((f) => f.id === x.id).title, how: String(x.how ?? '').slice(0, 400), ...(site ? { before: ev(x.before), after: ev(x.after) } : {}) })),
    left,
  };
}

// The branch may take a pushed fix: in the repo itself (Miu cannot push to a
// fork) and not one of the long-lived branches.
const PROTECTED = new Set(['main', 'master', 'dev', 'develop', 'trunk']);
export function branchProblem(pr, repo) {
  if (pr.headRepo && pr.headRepo.toLowerCase() !== repo.toLowerCase()) return `the branch is in a fork (${pr.headRepo}), where Miu cannot push`;
  if (!pr.headRefName || PROTECTED.has(pr.headRefName) || pr.headRefName === pr.baseRefName) return `the branch is ${pr.headRefName || 'unknown'}, which a fix never goes onto`;
  return null;
}

// A probe: how Miu itself checks one fix on the fix site, without taking the
// agent's word. It resets the site, runs the setup (wp-cli through rexenv),
// then one check: a page fetched from the site, or a wp-cli command. On the
// original code `expect` must not match; with the fix it must.
//   { "setup": [["option", "update", "x", "1"]], "http": { "path": "/p/", "headers": { "Accept": "image/webp" } }, "expect": "imagesrcset=" }
//   { "setup": [], "wp": ["eval", "echo has_filter('x') ? 'yes' : 'no';"], "expect": "^yes" }
//   { "same_as": "F2" }
// Returns { probe } or { error }.
export function checkProbe(p) {
  if (!p || typeof p !== 'object') return { error: 'no probe' };
  if (p.same_as) return /^F\d+$/.test(String(p.same_as)) ? { probe: { same_as: String(p.same_as) } } : { error: 'same_as names no finding' };
  const setup = Array.isArray(p.setup) ? p.setup : [];
  if (setup.length > 40 || setup.some((a) => !Array.isArray(a) || !a.length || a.some((x) => typeof x !== 'string'))) return { error: 'setup must be wp-cli argument lists (at most 40)' };
  if (setup.some((a) => ['db', 'config', 'shell', 'package', 'core', 'site', 'server'].includes(a[0]) || a.some((x) => /^--(path|ssh|http|url)=?/.test(x)))) return { error: 'setup may not use wp db, config, shell, package, core, site or server, or point wp-cli elsewhere' };
  let re;
  try { re = new RegExp(String(p.expect ?? ''), 'm'); } catch { return { error: 'expect is not a regular expression' }; }
  if (!p.expect) return { error: 'no expect' };
  if (p.http) {
    const pth = String(p.http.path ?? '');
    if (!pth.startsWith('/') || pth.startsWith('//') || /\s/.test(pth)) return { error: 'http.path must be a path on the site, starting with /' };
    const headers = Object.entries(p.http.headers ?? {}).filter(([k, v]) => /^[A-Za-z0-9-]{1,40}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)).slice(0, 10);
    return { probe: { setup, http: { path: pth, headers: Object.fromEntries(headers) }, expect: String(p.expect), re } };
  }
  if (Array.isArray(p.wp) && p.wp.length && p.wp.every((x) => typeof x === 'string') && !['db', 'config', 'shell'].includes(p.wp[0])) return { probe: { setup, wp: p.wp, expect: String(p.expect), re } };
  return { error: 'a probe needs http or wp' };
}
