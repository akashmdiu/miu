import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelNames, cleanPatch, DEFAULT_LABELS } from '../lib/labels.mjs';
import { LABELS, setLabelNames, startLabels, endLabels, finalLabels } from '../lib/publish.mjs';
import { qaFrom, setLabelNames as setSignalLabels } from '../lib/prsignals.mjs';

test('saved names override the defaults; broken ones fall back', () => {
  const n = labelNames({ miuOk: 'QA: human next', request: 'A, B ,A', humanBugs: [], skip: 'bad,name' });
  assert.equal(n.miuOk, 'QA: human next');
  assert.deepEqual(n.request, ['A', 'B']);
  assert.deepEqual(n.humanBugs, DEFAULT_LABELS.humanBugs);
  assert.equal(n.skip, DEFAULT_LABELS.skip);
});

test('the page cannot save an unknown role, an empty one or a comma in a single name', () => {
  assert.throws(() => cleanPatch({ nope: 'x' }), /not a label role/);
  assert.throws(() => cleanPatch({ miuOk: '  ' }), /needs a label/);
  assert.throws(() => cleanPatch({ request: ', ,' }), /at least one/);
  assert.throws(() => cleanPatch({ miuOk: 'x'.repeat(51) }), /not a label name/);
  assert.deepEqual(cleanPatch({ humanOk: 'Merge me, Ship it' }), { humanOk: ['Merge me', 'Ship it'] });
});

test('Miu hands a passing PR to a person and never puts on the merge label', () => {
  setLabelNames({});
  const ok = endLabels('ok', { criteria: [], issues: [] }, []);
  assert.ok(ok.add.includes('Ready for Human Testing'));
  assert.ok(ok.add.includes('Miu Tested'));
  assert.ok(!ok.add.includes('Tested & Ready For Merge'));
  const bad = endLabels('not_ok', { criteria: [], issues: [] }, []);
  assert.ok(bad.add.includes('Miu Tested & Reported Issue'));
  assert.ok(bad.remove.includes('Ready for Human Testing'));
  assert.ok(!bad.remove.includes('Tested & Reported Issue'), 'a person\'s label is not Miu\'s to remove at the end');
});

test('starting a test clears the request labels and every old result', () => {
  setLabelNames({});
  const s = startLabels();
  for (const l of ['Ready for Miu Testing', 'Ready For Testing', 'Needs Re-Test', 'Ready for Human Testing', 'Miu Tested & Reported Issue', 'Tested & Ready For Merge', 'Tested & Reported Issue', 'Tested & Reported Bugs']) assert.ok(s.remove.includes(l), l);
  assert.deepEqual(s.add, ['Test Ongoing']);
});

test('renamed labels reach every importer of LABELS', () => {
  setLabelNames({ miuOk: 'Human next', retest: 'Again' });
  assert.equal(LABELS.miuOk, 'Human next');
  assert.ok(endLabels('ok', { criteria: [], issues: [] }, []).add.includes('Human next'));
  assert.ok(finalLabels({ verdict: 'ok', results: {}, before: [], current: [], stale: true }).add.includes('Again'));
  setLabelNames({});
});

test('a person\'s result label is read as a QA report; Miu\'s own is not', () => {
  setSignalLabels({});
  const node = (name) => ({ comments: { nodes: [] }, commits: { nodes: [] }, timelineItems: { nodes: [{ __typename: 'LabeledEvent', createdAt: '2026-11-01T00:00:00Z', actor: { login: 'rasel' }, label: { name } }] } });
  assert.equal(qaFrom(node('Tested & Reported Issue')).labelReport.verdict, 'bugs');
  assert.equal(qaFrom(node('Tested & Reported Bugs')).labelReport.verdict, 'bugs');
  assert.equal(qaFrom(node('Tested & Ready For Merge')).labelReport.verdict, 'ok');
  assert.equal(qaFrom(node('Ready for Human Testing')).labelReport, null);
  assert.equal(qaFrom(node('Miu Tested & Reported Issue')).labelReport, null);
});
