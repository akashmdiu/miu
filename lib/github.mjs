// Miu's one way to talk to GitHub: REST and GraphQL over HTTPS, no gh CLI
// needed. Which token it uses, in order:
//   1. the Miu GitHub App's installation token for the repo's owner (the
//      production path; writes show as the App)
//   2. GITHUB_TOKEN from the environment
//   3. a person's token saved under AI connections (sealed, lib/connections.mjs)
//   4. only on a developer machine: the local `gh auth token`
// When the App gets 403 or 404 (it is not installed on that repo), the call is
// made again once with 2-4, so a repo the App cannot see still works.
// Tokens are never logged, never put on a command line, never sent to a page.
import { execFileSync } from 'node:child_process';
import { installationToken } from './ghapp.mjs';
import { readSecret } from './connections.mjs';

const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const validRepo = (r) => typeof r === 'string' && REPO_RE.test(r);
const assertRepo = (r) => { if (!validRepo(r)) throw new Error(`not a repo name: ${String(r).slice(0, 60)}`); return r; };
const assertNum = (n) => { const v = Number(n); if (!Number.isInteger(v) || v < 1) throw new Error(`not a number: ${String(n).slice(0, 20)}`); return v; };

let localToken; // undefined: not looked up yet; null: none
function fallbackToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const saved = readSecret('github', 'token');
  if (saved) return saved;
  if (localToken === undefined) {
    try { localToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim() || null; }
    catch { localToken = null; }
  }
  return localToken;
}

// { token, kind: 'app' | 'env' | 'local' } for a repo (or an owner).
export async function tokenFor(repoOrOwner, { fallback = false } = {}) {
  const owner = String(repoOrOwner || '').split('/')[0];
  // fallback: a comment can only be edited by whoever wrote it, so editing one
  // posted before the App was installed has to use the old account.
  const app = owner && !fallback ? await installationToken(owner).catch(() => null) : null;
  if (app) return { token: app, kind: 'app' };
  const t = fallbackToken();
  if (!t) throw new Error('No GitHub access: install the Miu App on the org, or set GITHUB_TOKEN');
  return { token: t, kind: process.env.GITHUB_TOKEN ? 'env' : 'local' };
}

const TRANSIENT = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|UND_ERR|socket|fetch failed|network/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(owner, method, url, { body, accept = 'application/vnd.github+json', raw = false, fallback = false, token: given = null } = {}) {
  // token: a given token (the collaborator's own sign-in, lib/ghuser.mjs), used as is.
  const { token, kind } = given ? { token: given, kind: 'given' } : await tokenFor(owner, { fallback });
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'miu', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      if (attempt < 4 && (TRANSIENT.test(String(e.cause?.code || e.message)) || e.name === 'TimeoutError')) { await sleep(2000 * attempt); continue; }
      throw new Error(`GitHub ${method} ${url.replace(API, '')}: ${e.message}`);
    }
    // Server hiccups and the secondary rate limit are retried; the rest is final.
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    if (attempt < 4 && (res.status >= 502 || (res.status === 403 && retryAfter))) { await sleep(Math.min(30000, (retryAfter || 2 * attempt) * 1000)); continue; }
    if (res.status === 204) return null;
    const text = await res.text();
    // The App is not installed on this repo: once more with the person's token.
    if ((res.status === 404 || res.status === 403) && kind === 'app' && !fallback && fallbackToken()) return call(owner, method, url, { body, accept, raw, fallback: true });
    if (!res.ok) throw new Error(`GitHub ${method} ${url.replace(API, '')}: HTTP ${res.status} ${text.slice(0, 200)}`);
    if (raw) return text;
    const json = text ? JSON.parse(text) : null;
    return attempt && res.headers.get('link') ? Object.assign(json, { [LINK]: res.headers.get('link') }) : json;
  }
}
const LINK = Symbol('link');

// REST. path is "repos/{owner}/{name}/..." (the owner picks the token).
export function rest(method, path, opts = {}) {
  const owner = path.match(/^(?:repos|orgs)\/([^/]+)/)?.[1] ?? '';
  return call(owner, method, `${API}/${path}`, opts);
}
// Every page of a list endpoint.
export async function restAll(path, { max = 1000 } = {}) {
  const owner = path.match(/^(?:repos|orgs)\/([^/]+)/)?.[1] ?? '';
  const out = [];
  let url = `${API}/${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url && out.length < max) {
    const page = await call(owner, 'GET', url);
    out.push(...page);
    url = page[LINK]?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return out;
}
// GraphQL with variables (never string-built from outside input).
export async function graphql(query, variables = {}, owner = variables.owner ?? '') {
  const r = await call(owner, 'POST', `${API}/graphql`, { body: { query, variables } });
  if (r?.errors?.length && !r.data) throw new Error(`GitHub GraphQL: ${r.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return r.data;
}

// ---- shapes the rest of Miu uses (the same fields `gh --json` gave).

export async function openPrs(repo) {
  assertRepo(repo);
  const list = await restAll(`repos/${repo}/pulls?state=open&sort=updated&direction=desc`, { max: 200 });
  return list.map((p) => ({
    number: p.number, title: p.title, author: { login: p.user?.login }, headRefOid: p.head?.sha, headRefName: p.head?.ref,
    isDraft: !!p.draft, updatedAt: p.updated_at, createdAt: p.created_at, url: p.html_url, labels: (p.labels ?? []).map((l) => ({ name: l.name })),
  }));
}

export async function getPr(repo, n) {
  assertRepo(repo); n = assertNum(n);
  const [owner, name] = repo.split('/');
  const [p, files, comments, gq] = await Promise.all([
    rest('GET', `repos/${repo}/pulls/${n}`),
    restAll(`repos/${repo}/pulls/${n}/files`, { max: 3000 }),
    restAll(`repos/${repo}/issues/${n}/comments`),
    graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
      closingIssuesReferences(first: 20) { nodes { number repository { name owner { login } } } } } } }`, { owner, name, n }),
  ]);
  return {
    number: p.number, title: p.title, body: p.body ?? '', author: { login: p.user?.login }, headRefName: p.head?.ref, headRefOid: p.head?.sha, headRepo: p.head?.repo?.full_name ?? null,
    baseRefName: p.base?.ref, labels: (p.labels ?? []).map((l) => ({ name: l.name })), isDraft: !!p.draft, url: p.html_url,
    mergeable: p.mergeable === true ? 'MERGEABLE' : p.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    files: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })),
    comments: comments.map((c) => ({ author: { login: c.user?.login }, body: c.body ?? '', createdAt: c.created_at, url: c.html_url })),
    closingIssuesReferences: gq.repository.pullRequest.closingIssuesReferences.nodes.map((i) => ({ number: i.number, repository: { name: i.repository.name, owner: { login: i.repository.owner.login } } })),
  };
}

export const prMergeable = async (repo, n) => {
  const p = await rest('GET', `repos/${assertRepo(repo)}/pulls/${assertNum(n)}`);
  return p.mergeable === true ? 'MERGEABLE' : p.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
};

// GitHub refuses the whole diff of a PR with more than 300 files (HTTP 406),
// so a big PR's diff is put together from the per-file patches instead. Files
// GitHub sends no patch for (binary or too large) are listed by name.
export async function prDiff(repo, n) {
  assertRepo(repo); n = assertNum(n);
  try {
    return await rest('GET', `repos/${repo}/pulls/${n}`, { accept: 'application/vnd.github.v3.diff', raw: true });
  } catch (e) {
    if (!/HTTP 406/.test(e.message)) throw e;
    const files = await restAll(`repos/${repo}/pulls/${n}/files`, { max: 3000 });
    return files.map((f) => {
      const a = f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`;
      const b = f.status === 'removed' ? '/dev/null' : `b/${f.filename}`;
      const head = `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}\n--- ${a}\n+++ ${b}\n`;
      return head + (f.patch ? f.patch + '\n' : `(no patch from GitHub: ${f.status}, +${f.additions} -${f.deletions})\n`);
    }).join('');
  }
}

export async function getIssue(repo, n) {
  assertRepo(repo); n = assertNum(n);
  const [owner, name] = repo.split('/');
  const d = await graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) {
    number title body url state stateReason closedAt labels(first: 30) { nodes { name } }
    comments(last: 50) { nodes { author { login } body createdAt } }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number url title } } } } }`, { owner, name, n });
  const i = d.repository.issue;
  if (!i) throw new Error('not an issue');
  return { ...i, labels: i.labels.nodes, comments: i.comments.nodes, closedByPullRequestsReferences: i.closedByPullRequestsReferences.nodes };
}

// Open PRs in a repo whose head branch is this name.
export async function prsForBranch(repo, branch) {
  assertRepo(repo);
  const owner = repo.split('/')[0];
  const list = await restAll(`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, { max: 20 });
  return list.map((p) => ({ number: p.number, headRefName: p.head?.ref, headRefOid: p.head?.sha, url: p.html_url, title: p.title, state: 'OPEN' }));
}
export async function prBasic(repo, n) {
  const p = await rest('GET', `repos/${assertRepo(repo)}/pulls/${assertNum(n)}`);
  return { number: p.number, headRefName: p.head?.ref, headRefOid: p.head?.sha, url: p.html_url, title: p.title, state: p.state === 'open' ? 'OPEN' : 'CLOSED' };
}

// Git over HTTPS with the token in the environment (GIT_CONFIG_*), so it is
// not visible in a process list the way a URL or -c flag would be.
// Composer reaches private GitHub packages (a licensing library) with the
// same App token git uses. A package in a repo the App is not installed on
// still fails, with GitHub's 404.
export async function composerAuthEnv(repo, { fallback = false } = {}) {
  const { token } = await tokenFor(repo, { fallback });
  return { COMPOSER_AUTH: JSON.stringify({ 'github-oauth': { 'github.com': token } }) };
}

export async function gitAuthEnv(repo, { fallback = false } = {}) {
  const { token } = await tokenFor(repo, { fallback });
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`, GIT_TERMINAL_PROMPT: '0' };
}
