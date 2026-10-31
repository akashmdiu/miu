// Publishing for a finished run. Everything that writes outside the runner
// lives here and runs after the agent has exited, with tokens the agent never
// saw (bin/qa-run strips them from the agent's environment).
import fs from 'node:fs';
import { readSecret } from './connections.mjs';
import path from 'node:path';
import { rest, restAll, validRepo } from './github.mjs';
import { collaborator } from './ghuser.mjs';
import { project } from './project.mjs';
import crypto from 'node:crypto';

// ---- Cloudinary (screenshots). CLOUDINARY_URL=cloudinary://key:secret@cloud
// Looked up the way the cloudinary-uploader skill does: the environment, then
// a CLOUDINARY_URL= line in ~/.zshrc, ~/.bashrc, ~/.profile, ~/.env or
// ~/.cloudinary. The files are read, never sourced.
export function cloudinaryUrl() {
  if (process.env.CLOUDINARY_URL) return process.env.CLOUDINARY_URL;
  // A server keeps it sealed with the other keys (lib/connections.mjs).
  const saved = readSecret('cloudinary', 'url');
  if (saved) return saved;
  const home = process.env.HOME ?? '';
  for (const f of ['.zshrc', '.bashrc', '.profile', '.env', '.cloudinary']) {
    try {
      const line = fs.readFileSync(path.join(home, f), 'utf8').split('\n').find((l) => /^\s*(export\s+)?CLOUDINARY_URL=/.test(l));
      if (line) return line.replace(/^\s*(export\s+)?CLOUDINARY_URL=/, '').trim().replace(/^['"]|['"]$/g, '');
    } catch { /* no such file */ }
  }
  return null;
}

export async function uploadImage(file, publicIdPrefix) {
  const u = cloudinaryUrl();
  if (!u) return null;
  const { username: key, password: secret, hostname: cloud } = new URL(u);
  const timestamp = Math.floor(Date.now() / 1000);
  const public_id = `${publicIdPrefix}-${path.basename(file, path.extname(file))}`;
  const folder = project().cloudinary_folder;
  // Stored small: WebP, at most 1600 px wide, automatic quality. The free plan's
  // credits are shared by storage and every view of every image.
  const transformation = 'c_limit,w_1600/f_webp,q_auto';
  const toSign = `folder=${folder}&public_id=${public_id}&timestamp=${timestamp}&transformation=${transformation}${decodeURIComponent(secret)}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  const form = new FormData();
  form.set('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  form.set('api_key', decodeURIComponent(key));
  form.set('timestamp', String(timestamp));
  form.set('public_id', public_id);
  form.set('folder', folder);
  form.set('transformation', transformation);
  form.set('signature', signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()).secure_url;
}

// An image a report shows that has no public address (not saved, not
// uploaded, no Cloudinary) becomes a note in its place, so a post never fails
// over an image. why(file) gives the reason for each one.
const LOCAL_IMG = /!?\[([^\]]*)\]\(((?!https?:)[^)\s]*\.(?:png|jpe?g|webp|gif))\)/gi;
export function noteLocalImages(text, why) {
  return text.replace(LOCAL_IMG, (all, alt, ref) => `_(screenshot ${path.basename(ref)} not attached: ${why(path.basename(ref))}${alt ? `; ${alt}` : ''})_`);
}

// Replace evidence ids used as images (before/after tables) with public URLs.
// Without Cloudinary the cell says where to find the file instead.
// upload false (a dry run): the image stays here as evidence/<file>, which
// posting later uploads (lib/postrun.mjs).
export async function resolveImages(results, runDir, ledger, prefix, { upload = true } = {}) {
  const cache = new Map();
  const resolve = async (ref) => {
    if (!ref || /^https?:\/\//.test(ref)) return ref;
    if (cache.has(ref)) return cache.get(ref);
    const row = ledger.get(ref);
    const file = row ? path.join(runDir, 'evidence', row.file) : path.join(runDir, ref);
    let url = null;
    if (upload && fs.existsSync(file)) {
      try { url = await uploadImage(file, prefix); } catch (e) { console.error(String(e)); }
    }
    const out = url ?? (row && fs.existsSync(file) ? `evidence/${row.file}` : `${ref}`);
    cache.set(ref, out);
    return out;
  };
  for (const i of results.issues ?? []) {
    if (i.before_after?.images) i.before_after.images = await Promise.all(i.before_after.images.map(resolve));
  }
  return results;
}

// ---- agent-notes over MCP streamable HTTP (full reports).
async function mcpCall(endpoint, token, tool, args) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  const post = async (body, session) => {
    const res = await fetch(endpoint, { method: 'POST', headers: session ? { ...headers, 'Mcp-Session-Id': session } : headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`agent-notes ${body.method}: HTTP ${res.status} ${text.slice(0, 300)}`);
    const json = text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
    return { session: res.headers.get('mcp-session-id') ?? session, msg: json ? JSON.parse(json) : null };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'miu', version: '1' } } });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.session).catch(() => {});
  const { msg } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, init.session);
  if (msg?.error) throw new Error(`agent-notes ${tool}: ${msg.error.message}`);
  const text = (msg?.result?.content ?? []).map((c) => c.text).join('\n');
  if (msg?.result?.isError) throw new Error(`agent-notes ${tool}: ${text}`);
  return text;
}

export async function publishFullReport({ title, markdown, slug }) {
  const endpoint = process.env.AGENT_NOTES_MCP_URL;
  const token = process.env.AGENT_NOTES_TOKEN;
  if (!endpoint || !token) return null;
  const text = slug
    ? await mcpCall(endpoint, token, 'update_note', { slug, title, content: markdown })
    : await mcpCall(endpoint, token, 'create_note', { title, content: markdown });
  const url = text.match(/https?:\/\/\S+\/n\/[A-Za-z0-9_-]+/)?.[0];
  if (!url && slug) return { url: `${new URL(endpoint).origin}/n/${slug}`, slug };
  if (!url) throw new Error(`agent-notes returned no URL: ${text.slice(0, 200)}`);
  return { url, slug: url.split('/n/')[1] };
}

// ---- GitHub (comment + commit status), through lib/github.mjs: the Miu App's
// token when it is installed, with retries on network hiccups.
// Miu finds its own comments by this marker (project.json `marker`).
const M = project().marker;
const MARKER = (pr) => `<!-- ${M} pr=${pr} -->`;
const num = (n) => { const v = Number(n); if (!Number.isInteger(v) || v < 1) throw new Error('not a PR number'); return v; };
const repoOk = (r) => { if (!validRepo(r)) throw new Error('not a repo name'); return r; };

export async function previousRuns(repo, pr) {
  const all = await restAll(`repos/${repoOk(repo)}/issues/${num(pr)}/comments`);
  return all.filter((c) => (c.body ?? '').includes(MARKER(pr))).map((c) => ({
    id: c.id, body: c.body, html_url: c.html_url, author: c.user?.login ?? null,
    sha: c.body.match(new RegExp(`<!-- ${M}-sha=([0-9a-f]+) -->`))?.[1],
    round: Number(c.body.match(new RegExp(`<!-- ${M}-round=(\\d+) -->`))?.[1] ?? 1),
    noteSlug: c.body.match(new RegExp(`<!-- ${M}-note=([A-Za-z0-9_-]+) -->`))?.[1],
  }));
}

// One comment per round, as the team does it. A rerun at the same sha edits
// that round's comment; a new sha posts a new comment and folds the old one.
export async function postComment({ repo, pr, sha, round, body, noteSlug }) {
  const meta = `${MARKER(pr)}\n<!-- ${M}-sha=${sha} -->\n<!-- ${M}-round=${round} -->${noteSlug ? `\n<!-- ${M}-note=${noteSlug} -->` : ''}`;
  const full = `${body}\n\n${meta}\n`;
  const prior = await previousRuns(repo, pr);
  // With a collaborator connected, a new comment goes out as that person, with
  // the App's badge (lib/ghuser.mjs). Only a comment's author can edit it, so
  // each earlier comment is edited by whoever wrote it.
  const collab = collaborator();
  const editAs = (c) => (collab && c.author && c.author.toLowerCase() === collab.login.toLowerCase() ? { token: collab.token } : {});
  const same = prior.find((c) => c.sha === sha);
  if (same) {
    await rest('PATCH', `repos/${repo}/issues/comments/${same.id}`, { body: { body: full }, ...editAs(same) });
    return same.html_url;
  }
  for (const old of prior.filter((c) => !c.body.includes(`<!-- ${M}-superseded -->`))) {
    const folded = `<details><summary>Round ${old.round} at \`${(old.sha ?? '').slice(0, 7)}\`, superseded by round ${round}</summary>\n\n${old.body}\n\n</details>\n<!-- ${M}-superseded -->`;
    await rest('PATCH', `repos/${repo}/issues/comments/${old.id}`, { body: { body: folded }, ...editAs(old) });
  }
  const out = await rest('POST', `repos/${repo}/issues/${num(pr)}/comments`, { body: { body: full }, ...(collab ? { token: collab.token } : {}) });
  return out.html_url;
}

const STATUS = {
  ok: ['success', 'Found OK'],
  partial: ['failure', 'Found partially OK'],
  not_ok: ['failure', 'Found NOT OK'],
  no_result: ['error', 'No result yet, the run is repeated'],
  inconclusive: ['error', 'No result, the run is repeated'],
  already_fixed: ['failure', 'Already fixed on dev by another change'],
  pending: ['pending', 'Test running in a real environment'],
};

export async function setStatus({ repo, sha, verdict, url }) {
  const [state, description] = STATUS[verdict];
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('not a commit sha');
  await rest('POST', `repos/${repoOk(repo)}/statuses/${sha}`, { body: { state, context: 'Miu', description, ...(url ? { target_url: url } : {}) } });
}

// ---- PR labels: the team's QA workflow labels, the same in all three repos.
export const LABELS = {
  ongoing: 'Test Ongoing',
  ready: 'Tested & Ready For Merge',
  bugs: 'Tested & Reported Bugs',
  ai: 'Miu Tested',
  reproduced: 'AI Reproduced',
  notReproduced: 'AI Not Reproduced',
  waiting: ['Ready For Testing', 'Needs Re-Test'],
  already: 'Already In Dev',
  // A confirmed breach of the business rules ("Fits the product" in the report).
  against: 'Against Product',
  skip: 'Miu Skip',
};
const RESULT_LABELS = [LABELS.ready, LABELS.bugs, LABELS.reproduced, LABELS.notReproduced, LABELS.against];

export async function getLabels(repo, pr) {
  return (await restAll(`repos/${repoOk(repo)}/issues/${num(pr)}/labels`)).map((l) => l.name);
}

export async function setLabels(repo, pr, { add = [], remove = [] }) {
  const have = new Set(await getLabels(repo, pr));
  for (const name of remove) {
    if (have.has(name)) await rest('DELETE', `repos/${repo}/issues/${num(pr)}/labels/${encodeURIComponent(name)}`);
  }
  const missing = add.filter((n) => !have.has(n) || remove.includes(n));
  if (missing.length) await rest('POST', `repos/${repo}/issues/${num(pr)}/labels`, { body: { labels: missing } });
  return getLabels(repo, pr);
}

// Labels when a test starts: waiting and old results out, "Test Ongoing" in.
export const startLabels = () => ({ add: [LABELS.ongoing], remove: [...LABELS.waiting, ...RESULT_LABELS, 'Needs Rebase', 'Already In Dev'] });

// Labels when a test ends. A run with no result claims nothing: the labels the
// PR had before go back.
export function endLabels(verdict, results, before) {
  if (verdict === 'no_result' || verdict === 'inconclusive') return { add: before.filter((l) => l !== LABELS.ongoing), remove: [LABELS.ongoing] };
  if (verdict === 'already_fixed') return { add: [LABELS.already, LABELS.ai, LABELS.notReproduced], remove: [LABELS.ongoing, LABELS.ready, LABELS.bugs, LABELS.reproduced] };
  const base = (results.criteria ?? []).map((c) => c.baseline?.status);
  const add = [verdict === 'ok' ? LABELS.ready : LABELS.bugs, LABELS.ai];
  if (base.includes('reproduced')) add.push(LABELS.reproduced);
  if (base.includes('not_reproduced')) add.push(LABELS.notReproduced);
  if ((results.issues ?? []).some((i) => i.kind === 'business' && !i.unconfirmed)) add.push(LABELS.against);
  return { add, remove: [LABELS.ongoing, ...RESULT_LABELS.filter((l) => !add.includes(l))] };
}

// The PR's head now, and whether the run tested it. A commit pushed during
// the run makes the result about older code.
export async function headMoved(repo, pr, testedSha) {
  const now = (await rest('GET', `repos/${repoOk(repo)}/pulls/${num(pr)}`)).head.sha;
  return { now, stale: now !== testedSha };
}

export const staleNote = (tested, now) => `> Tested at \`${tested.slice(0, 7)}\`. The pull request has newer commits (\`${now.slice(0, 7)}\`) that this run did not test, so it needs another test before merging.\n`;

// Labels at the end of a run. When the head moved, the result is no merge
// signal: a waiting label a developer set for the new commit stays, and
// "Needs Re-Test" goes on only when none is there.
export function finalLabels({ verdict, results, before, current, stale }) {
  if (!stale) return endLabels(verdict, results, before);
  const waiting = LABELS.waiting.some((l) => current.includes(l));
  return { add: [LABELS.ai, ...(waiting ? [] : ['Needs Re-Test'])], remove: [LABELS.ongoing, ...RESULT_LABELS] };
}

// The PR comment: the short report, then the full report folded under it.
// GitHub stops at 65,536 characters; the evidence ledger table goes first.
export function commentWithFullReport(comment, fullMd, fullUrl) {
  const LIMIT = 64000;
  const wrap = (md) => `${comment}\n\n<details>\n<summary><b>Full report</b></summary>\n\n${md}\n\n</details>`;
  let md = fullMd;
  if (wrap(md).length > LIMIT) md = md.replace(/<details>\s*<summary><b>Evidence ledger[\s\S]*?<\/details>/, `_The evidence ledger is in the run folder${fullUrl ? ` and at ${fullUrl}` : ''}._`);
  if (wrap(md).length > LIMIT) {
    const room = LIMIT - comment.length - 400;
    md = md.slice(0, room).replace(/\n[^\n]*$/, '') + `\n\n_The report was cut here to fit a GitHub comment.${fullUrl ? ` The rest is at ${fullUrl}.` : ''}_`;
    // A cut can leave a <details> open; close what is open so the comment renders.
    const open = (md.match(/<details/g) ?? []).length - (md.match(/<\/details>/g) ?? []).length;
    md += '\n</details>'.repeat(Math.max(0, open));
  }
  return wrap(md);
}

// One PR of a finished run: comment, commit status, labels. Each step runs on
// its own, so one failure does not stop the rest, and the labels always come
// off "Test Ongoing". before: the labels it had when the test started (null
// for a dry run posted later: then what is on it now). An inconclusive result
// is not posted, and the PR gets its labels back.
export async function postMember({ repo, pr, sha, round, comment, fullMd, note, verdict, results, before = null, log = () => {} }) {
  let failed = false;
  const step = async (name, fn) => { try { return await fn(); } catch (e) { failed = true; log(`${repo}#${pr} ${name} failed: ${String(e.message).split('\n')[0]}`); return undefined; } };
  const moved = await step('head check', () => headMoved(repo, pr, sha));
  const stale = !!moved?.stale, now = moved?.now ?? sha;
  let url;
  if (verdict !== 'no_result' && verdict !== 'inconclusive') {
    let c = note?.url ? comment.replace(/^Full report: .*$/m, `Full report: ${note.url}`) : comment;
    if (stale) c = c.replace(/^(## [^\n]+\n)/, `$1\n${staleNote(sha, now)}`);
    url = await step('comment', () => postComment({ repo, pr, sha, round, body: commentWithFullReport(c, fullMd, note?.url), noteSlug: note?.slug }));
    if (url) await step('status', () => setStatus({ repo, sha, verdict, url }));
  }
  const labels = await step('labels', async () => {
    const current = await getLabels(repo, pr);
    const had = before ?? current;
    const change = url ? finalLabels({ verdict, results, before: had, current, stale })
      : { add: had.filter((l) => l !== LABELS.ongoing), remove: [LABELS.ongoing] };
    // A dry run never ran the start-of-test step that takes the waiting labels off.
    if (url && !before && !stale) change.remove.push(...LABELS.waiting);
    return setLabels(repo, pr, change);
  });
  return { url, stale, now, labels, failed };
}
