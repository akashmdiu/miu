import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCliArguments, parseQaArguments } from '../lib/management-cli-intent.mjs';
const context = { repo: 'owner/repo', pr: 1, model: 'gpt-6.1-sol', authMode: 'api' };

test('worker option parsing cannot interpret a note value as a control flag', () => {
  const args = parseQaArguments(['--note', '--force', '--auth', 'api']);
  assert.equal(args.flag('--force'), false);
  assert.equal(args.option('--note'), '--force');
  assert.equal(args.option('--auth'), 'api');
});

test('configured CLI defaults to report-only and the server-selected authentication mode', () => {
  const value = prepareCliArguments([], context);
  assert.equal(value.mode, 'report-only');
  assert.equal(value.authMode, 'api');
  assert.equal(value.argv.includes('--dry-run'), true);
  assert.equal(value.argv[value.argv.indexOf('--auth') + 1], 'api');
});

test('publication requires an explicit flag and cannot be hidden in a note value', () => {
  assert.equal(prepareCliArguments(['--publish'], context).mode, 'publish');
  assert.equal(prepareCliArguments(['--note', '--publish'], context).mode, 'report-only');
  assert.throws(() => prepareCliArguments(['--publish', '--dry-run'], context), { code: 'invalid_arguments' });
  assert.throws(() => prepareCliArguments(['--auth', 'plan'], context), { code: 'engine_unavailable' });
});

test('internal control flags are excluded and duplicate or unknown inputs are refused', () => {
  const result = prepareCliArguments(['--request-id', 'same', '--management-dir', '/private/state'], context);
  assert.equal(result.argv.includes('--request-id'), false);
  assert.equal(result.argv.includes('/private/state'), false);
  assert.throws(() => prepareCliArguments(['--model', 'one', '--model', 'two'], context), { code: 'invalid_arguments' });
  assert.throws(() => prepareCliArguments(['--unknown'], context), { code: 'invalid_arguments' });
});
