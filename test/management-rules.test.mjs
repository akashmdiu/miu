import test from 'node:test';
import assert from 'node:assert/strict';
import { toolRule } from '../lib/rules.mjs';

test('agent tools cannot inspect the private dependency authentication home', () => {
  assert.equal(typeof toolRule('Read', { file_path: '/synthetic/run/.dependency-home/auth.json' }), 'string');
  assert.equal(typeof toolRule('Bash', { command: 'cat /synthetic/run/.dependency-home/auth.json' }), 'string');
});
