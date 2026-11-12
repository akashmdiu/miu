import test from 'node:test';
import assert from 'node:assert/strict';
import { projectResult } from '../lib/management-result.mjs';

test('result projection exposes fixed verdict, mode and role-bound site identity only', () => {
  assert.deepEqual(projectResult({ verdict: 'not_ok', mode: 'full', privateExtra: 'excluded',
    sites: [{ role: 'dev', id: 'synthetic-site', privateExtra: 'excluded' }] }), {
    verdict: 'not_ok', mode: 'full', sites: [{ role: 'dev', id: 'synthetic-site' }],
  });
  assert.equal(projectResult(null), null);
});

test('malformed or ambiguous result identity cannot become completion metadata', () => {
  const base = { verdict: 'ok', mode: 'full', sites: [] };
  for (const value of [
    { ...base, verdict: 'provider response' }, { ...base, mode: 'unknown' },
    { ...base, sites: [{ role: 'pr', id: '/private/path' }] },
    { ...base, sites: [{ role: 'pr', id: 'one' }, { role: 'pr', id: 'two' }] },
  ]) assert.throws(() => projectResult(value), { code: 'operation_failed' });
});
