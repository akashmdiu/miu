import test from 'node:test';
import assert from 'node:assert/strict';
import { autoPick, lowerEffort } from '../lib/autopick.mjs';

test('a small pull request gets the fast model and low effort', () => {
  assert.deepEqual(autoPick({ engine: 'codex', depth: 'quick', areas: {} }), { model: 'gpt-6.1-sol', effort: 'low', why: 'quick pull request' });
  assert.equal(autoPick({ engine: 'claude', depth: 'quick' }).model, 'claude-sonnet-5-5');
});

test('a large pull request gets the strongest model, and security raises the effort', () => {
  const p = autoPick({ engine: 'codex', depth: 'deep', areas: { security: true, ui: true } });
  assert.equal(p.model, 'gpt-6-astra');
  assert.equal(p.effort, 'xhigh');
  assert.match(p.why, /security/);
  assert.equal(autoPick({ engine: 'codex', depth: 'deep', areas: { ui: true } }).effort, 'high');
});

test('a medium pull request touching the database gets high effort', () => {
  assert.equal(autoPick({ engine: 'claude', depth: 'standard', areas: { db: true } }).effort, 'high');
  assert.equal(autoPick({ engine: 'claude', depth: 'standard', areas: {} }).effort, 'medium');
});

test('the passes after the main one run a level lower, never below low', () => {
  assert.equal(lowerEffort('xhigh'), 'high');
  assert.equal(lowerEffort('low'), 'low');
  assert.equal(lowerEffort(undefined), undefined);
});
