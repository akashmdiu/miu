// Turns the agent's results.json into the two documents the team expects
// (docs/methodology.md sections 3 and 4): a short PR comment and a full report.
//
// The agent only writes facts. The verdict, the "no pass without evidence"
// downgrade and the infrastructure/defect split are decided here, in code, so
// a confident model cannot talk its way to a green result.
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'untestable', 'not_run', 'unverified'];
// Why a claim cannot be tested here: a server feature the QA machine lacks
// (an nginx rule it may not install, a second web server), or something only
// the author has (their page, their media, their benchmark set-up).
export const UNTESTABLE_NEEDS = ['server', 'author'];
// Past this share of the claims, "cannot be tested here" says more about the
// run than about the machine, and those claims count as not proven again.
export const UNTESTABLE_MAX_SHARE = 0.25;
export const BASELINE = ['reproduced', 'not_reproduced', 'absent_before', 'same_before'];
export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'];
const ICON = { pass: '✅', fail: '❌', blocked: '⛔', skipped: '—', untestable: '🚫', not_run: '—', unverified: '⚠️' };

export const VERDICTS = {
  ok: '## ✅ FOUND OK',
  partial: '## 🔁 FOUND PARTIALLY OK',
  not_ok: '## ❌ FOUND NOT OK',
  // Not a verdict: the run wrote no claims at all. Never posted; it runs again.
  no_result: '## ⚠️ NO RESULT',
  already_fixed: '## ♻️ ALREADY FIXED ON DEV',
};

export function loadLedger(runDir) {
  const file = path.join(runDir, 'evidence', 'index.jsonl');
  if (!fs.existsSync(file)) return new Map();
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return new Map(rows.map((r) => [r.id, r]));
}

function evidenceIsReal(id, ledger, runDir) {
  const row = ledger.get(id);
  if (!row) return false;
  return fs.existsSync(path.join(runDir, 'evidence', row.file));
}

// Structural checks plus the evidence rule. Returns the corrected results and
// a list of problems; problems never throw, they are printed in the report.
export function validate(results, ledger, runDir) {
  const problems = [];
  const r = structuredClone(results);
  for (const key of ['repo', 'pr', 'head_sha', 'criteria', 'environments']) {
    if (r[key] === undefined) problems.push(`results.json is missing "${key}"`);
  }
  r.criteria ??= [];
  r.issues ??= [];
  r.environments ??= [];
  r.not_covered ??= [];
  r.infra_problems ??= [];
  r.observations ??= [];
  r.builds ??= [];

  const envIds = new Set(r.environments.map((e) => e.id));
  for (const c of r.criteria) {
    c.results ??= {};
    for (const [envId, res] of Object.entries(c.results)) {
      if (!envIds.has(envId)) problems.push(`criterion ${c.id} has a result for unknown environment "${envId}"`);
      if (!STATUSES.includes(res.status)) {
        problems.push(`criterion ${c.id}/${envId}: unknown status "${res.status}", treated as unverified`);
        res.status = 'unverified';
      }
      res.evidence ??= [];
      const missing = res.evidence.filter((id) => !evidenceIsReal(id, ledger, runDir));
      if (missing.length) problems.push(`criterion ${c.id}/${envId} cites evidence that was not captured: ${missing.join(', ')}`);
      const real = res.evidence.filter((id) => evidenceIsReal(id, ledger, runDir));
      if ((res.status === 'pass' || res.status === 'fail') && real.length === 0) {
        problems.push(`criterion ${c.id}/${envId} was marked ${res.status} with no captured evidence, downgraded to unverified`);
        res.status = 'unverified';
      }
      // A failure is reported only after it happened twice (two runs of the
      // step), so a one-off hiccup does not become a bug report.
      if (res.status === 'fail' && real.length < 2) {
        problems.push(`criterion ${c.id}/${envId} failed once but was not confirmed by a second run, downgraded to unverified`);
        res.status = 'unverified';
      }
      // Not held against the PR only when it names what is missing and
      // whose it is; a vague one is an ordinary block.
      if (res.status === 'untestable' && (!UNTESTABLE_NEEDS.includes(res.needs) || String(res.note ?? '').trim().length < 20)) {
        problems.push(`criterion ${c.id}/${envId} was marked untestable without saying what is missing ("needs": "server" or "author", and a note), treated as blocked`);
        res.status = 'blocked';
      }
      res.evidence = real;
    }
  }
  // A claim this machine cannot test at all is listed as not tested, with
  // what it needs, and does not hold the verdict back. Too many such claims,
  // and they all count as not proven.
  const untestable = r.criteria.filter((c) => Object.values(c.results).some((v) => v.status === 'untestable'));
  if (untestable.length > Math.max(1, Math.floor(r.criteria.length * UNTESTABLE_MAX_SHARE))) {
    problems.push(`${untestable.length} of ${r.criteria.length} claims were marked untestable, more than a run may set aside; they count as not proven`);
    for (const c of untestable) for (const v of Object.values(c.results)) if (v.status === 'untestable') v.status = 'blocked';
  } else {
    for (const c of untestable) {
      const notes = [...new Set(Object.values(c.results).filter((v) => v.status === 'untestable').map((v) => `${v.needs === 'author' ? 'needs the author' : 'needs a server feature'}: ${v.note}`))];
      r.not_covered.push({ what: `Claim ${c.id}: ${c.claim}`, why: notes.join('; ') });
    }
  }
  // Phase 2 (before, on dev): every claim is reproduced on dev first, with
  // evidence that was really captured. There is no "nothing to compare": a
  // regression check shows dev behaving the same (same_before).
  const isShot = (id) => /\.(png|jpe?g|webp)$/i.test(ledger.get(id)?.file ?? '');
  for (const c of r.criteria) {
    const setAside = Object.values(c.results).length > 0 && Object.values(c.results).every((v) => ['untestable', 'skipped'].includes(v.status));
    if (!c.baseline && setAside) { c.baseline = { status: 'unverified', evidence: [] }; continue; }
    if (!c.baseline) { problems.push(`criterion ${c.id} was not reproduced on dev (no baseline)`); c.baseline = { status: 'unverified', evidence: [] }; }
    if (!BASELINE.includes(c.baseline.status)) {
      problems.push(`criterion ${c.id}: baseline "${c.baseline.status}" is not a reproduction on dev, treated as unverified`);
      c.baseline.status = 'unverified';
    }
    const real = (c.baseline.evidence ?? []).filter((id) => evidenceIsReal(id, ledger, runDir));
    if (c.baseline.status !== 'unverified' && !real.length) {
      problems.push(`criterion ${c.id}: baseline "${c.baseline.status}" has no captured evidence, downgraded to unverified`);
      c.baseline.status = 'unverified';
    }
    // A screenshot is the best "before" for something a person sees, but the
    // before is proven by any captured evidence: a missing picture is noted in
    // the report, it does not undo the proof.
    if (c.baseline.status !== 'unverified' && c.visible && !real.some(isShot)) {
      problems.push(`criterion ${c.id} is visible but has no before screenshot from dev; its other evidence shows the before`);
    }
    c.baseline.evidence = real;
    // Without the before half, an "after" proves no change.
    if (c.baseline.status === 'unverified') {
      for (const [envId, res] of Object.entries(c.results)) {
        if (res.status === 'pass') { problems.push(`criterion ${c.id}/${envId} passed, but the claim was not reproduced on dev first, downgraded to unverified`); res.status = 'unverified'; }
      }
    }
  }
  // A claim a person can see should have a screenshot after (PR) as well; the
  // same as above, a pass with other captured evidence stays a pass.
  for (const c of r.criteria) {
    if (c.visible === undefined) { problems.push(`criterion ${c.id} does not say whether it is visible (set "visible")`); continue; }
    if (!c.visible) continue;
    for (const [envId, res] of Object.entries(c.results)) {
      if (res.status === 'pass' && !(res.evidence ?? []).some(isShot)) {
        problems.push(`criterion ${c.id}/${envId} is visible but has no after screenshot; its other evidence shows the result`);
      }
    }
  }
  // "Already fixed on dev by #NNN" needs captured proof: the dev run where the
  // bug did not show, and the commit or PR that fixed it.
  if (r.already_fixed) {
    const ev = (r.already_fixed.evidence ?? []).filter((id) => evidenceIsReal(id, ledger, runDir));
    if (!ev.length || !r.already_fixed.by) { problems.push('"already fixed on dev" has no captured evidence or no fixing commit, ignored'); delete r.already_fixed; }
    else r.already_fixed.evidence = ev;
  }
  r.business = (r.business ?? []).filter((b) => b && b.rule).map((b) => ({ ...b, status: b.status === 'conflicts' ? 'conflicts' : 'fits', evidence: (b.evidence ?? []).filter((id) => evidenceIsReal(id, ledger, runDir)) }));
  for (const i of r.issues) {
    if (!SEVERITIES.includes(i.severity)) {
      problems.push(`issue "${i.title}": unknown severity "${i.severity}", treated as minor`);
      i.severity = 'minor';
    }
    i.evidence = (i.evidence ?? []).filter((id) => evidenceIsReal(id, ledger, runDir));
    // A defect claim with nothing behind it is reported as a lead to check,
    // not as a finding (an unproven blocker would block the PR on a guess).
    if (i.evidence.length === 0 && !i.from_source_analysis) {
      problems.push(`issue "${i.title}" has no captured evidence and is shown as unconfirmed`);
      i.unconfirmed = true;
    } else if ((i.severity === 'blocker' || i.severity === 'major') && i.evidence.length < 2 && !i.from_source_analysis) {
      problems.push(`issue "${i.title}" was seen once and not confirmed by a second run, shown as unconfirmed`);
      i.unconfirmed = true;
    }
  }
  return { results: r, problems };
}

// One PR's part of a paired run: its own criteria and issues, and the shared
// ones (no "pr"). match turns a criterion's "pr" into a member key, or null.
export function forMember(r, key, match) {
  const mine = (x) => !x.pr || match(x.pr) === null || match(x.pr) === key;
  return { ...r, criteria: r.criteria.filter(mine), issues: r.issues.filter(mine) };
}

// Cells still open: a claim in a combo that was neither proven to hold nor
// proven to fail. "skipped" is a combo that does not apply, with its reason.
export const OPEN = ['blocked', 'not_run', 'unverified'];
export function openCells(r) {
  return r.criteria.flatMap((c) => Object.entries(c.results ?? {}).filter(([, v]) => OPEN.includes(v.status))
    .map(([column, v]) => ({ id: c.id, claim: c.claim, column, status: v.status, note: v.note ?? '' })));
}

// Every verdict rests on evidence; there is no "inconclusive". A cell the run
// could not settle even after the resolve pass counts against the PR (it is
// not proven), and the report says why for each one.
// The verdict, in order: a confirmed blocker is NOT OK. A failed claim, a
// claim not proven, or a confirmed major issue is PARTIALLY OK (NOT OK when
// nothing passed). Every claim proven and only minor issues (or none) is OK:
// minor issues are listed in the report, they do not lower the verdict.
export function computeVerdict(r) {
  const cells = r.criteria.flatMap((c) => Object.values(c.results));
  const decided = cells.filter((x) => x.status === 'pass' || x.status === 'fail');
  const confirmed = r.issues.filter((i) => !i.unconfirmed);
  // The bug is gone on dev already and a commit there explains why: nothing
  // left for this PR to fix. Needs proof of both (validate() checks).
  const bases = r.criteria.map((c) => c.baseline?.status);
  if (r.already_fixed && !bases.includes('reproduced') && bases.includes('not_reproduced')) return 'already_fixed';

  if (r.criteria.length === 0) return 'no_result';
  // Every claim set aside as untestable here: no verdict to give. (Claims
  // left open still count against the PR.)
  if (cells.length && cells.every((x) => ['untestable', 'skipped'].includes(x.status)) && !confirmed.length) return 'no_result';
  if (confirmed.some((i) => i.severity === 'blocker')) return 'not_ok';
  const passed = decided.filter((x) => x.status === 'pass').length;
  const open = cells.filter((x) => OPEN.includes(x.status)).length;
  if (confirmed.some((i) => i.severity === 'major') || cells.some((x) => x.status === 'fail') || open) return passed ? 'partial' : 'not_ok';
  return 'ok';
}

const sevRank = (s) => SEVERITIES.indexOf(s);
const imageCell = (img) => (img ? `![](${img})` : '');

function criterionPassedEverywhere(c) {
  const vals = Object.values(c.results);
  return vals.length > 0 && vals.every((v) => ['pass', 'not_run', 'skipped', 'untestable'].includes(v.status))
    && vals.some((v) => v.status === 'pass');
}

function issueBlock(i, n, { full }) {
  const lead = i.severity === 'blocker' ? `**Blocker: ${i.title}**` : (i.severity === 'major' ? `**${i.title}**` : i.title);
  const tag = i.unconfirmed ? ' _(not confirmed in a run, check by hand)_' : '';
  const lines = [`${n}. ${lead}${tag} ${i.user_impact ?? ''}`.trimEnd()];
  if (i.claim_broken) lines.push(`   The PR says: "${i.claim_broken}"`);
  if (i.before_after?.images?.length) {
    const cols = i.before_after.columns ?? ['What users get', 'What it should be'];
    lines.push('', `   | ${cols.join(' | ')} |`, `   |${cols.map(() => '---').join('|')}|`,
      `   | ${cols.map((_, k) => imageCell(i.before_after.images[k])).join(' | ')} |`);
  }
  if (full) {
    if (i.steps?.length) lines.push('', '   Steps:', ...i.steps.map((s, k) => `   ${k + 1}. ${s}`));
    if (i.expected) lines.push('', `   Expected: ${i.expected}`);
    if (i.actual) lines.push(`   Actual: ${i.actual}`);
    if (i.code_ref) lines.push(`   Code: \`${i.code_ref}\``);
    if (i.suggested_fix) lines.push(`   Suggested fix: ${i.suggested_fix}`);
    if (i.evidence?.length) lines.push(`   Evidence: ${i.evidence.map((e) => `\`${e}\``).join(', ')}`);
  }
  return lines.join('\n');
}

// A result carried from an earlier round (re-test mode) says so wherever it shows.
const carried = (c) => (c.carried_from ? ` _(unchanged since round ${c.carried_from.round} at \`${String(c.carried_from.sha).slice(0, 7)}\`)_` : '');

export function renderComment(r, verdict, { reportUrl, runUrl, problems, shotUrls = [] }) {
  const out = [VERDICTS[verdict], ''];
  if (r.context_line) out.push(r.context_line, '');
  if (verdict === 'already_fixed') {
    out.push(`What this PR fixes no longer happens on \`dev\`: ${r.already_fixed.by} already fixed it.${r.already_fixed.note ? ` ${r.already_fixed.note}` : ''}`, '', 'Please check, and close this pull request if nothing in it is still needed.', '');
  }
  if (r.retest) out.push(`${r.retest.by ? `Re-test since ${r.retest.by}'s round` : `Re-test of round ${r.retest.round}`} (\`${String(r.retest.sha).slice(0, 7)}\`): ${r.retest.summary}`, '');
  const against = r.issues.filter((i) => i.kind === 'business' && !i.unconfirmed);
  if (against.length) {
    out.push('**Goes against the product:**', ...against.map((i) => `- ${i.title}${i.rule ? ` _(rule: ${i.rule})_` : ''}`), '');
  }
  if (verdict === 'no_result') {
    out.push('The run wrote no claims, so there is nothing to judge yet. It runs again.', '');
    for (const p of r.infra_problems) out.push(`- ${p.what}${p.impact ? `: ${p.impact}` : ''}`);
    out.push('');
  }
  const works = r.criteria.filter(criterionPassedEverywhere);
  for (const c of works) out.push(`- [x] ${c.claim}${carried(c)}`);
  const unverified = r.criteria.filter((c) => Object.values(c.results).some((v) => OPEN.includes(v.status)));
  for (const c of unverified) {
    const why = Object.entries(c.results).filter(([, v]) => OPEN.includes(v.status)).map(([col, v]) => `${col}: ${v.note || v.status}`).join('; ');
    out.push(`- [ ] ${c.claim} _(not proven: ${why})_`);
  }
  if (works.length || unverified.length) out.push('');

  const issues = [...r.issues].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const main = issues.filter((i) => i.severity === 'blocker' || i.severity === 'major');
  const minor = issues.filter((i) => i.severity === 'minor' || i.severity === 'nit');
  if (main.length) {
    out.push(main.length + minor.length === 1 ? '**Issue**' : '**Issues**', '');
    main.forEach((i, k) => out.push(issueBlock(i, k + 1, { full: false })));
    minor.forEach((i, k) => out.push(issueBlock(i, main.length + k + 1, { full: false })));
    out.push('');
  } else if (minor.length) {
    out.push('**Minor, not blockers:**', '');
    minor.forEach((i, k) => out.push(issueBlock(i, k + 1, { full: false })));
    out.push('');
  }
  if (!issues.length && verdict === 'ok') out.push('No issues found.', '');

  // Screenshots render on GitHub only from public URLs (Cloudinary).
  const pub = shotUrls.filter((x) => /^https?:\/\//.test(x.url)).slice(0, 4);
  if (pub.length) {
    out.push('<details><summary>Screenshots</summary>', '');
    for (const x of pub) out.push(`**${x.label}**`, '', `![](${x.url})`, '');
    out.push('</details>', '');
  }

  if (r.unchanged?.length) {
    out.push(`**Unchanged since ${r.retest?.by ? `${r.retest.by}'s round` : 'the last round'}, not tested again:**`);
    for (const u of r.unchanged) out.push(`- ${typeof u === 'string' ? u : `${u.claim}${u.why ? ` (${u.why})` : ''}`}`);
    out.push('');
  }
  if (r.not_covered.length) {
    out.push('**Not covered here:**');
    for (const n of r.not_covered) out.push(`- ${n.what}${n.why ? ` (${n.why})` : ''}`);
    out.push('');
  }
  if (problems.length) out.push(`${problems.length} result(s) were downgraded because the evidence was missing. See the full report.`, '');
  if (reportUrl) out.push(`Full report: ${reportUrl}`, '');
  // A linked name, not an @mention: the collaborator is not pinged on every comment.
  out.push(`<sub>Tested by Miu${r.credit ? ` with [${r.credit}](https://github.com/${r.credit})` : ''}${runUrl ? ` ([logs and evidence](${runUrl}))` : ''} at \`${String(r.head_sha).slice(0, 7)}\`, round ${r.round ?? 1}${r.model ? `, ${r.model}` : ''}. Not yet confirmed by a person. Reply on the PR to confirm or dispute a finding.</sub>`);
  return out.join('\n');
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

// Every image this run captured: registered evidence first, then image files
// the agent saved in evidence/ without registering them.
export function screenshots(ledger, runDir) {
  // An image the ledger names but the disk does not have (a full disk during
  // the run) is left out, unless it was uploaded already.
  const onDisk = (e) => !runDir || e.url || fs.existsSync(path.join(runDir, 'evidence', e.file));
  const shots = [...ledger.values()].filter((e) => IMAGE.test(e.file ?? '') && onDisk(e)).map((e) => ({ id: e.id, label: e.label, file: e.file, url: e.url }));
  const known = new Set(shots.map((x) => x.file));
  if (runDir) {
    try {
      for (const f of fs.readdirSync(path.join(runDir, 'evidence')).sort()) {
        if (IMAGE.test(f) && !known.has(f)) shots.push({ id: null, label: f.replace(IMAGE, '').replace(/[-_]/g, ' '), file: f });
      }
    } catch { /* no evidence dir */ }
  }
  return shots;
}

export function renderFull(r, verdict, { problems, ledger, runDir, imageUrl = (f) => `evidence/${f}` }) {
  const issues = [...r.issues].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const n = (s) => issues.filter((i) => i.severity === s && !i.unconfirmed).length;
  const head = {
    ok: 'PASS', partial: `FAIL, ${n('blocker')} blocker + ${n('major') + n('minor')} other`,
    not_ok: `FAIL, ${n('blocker')} blocker + ${n('major') + n('minor')} other`, no_result: 'NO RESULT',
  }[verdict];
  const out = [`# QA: ${r.repo}#${r.pr}`, '', ...(r.pair_line ? [r.pair_line, ''] : []), `## Verdict: ${head}`, ''];
  if (r.verdict_summary) out.push(r.verdict_summary, '');

  for (const b of r.builds) {
    out.push(`**${b.label}** ${b.repo}${b.pr ? `#${b.pr}` : ''} \`${b.branch}\` @ \`${String(b.sha).slice(0, 7)}\`${b.version ? ` (v${b.version})` : ''}  `);
  }
  if (r.linked_issues?.length) out.push(`**Issue** ${r.linked_issues.join(', ')}  `);
  if (r.ran) out.push(`**Ran** ${r.ran}  `);
  if (r.credit) out.push(`**Tested by** Miu with [${r.credit}](https://github.com/${r.credit})  `);
  if (r.model) out.push(`**Model** ${r.model}`);
  out.push('');
  if (r.steered?.length) out.push(`**Asked during the run** ${r.steered.map((s) => `${s.by}: "${s.text.replace(/\s+/g, ' ').slice(0, 300)}"`).join('; ')}`, '');

  const envs = r.environments;
  const BASE = { reproduced: '🐞 reproduced', not_reproduced: '❔ not reproduced', absent_before: '➖ absent', same_before: '🟰 same on dev', not_applicable: '—', unverified: '⚠️ not verified' };
  const hasBase = r.criteria.some((c) => c.baseline);
  out.push(`| # | Acceptance criterion | ${hasBase ? 'Before (dev) | ' : ''}${envs.map((e) => e.label).join(' | ')} |`, `|---|---|${hasBase ? '---|' : ''}${envs.map(() => '---').join('|')}|`);
  for (const c of r.criteria) {
    const cells = envs.map((e) => {
      const res = c.results[e.id];
      return res ? `${ICON[res.status]}${res.note ? ` ${res.note}` : ''}${res.evidence?.length ? ` <sub>${res.evidence.join(' ')}</sub>` : ''}` : '—';
    });
    const before = hasBase ? `${c.baseline ? BASE[c.baseline.status] ?? c.baseline.status : '—'}${c.baseline?.evidence?.length ? ` <sub>${c.baseline.evidence.join(' ')}</sub>` : ''} | ` : '';
    out.push(`| ${c.id} | ${c.claim}${carried(c)} | ${before}${cells.join(' | ')} |`);
  }
  out.push('');
  if (r.business?.length) {
    out.push('### Fits the product', '', '| Rule | Result | Where |', '|---|---|---|');
    for (const b of r.business) out.push(`| ${String(b.rule ?? '').replace(/\|/g, '\\|')} | ${b.status === 'conflicts' ? '❌ goes against it' : '✅ fits'} | ${String(b.where ?? '').replace(/\|/g, '\\|')}${b.evidence?.length ? ` <sub>${b.evidence.join(' ')}</sub>` : ''} |`);
    out.push('');
  }

  // Proof sits under the claim or issue it proves, not in a pile at the end.
  const shotFiles = new Set(screenshots(ledger, runDir).map((x) => x.file));
  const proofMd = (ids) => {
    const rows = (ids ?? []).map((id) => ledger.get(id)).filter(Boolean);
    const imgs = rows.filter((e) => shotFiles.has(e.file));
    const rest = rows.filter((e) => !shotFiles.has(e.file));
    return [
      ...imgs.map((e) => `![${e.id}: ${e.label}](${imageUrl(e.file)})  \n<sub>${e.id} · ${e.label}</sub>`),
      ...rest.map((e) => `- \`${e.id}\` ${e.label}${e.status ? ` (HTTP ${e.status})` : e.exit != null ? ` (exit ${e.exit})` : ''}`),
    ].join('\n\n');
  };
  const cited = new Set([...r.criteria.flatMap((c) => [...Object.values(c.results).flatMap((x) => x.evidence ?? []), ...(c.baseline?.evidence ?? [])]), ...r.issues.flatMap((i) => i.evidence ?? [])]);

  const details = (title, body, open = false) => out.push(`<details${open ? ' open' : ''}>`, `<summary><b>${title}</b></summary>`, '', body.trim(), '', '</details>', '');
  const withProof = (i, k) => issueBlock(i, k + 1, { full: true }) + (i.evidence?.length ? `\n\n${proofMd(i.evidence)}` : '');
  issues.filter((i) => i.severity === 'blocker' || i.severity === 'major').forEach((i, k) => details(`${i.severity === 'blocker' ? 'Blocker' : 'Issue'}: ${i.title}`, withProof(i, k), i.severity === 'blocker'));
  const minor = issues.filter((i) => i.severity === 'minor' || i.severity === 'nit');
  if (minor.length) details('Minor issues (non-blocking)', minor.map(withProof).join('\n\n'));

  // Each claim with the proof behind it.
  const proved = r.criteria.filter((c) => Object.values(c.results).some((x) => x.evidence?.length) || c.baseline?.evidence?.length);
  if (proved.length) {
    details(`What proves each claim (${proved.length})`, proved.map((c) => {
      const ids = [...new Set(Object.values(c.results).flatMap((x) => x.evidence ?? []))];
      const marks = Object.entries(c.results).map(([env, x]) => `${r.environments.find((e) => e.id === env)?.label ?? env}: ${ICON[x.status]}${x.note ? ` ${x.note}` : ''}`).join(' · ');
      const before = c.baseline && c.baseline.status !== 'not_applicable'
        ? `**Before, on dev:** ${BASE[c.baseline.status] ?? c.baseline.status}${c.baseline.note ? `. ${c.baseline.note}` : ''}\n\n${proofMd(c.baseline.evidence)}\n\n**After, on this PR:**\n\n` : '';
      return `**${c.id}. ${c.claim}**  \n<sub>${marks}</sub>\n\n${before}${proofMd(ids)}`;
    }).join('\n\n---\n\n'), true);
  }
  const loose = screenshots(ledger, runDir).filter((x) => !x.id || !cited.has(x.id));
  if (loose.length) details(`Screenshots not tied to any claim (${loose.length})`, loose.map((x) => `![${x.label}](${imageUrl(x.file)})  \n<sub>${x.id ? `${x.id} · ` : ''}${x.label}</sub>`).join('\n\n'));

  if (r.how_tested) details('How this was tested: builds, environment, matrix', r.how_tested);
  for (const s of r.sections ?? []) details(s.title, s.body);
  if (r.regressions) {
    details('Regressions swept', [
      ...(r.regressions.swept ?? []).map((x) => `- ${x}`),
      r.regressions.not_swept?.length ? `\nNot swept: ${r.regressions.not_swept.join('; ')}.` : '',
    ].join('\n'));
  }
  if (r.not_covered.length) details('Not tested', r.not_covered.map((x) => `- ${x.what}${x.why ? `: ${x.why}` : ''}`).join('\n'));
  if (r.observations.length) details('Observations, not bugs', r.observations.map((x) => `- ${x}`).join('\n'));
  if (r.infra_problems.length) details('Test infrastructure problems (not findings about the PR)', r.infra_problems.map((x) => `- ${x.what}${x.impact ? `: ${x.impact}` : ''}`).join('\n'));
  if (r.left_in_state) details('Left in state', r.left_in_state);
  if (problems.length) details('Results downgraded by the evidence check', problems.map((p) => `- ${p}`).join('\n'));

  const rows = [...ledger.values()].map((e) => `| \`${e.id}\` | ${e.kind} | ${e.label} | ${e.exit ?? ''}${e.status ? ` / HTTP ${e.status}` : ''} | \`${e.file}\` |`);
  if (rows.length) details(`Evidence ledger (${rows.length} items, in the run artifact)`, ['| id | kind | what | exit | file |', '|---|---|---|---|---|', ...rows].join('\n'));
  return out.join('\n');
}
