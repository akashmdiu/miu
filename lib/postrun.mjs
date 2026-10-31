// Post a finished run to its pull request: the short report with the full
// report folded under it, the commit status, and the QA labels. Used by
// bin/qa-dashboard's "Post to PR" button, for runs that finished as dry runs.
//
// If the pull request has moved on since the tested commit, the comment says
// so and the labels say "Needs Re-Test" instead of a merge recommendation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, loadLedger, forMember } from './report.mjs';
import { withAppToken } from './ghapp.mjs';
import { publishFullReport, postMember, uploadImage, cloudinaryUrl, noteLocalImages } from './publish.mjs';

// agent-notes credentials: the environment, or the agent-notes MCP entry in
// the user's Claude config (read, never printed).
function agentNotesEnv() {
  if (process.env.AGENT_NOTES_MCP_URL && process.env.AGENT_NOTES_TOKEN) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    let found = null;
    (function walk(o) { if (!o || typeof o !== 'object' || found) return; for (const [k, v] of Object.entries(o)) { if (k === 'agent-notes' && v?.url) { found = v; return; } walk(v); } })(cfg);
    const auth = found?.headers?.Authorization ?? found?.headers?.authorization;
    if (found && auth) { process.env.AGENT_NOTES_MCP_URL = found.url; process.env.AGENT_NOTES_TOKEN = auth.replace(/^Bearer\s+/i, ''); }
  } catch { /* no agent-notes: the report goes inline only */ }
}

// GitHub writes go out as the Miu App when it is installed.
export function postRun(runDir, { log = () => {} } = {}) {
  return withAppToken((asApp) => post(runDir, log, asApp), log);
}

async function post(runDir, log, asApp) {
  const pr = JSON.parse(fs.readFileSync(path.join(runDir, 'context/pr.json'), 'utf8'));
  const repo = pr.url.split('/').slice(3, 5).join('/');
  // What the run wrote is what gets posted: re-rendering would drop what
  // qa-run added after the agent (model, infra problems, method notes).
  const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
  const { verdict, round = 1 } = saved;
  const none = (v) => v === 'inconclusive' || v === 'no_result';
  if (none(verdict) && !saved.members?.some((m) => !none(m.verdict))) throw new Error('This run has no result to post.');
  let fullMd = fs.readFileSync(path.join(runDir, 'report.md'), 'utf8');
  // A paired run posts to every PR of the pair, each with its own comment and verdict.
  const members = saved.members ?? [{ key: `${repo}#${pr.number}`, repo, pr: pr.number, sha: pr.headRefOid, round, verdict, comment: 'comment.md' }];
  let comments = members.map((m) => fs.readFileSync(path.join(runDir, m.comment), 'utf8'));
  // A dry run keeps its screenshots on this machine; posting puts the ones the
  // report shows on Cloudinary now and points the report at them.
  const local = /\]\(((?!https?:)[^)\s]*\.(?:png|jpe?g|webp|gif))\)/gi;
  const refs = new Set([...(fullMd + '\n' + comments.join('\n')).matchAll(local)].map((m) => m[1]));
  if (refs.size) {
    // Nothing about an image stops the post: one not saved, one that fails to
    // upload, or no Cloudinary at all becomes a note in its place.
    const known = (() => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'screenshots.json'), 'utf8')); } catch { return {}; } })();
    const prefix = `${repo.split('/')[1]}-${pr.number}-${String(pr.headRefOid).slice(0, 7)}`;
    const why = new Map();
    for (const ref of refs) {
      const file = path.basename(ref);
      if (known[file]) continue;
      const onDisk = path.join(runDir, 'evidence', file);
      if (!fs.existsSync(onDisk)) { why.set(file, 'it was not saved during the run'); continue; }
      if (!cloudinaryUrl()) { why.set(file, 'Cloudinary is not set up'); continue; }
      try { known[file] = await uploadImage(onDisk, prefix); } catch (e) { why.set(file, 'the upload failed'); log(`screenshot ${file}: ${e.message}`); }
    }
    try { fs.writeFileSync(path.join(runDir, 'screenshots.json'), JSON.stringify(known, null, 2)); } catch { /* disk full: links still swap */ }
    const swap = (t) => noteLocalImages(t.replace(/\]\(((?!https?:)[^)\s]*\.(?:png|jpe?g|webp|gif))\)/gi, (all, ref) => (known[path.basename(ref)] ? `](${known[path.basename(ref)]})` : all)), (f) => why.get(f) ?? 'not uploaded');
    fullMd = swap(fullMd);
    comments = comments.map(swap);
    log(`screenshots: ${refs.size - why.size} on Cloudinary${why.size ? `, ${why.size} left out (${[...why.keys()].join(', ')})` : ''}`);
  }
  // Baselines decide the AI Reproduced / AI Not Reproduced labels.
  const { results } = validate(JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')), loadLedger(runDir), runDir);
  const match = (ref) => { const n = Number(String(ref ?? '').match(/(\d+)\s*$/)?.[1]); const hits = members.filter((m) => m.pr === n); return hits.length === 1 ? hits[0].key : hits.sort((x, y) => y.repo.length - x.repo.length).find((m) => String(ref).toLowerCase().includes(m.repo.split('/')[1]))?.key ?? null; };

  agentNotesEnv();
  let note = null;
  try { note = await publishFullReport({ title: `QA ${repo}#${pr.number} round ${round}`, markdown: fullMd }); } catch (e) { log(`full report not published to agent-notes: ${e.message}`); }
  const out = [];
  for (const [i, m] of members.entries()) {
    const comment = comments[i].replace(/^Full report: .*$/m, note?.url ? `Full report: ${note.url}` : 'Full report: below.');
    const r = await postMember({ repo: m.repo, pr: m.pr, sha: m.sha, round: m.round ?? round, comment, fullMd, note, verdict: m.verdict, results: saved.members ? forMember(results, m.key, match) : results, before: null, log });
    out.push({ key: m.key, repo: m.repo, pr: m.pr, url: r.url, verdict: m.verdict, stale: r.stale, tested: m.sha, now: r.now, labels: r.labels });
  }
  const mine = out[0];
  if (!mine.url) throw new Error('The comment was not posted; see the log.');
  const posted = { url: mine.url, at: new Date().toISOString(), as: asApp ? 'Miu App' : 'local gh login', verdict: mine.verdict, labels: mine.labels, stale: mine.stale, tested: mine.tested, now: mine.now, report: note?.url ?? null, ...(saved.members ? { members: out } : {}) };
  fs.writeFileSync(path.join(runDir, 'posted.json'), JSON.stringify(posted, null, 2));
  return posted;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) {
    try { console.log(JSON.stringify(await postRun(path.resolve(dir), { log: console.error }))); }
    catch (e) { console.error(`${dir}: ${e.message}`); process.exitCode = 1; }
  }
}
