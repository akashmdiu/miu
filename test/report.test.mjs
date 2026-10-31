import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, computeVerdict, renderComment, loadLedger } from '../lib/report.mjs';

function runDir(evidenceIds = ['ev-001', 'ev-002']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
  fs.mkdirSync(path.join(dir, 'evidence'));
  const rows = evidenceIds.map((id) => {
    fs.writeFileSync(path.join(dir, 'evidence', `${id}.log`), 'output');
    return JSON.stringify({ id, kind: 'cmd', label: 'x', file: `${id}.log`, exit: 0 });
  });
  fs.writeFileSync(path.join(dir, 'evidence', 'index.jsonl'), rows.join('\n') + '\n');
  return dir;
}

// Every criterion is reproduced on dev unless a test says otherwise.
const base = (criteria, issues = [], extra = {}) => ({
  repo: 'acme/shop', pr: 1, head_sha: 'abcdef1234', environments: [{ id: 'A', label: 'Docker A' }],
  criteria: criteria.map((c) => ('baseline' in c ? c : { baseline: { status: 'reproduced', evidence: ['ev-001'] }, ...c })), issues, ...extra,
});

function withShot(dir, id) {
  fs.writeFileSync(path.join(dir, 'evidence', `${id}.png`), 'png');
  fs.appendFileSync(path.join(dir, 'evidence', 'index.jsonl'), JSON.stringify({ id, kind: 'shot', label: id, file: `${id}.png` }) + '\n');
  return dir;
}

function judge(results, dir = runDir()) {
  const v = validate(results, loadLedger(dir), dir);
  return { ...v, verdict: computeVerdict(v.results) };
}

test('a pass with no evidence is downgraded and cannot make the run OK', () => {
  const { results, problems, verdict } = judge(base([{ id: 1, claim: 'x', results: { A: { status: 'pass' } } }]));
  assert.equal(results.criteria[0].results.A.status, 'unverified');
  assert.ok(problems.some((p) => p.includes('no captured evidence')));
  // Not proven counts against the PR; there is no "inconclusive".
  assert.equal(verdict, 'not_ok');
});

test('evidence ids that were never captured do not count', () => {
  const { results } = judge(base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-999'] } } }]));
  assert.equal(results.criteria[0].results.A.status, 'unverified');
});

test('all criteria passing with evidence is OK', () => {
  assert.equal(judge(base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } }])).verdict, 'ok');
});

test('minor issues alone keep the verdict OK', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } }],
    [{ severity: 'minor', title: 'copy', evidence: ['ev-001'] }]);
  assert.equal(judge(r).verdict, 'ok');
});

test('a failed criterion is at least partially OK', () => {
  const r = base([
    { id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } },
    { id: 2, claim: 'y', results: { A: { status: 'fail', evidence: ['ev-001', 'ev-002'] } } },
  ]);
  assert.equal(judge(r).verdict, 'partial');
});

test('a confirmed blocker is NOT OK', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'fail', evidence: ['ev-001', 'ev-002'] } } }],
    [{ severity: 'blocker', title: 'data loss', evidence: ['ev-001', 'ev-002'] }]);
  assert.equal(judge(r).verdict, 'not_ok');
});

test('a blocker with no evidence is shown as unconfirmed and does not block', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } }],
    [{ severity: 'blocker', title: 'guess' }]);
  const { results, verdict } = judge(r);
  assert.equal(results.issues[0].unconfirmed, true);
  assert.equal(verdict, 'ok');
});

test('claims the run could not settle count against the PR, never inconclusive', () => {
  const r = base([
    { id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } },
    { id: 2, claim: 'y', results: { A: { status: 'blocked' } } },
    { id: 3, claim: 'z', results: { A: { status: 'blocked' } } },
  ], [], { infra_problems: [{ what: 'MariaDB never became healthy', blocking: true }] });
  assert.equal(judge(r).verdict, 'partial');
});

test('the comment uses the team headings and labels the run as automated', () => {
  const { results, problems, verdict } = judge(base([{ id: 1, claim: 'Saving works', results: { A: { status: 'pass', evidence: ['ev-001'] } } }]));
  const md = renderComment(results, verdict, { problems, reportUrl: 'https://example.test/r' });
  assert.match(md, /^## ✅ FOUND OK/);
  assert.match(md, /- \[x\] Saving works/);
  assert.match(md, /Full report: https:\/\/example.test\/r/);
  assert.match(md, /Not yet confirmed by a person/);
});

test('a claimed reproduction on dev without evidence is downgraded', () => {
  const r = base([{ id: 1, claim: 'x', baseline: { status: 'reproduced', evidence: ['ev-999'] }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  const { results, problems } = judge(r);
  assert.equal(results.criteria[0].baseline.status, 'unverified');
  assert.ok(problems.some((p) => p.includes('baseline')));
});

test('a reproduction with real evidence is kept', () => {
  const r = base([{ id: 1, claim: 'x', baseline: { status: 'reproduced', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  assert.equal(judge(r).results.criteria[0].baseline.status, 'reproduced');
});

test('a visible claim without an after screenshot passes on its other evidence, with a note', () => {
  const dir = withShot(runDir(['ev-001']), 'ev-003');
  const r = base([{ id: 1, claim: 'The panel shows the new setting', visible: true, baseline: { status: 'absent_before', evidence: ['ev-003'] }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  const { results, problems, verdict } = judge(r, dir);
  assert.equal(results.criteria[0].results.A.status, 'pass');
  assert.ok(problems.some((p) => p.includes('no after screenshot')));
  assert.equal(verdict, 'ok');
});

test('a visible claim with before and after screenshots passes', () => {
  const dir = withShot(withShot(runDir(['ev-001']), 'ev-002'), 'ev-003');
  const r = base([{ id: 1, claim: 'x', visible: true, baseline: { status: 'absent_before', evidence: ['ev-003'] }, results: { A: { status: 'pass', evidence: ['ev-002'] } } }]);
  assert.equal(judge(r, dir).verdict, 'ok');
});

test('a claim that was not reproduced on dev cannot pass', () => {
  const r = base([{ id: 1, claim: 'x', baseline: undefined, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  delete r.criteria[0].baseline;
  const { results, problems, verdict } = judge(r);
  assert.equal(results.criteria[0].results.A.status, 'unverified');
  assert.ok(problems.some((p) => p.includes('not reproduced on dev')));
  assert.equal(verdict, 'not_ok');
});

test('"not applicable" is no longer a baseline', () => {
  const r = base([{ id: 1, claim: 'x', baseline: { status: 'not_applicable' }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  assert.equal(judge(r).results.criteria[0].results.A.status, 'unverified');
});

test('a regression check shown the same on dev passes', () => {
  const r = base([{ id: 1, claim: 'No new warnings', baseline: { status: 'same_before', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }]);
  assert.equal(judge(r).verdict, 'ok');
});

test('a visible claim whose before is proven without a screenshot still passes, with a note', () => {
  const dir = withShot(runDir(['ev-001']), 'ev-002');
  const r = base([{ id: 1, claim: 'x', visible: true, baseline: { status: 'absent_before', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-002'] } } }]);
  const { results, problems, verdict } = judge(r, dir);
  assert.equal(results.criteria[0].baseline.status, 'absent_before');
  assert.equal(results.criteria[0].results.A.status, 'pass');
  assert.ok(problems.some((p) => p.includes('no before screenshot')));
  assert.equal(verdict, 'ok');
});

// Hub #497: every claim held, one minor rounding issue, visible claims proven by
// API output rather than pictures. That is Found OK, not partially OK.
test('every claim proven with only a minor issue is OK, screenshots or not', () => {
  const dir = runDir(['ev-001', 'ev-002']);
  const r = base([1, 2, 3].map((id) => ({ id, claim: 'tile ' + id, visible: true, baseline: { status: 'absent_before', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-002'] } } })),
    [{ severity: 'minor', title: 'rounds before choosing the colour', evidence: ['ev-002'] }]);
  assert.equal(judge(r, dir).verdict, 'ok');
});

test('a major issue still makes it partially OK', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } }],
    [{ severity: 'major', title: 'breaks for guests', evidence: ['ev-001', 'ev-002'] }]);
  assert.equal(judge(r).verdict, 'partial');
});

test('a failure seen once is not reported as a failure', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'fail', evidence: ['ev-001'] } } }],
    [{ severity: 'major', title: 'broken once', evidence: ['ev-001'] }]);
  const { results, problems } = judge(r);
  assert.equal(results.criteria[0].results.A.status, 'unverified');
  assert.equal(results.issues[0].unconfirmed, true);
  assert.ok(problems.some((p) => p.includes('not confirmed by a second run')));
});

test('a carried result says which round it came from', () => {
  const { results, problems, verdict } = judge(base([{ id: 1, claim: 'Saving works', carried_from: { round: 1, sha: '9a54376abc' }, results: { A: { status: 'pass', evidence: ['ev-001'] } } }], [], { retest: { round: 1, sha: '9a54376abc', summary: '2 files changed; claims 2 and 3 re-tested.' } }));
  const md = renderComment(results, verdict, { problems });
  assert.match(md, /Saving works _\(unchanged since round 1 at `9a54376`\)_/);
  assert.match(md, /Re-test of round 1/);
});

test('a bug already fixed on dev, with proof, is ALREADY FIXED', () => {
  const r = base([{ id: 1, claim: 'Purge no longer fails', baseline: { status: 'not_reproduced', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-002'] } } }], [], { already_fixed: { by: '#812 (abc1234)', evidence: ['ev-002'] } });
  const { results, problems, verdict } = judge(r);
  assert.equal(verdict, 'already_fixed');
  assert.match(renderComment(results, verdict, { problems }), /^## ♻️ ALREADY FIXED ON DEV[\s\S]*#812 \(abc1234\) already fixed it/);
});

test('"already fixed" without proof is ignored', () => {
  const r = base([{ id: 1, claim: 'x', baseline: { status: 'not_reproduced', evidence: ['ev-001'] }, results: { A: { status: 'pass', evidence: ['ev-002'] } } }], [], { already_fixed: { by: '#812' } });
  const { verdict, problems } = judge(r);
  assert.equal(verdict, 'ok');
  assert.ok(problems.some((p) => p.includes('already fixed')));
});

test('a run with no claims has no result, which is not a verdict', () => {
  assert.equal(judge(base([])).verdict, 'no_result');
});

test('a business conflict makes the run not OK even when every claim passes', () => {
  const r = base([{ id: 1, claim: 'x', results: { A: { status: 'pass', evidence: ['ev-001'] } } }], [{ kind: 'business', severity: 'blocker', title: 'Free names Pro', evidence: ['ev-001', 'ev-001'], from_source_analysis: true }]);
  assert.equal(judge(r).verdict, 'not_ok');
});

test('a claim the QA machine cannot test is listed as not tested and does not hold the verdict back', () => {
  const r = judge(base([
    { id: 1, claim: 'Saves', baseline: { status: 'reproduced', evidence: ['ev-001'] }, visible: false, results: { A: { status: 'pass', evidence: ['ev-002'] } } },
    { id: 2, claim: 'Served immutable', visible: false, results: { A: { status: 'untestable', needs: 'server', note: 'needs the nginx rule installed and nginx reloaded' } } },
    { id: 3, claim: 'Other', baseline: { status: 'reproduced', evidence: ['ev-001'] }, visible: false, results: { A: { status: 'pass', evidence: ['ev-002'] } } },
    { id: 4, claim: 'More', baseline: { status: 'reproduced', evidence: ['ev-001'] }, visible: false, results: { A: { status: 'pass', evidence: ['ev-002'] } } },
  ]));
  assert.equal(r.verdict, 'ok');
  assert.match(r.results.not_covered.at(-1).why, /needs a server feature: needs the nginx rule/);
  assert.ok(!r.problems.some((p) => /criterion 2/.test(p)));
});

test('an untestable claim with no reason, or too many of them, counts as not proven', () => {
  const pass = (id) => ({ id, claim: `c${id}`, baseline: { status: 'reproduced', evidence: ['ev-001'] }, visible: false, results: { A: { status: 'pass', evidence: ['ev-002'] } } });
  const vague = judge(base([pass(1), pass(2), pass(3), { id: 4, claim: 'x', visible: false, results: { A: { status: 'untestable', note: 'no' } } }]));
  assert.equal(vague.verdict, 'partial');
  const many = judge(base([pass(1), ...[2, 3].map((id) => ({ id, claim: `u${id}`, visible: false, results: { A: { status: 'untestable', needs: 'author', note: 'needs the author\'s Astra page and media' } } }))]));
  assert.equal(many.verdict, 'partial');
  assert.match(many.problems.join('\n'), /more than a run may set aside/);
});
