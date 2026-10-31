import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, matches, cleanRules } from '../lib/prrules.mjs';

const pr = { repo: 'acme/shop-hub', author: { login: 'dependabot[bot]' }, labels: ['Docs Only', 'Mobile'], title: 'docs: rename the glossary', headRefName: 'docs/glossary', isDraft: false };

test('the first matching rule decides, the default covers the rest', () => {
  const rules = [{ field: 'label', op: 'is', value: 'docs only', action: 'skip' }, { field: 'repo', op: 'is', value: 'shop-hub', action: 'test' }];
  assert.equal(decide(rules, 'test', pr).action, 'skip');
  assert.equal(decide(rules, 'test', pr).index, 0);
  assert.equal(decide([rules[1]], 'skip', { ...pr, repo: 'acme/shop' }).action, 'skip');
});

test('fields and comparisons', () => {
  assert.ok(matches({ field: 'author', op: 'starts', value: 'dependabot', action: 'skip' }, pr));
  assert.ok(matches({ field: 'title', op: 'contains', value: 'GLOSSARY', action: 'skip' }, pr));
  assert.ok(matches({ field: 'repo', op: 'is', value: 'acme/shop-hub', action: 'test' }, pr));
  assert.ok(matches({ field: 'label', op: 'not', value: 'Ready For Testing', action: 'skip' }, pr));
  assert.ok(!matches({ field: 'label', op: 'not', value: 'Mobile', action: 'skip' }, pr));
  assert.ok(matches({ field: 'draft', op: 'is', value: 'no', action: 'test' }, pr));
});

test('rules from the page are checked', () => {
  assert.throws(() => cleanRules([{ field: 'author', op: 'is', value: '', action: 'skip' }]), /needs a value/);
  assert.throws(() => cleanRules([{ field: 'nope', op: 'is', value: 'x', action: 'skip' }]), /unknown/);
  assert.deepEqual(cleanRules([{ field: 'label', op: 'is', value: ' Mobile ', action: 'test', extra: 1 }]), [{ field: 'label', op: 'is', value: 'Mobile', action: 'test' }]);
});
