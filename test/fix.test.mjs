import test from 'node:test';
import assert from 'node:assert/strict';
import { findings, checkChange, commitMessage, outcome, branchProblem, checkProbe } from '../lib/fix.mjs';
import { fixToolRule } from '../lib/rules.mjs';

const results = {
  criteria: [
    { id: 1, claim: 'Saving keeps the value', results: { A: { status: 'pass' }, B: { status: 'fail', note: 'value lost after reload' } } },
    { id: 2, claim: 'The tab renders', results: { A: { status: 'pass' } } },
  ],
  issues: [
    { severity: 'blocker', title: 'Fatal on activation', user_impact: 'Site down', evidence: ['ev-1', 'ev-2'], code_ref: 'includes/a.php:4' },
    { severity: 'major', title: 'Seen once', evidence: ['ev-3'], unconfirmed: true },
    { severity: 'minor', title: 'Label typo', evidence: ['ev-4'] },
  ],
  business: [{ rule: 'Free never names Pro', status: 'conflicts', where: 'includes/b.php' }],
};

test('only confirmed blockers and majors, broken rules and failed claims are fixed', () => {
  const list = findings(results);
  assert.deepEqual(list.map((f) => f.title), ['Fatal on activation', 'Breaks: Free never names Pro', 'Claim 1 fails: Saving keeps the value']);
  assert.deepEqual(list.map((f) => f.id), ['F1', 'F2', 'F3']);
  assert.match(list[2].detail, /B: value lost/);
});

test('a change into vendor, a version bump or a huge diff is not pushed', () => {
  assert.deepEqual(checkChange([{ path: 'includes/a.php', added: 3, removed: 1 }], '+ $x = 1;'), []);
  assert.match(checkChange([{ path: 'vendor/x/y.php', added: 1, removed: 0 }]).join(), /may not touch/);
  assert.match(checkChange([{ path: '.github/workflows/ci.yml', added: 1, removed: 0 }]).join(), /may not touch/);
  assert.match(checkChange([{ path: 'shop.php', added: 1, removed: 1 }], '- * Version: 1.4.5\n+ * Version: 1.4.6').join(), /version/);
  assert.match(checkChange([{ path: 'a.js', added: 700, removed: 0 }]).join(), /700 lines/);
  assert.match(checkChange([]).join(), /no files/);
});

test('the commit message names no model or tool', () => {
  const msg = commitMessage({ subject: 'Keep the saved value after reload', body: 'The option was read before it was saved.\nGenerated with Claude Code\nCo-Authored-By: Claude <x@y>' }, [{ title: 'Claim 1 fails' }], { round: 2, sha: 'abcdef1234' });
  assert.match(msg, /^Keep the saved value after reload\n\nThe option was read before it was saved\.\n\nFixes what Miu found at abcdef1:\n- Claim 1 fails\n$/);
  assert.doesNotMatch(msg, /claude|co-authored/i);
  assert.match(commitMessage({ subject: 'Fix by ChatGPT' }, [{ title: 'X' }], { round: 1, sha: '1234567' }), /^Fix: X/);
});

test('what was fixed is matched to the findings by id', () => {
  const list = findings(results);
  const o = outcome({ fixed: [{ id: 'F1', how: 'guarded the call' }, { id: 'F9' }], not_fixed: [{ id: 'F2', why: 'needs a product call' }] }, list);
  assert.deepEqual(o.fixed.map((f) => f.id), ['F1']);
  assert.deepEqual(o.left.map((f) => [f.id, f.why]), [['F2', 'needs a product call'], ['F3', 'not attempted']]);
});

test('a fork or a long-lived branch gets no push', () => {
  assert.equal(branchProblem({ headRepo: 'acme/shop', headRefName: 'fix/fbs-1-x', baseRefName: 'dev' }, 'acme/shop'), null);
  assert.match(branchProblem({ headRepo: 'someone/shop', headRefName: 'fix/x', baseRefName: 'dev' }, 'acme/shop'), /fork/);
  assert.match(branchProblem({ headRepo: 'acme/shop', headRefName: 'dev', baseRefName: 'main' }, 'acme/shop'), /never goes/);
});

test('the fix agent edits only the worktree and never runs git that changes it', () => {
  const dirs = { workDir: '/c/wt/shop-fix', fixDir: '/r/.fixes/x' };
  assert.equal(fixToolRule('Edit', { file_path: '/c/wt/shop-fix/includes/a.php' }, dirs), null);
  assert.equal(fixToolRule('Write', { file_path: '/r/.fixes/x/fix.json' }, dirs), null);
  assert.match(fixToolRule('Write', { file_path: '/r/.fixes/x/findings.md' }, dirs), /fix\.json/);
  assert.match(fixToolRule('Edit', { file_path: '/c/wt/shop-fix/vendor/a.php' }, dirs), /vendor/);
  assert.match(fixToolRule('Edit', { file_path: '/c/wt/shop-fix/../shop-pr/a.php' }, dirs), /Change only/);
  assert.match(fixToolRule('Bash', { command: 'git commit -am x' }, dirs), /commits and pushes/);
  assert.match(fixToolRule('Bash', { command: 'curl https://example.com' }, dirs), /Only the QA site/);
  assert.equal(fixToolRule('Bash', { command: 'composer test:unit' }, dirs), null);
  assert.equal(fixToolRule('Bash', { command: 'git diff' }, dirs), null);
  assert.match(fixToolRule('Read', { file_path: '/home/qa/.config/miu/keys.enc.json' }, dirs), /off limits/);
});

test('with a site, a fix counts only when Miu\'s replay proved it', () => {
  const list = findings(results);
  const proven = (id) => ({ F1: true, F2: 'the probe already matched on the original code, so it does not show the problem' })[id] ?? 'no probe was replayed';
  const o = outcome({ fixed: [{ id: 'F1', how: 'x', before: ['ev-001'], after: ['ev-002'] }, { id: 'F2', how: 'y' }, { id: 'F3', how: 'z' }] }, list, { site: true, proven });
  assert.deepEqual(o.fixed.map((f) => [f.id, f.before, f.after]), [['F1', ['ev-001'], ['ev-002']]]);
  assert.match(o.left.find((f) => f.id === 'F2').why, /not proven: the probe already matched/);
  assert.match(o.left.find((f) => f.id === 'F3').why, /no probe was replayed/);
});

test('a probe is a site path or a wp-cli command, never somewhere else', () => {
  assert.ok(checkProbe({ setup: [['option', 'update', 'a', '1']], http: { path: '/p/', headers: { Accept: 'image/webp', 'Bad Header': 'x' } }, expect: 'imagesrcset=' }).probe.http.headers.Accept);
  assert.deepEqual(Object.keys(checkProbe({ http: { path: '/p/', headers: { 'Bad Header': 'x' } }, expect: 'a' }).probe.http.headers), []);
  assert.match(checkProbe({ http: { path: 'https://evil.example/' }, expect: 'a' }).error, /path on the site/);
  assert.match(checkProbe({ http: { path: '//evil.example/' }, expect: 'a' }).error, /path on the site/);
  assert.match(checkProbe({ setup: [['db', 'query', 'DROP TABLE x']], wp: ['option', 'get', 'a'], expect: 'a' }).error, /may not use wp db/);
  assert.match(checkProbe({ setup: [['option', 'get', 'a', '--path=/home']], wp: ['option', 'get', 'a'], expect: 'a' }).error, /elsewhere/);
  assert.match(checkProbe({ wp: ['option', 'get', 'a'], expect: '(' }).error, /regular expression/);
  assert.match(checkProbe({ wp: ['option', 'get', 'a'] }).error, /no expect/);
  assert.equal(checkProbe({ same_as: 'F2' }).probe.same_as, 'F2');
});

test('the fix agent reaches the QA site and nothing else', () => {
  const dirs = { workDir: '/c/wt/shop-fix', fixDir: '/r/.fixes/x' };
  assert.equal(fixToolRule('Bash', { command: 'curl -sI https://qa-fix.rex/' }, dirs), null);
  assert.equal(fixToolRule('Bash', { command: 'qa-evidence http hero -sS https://qa-fix.rex:8443/' }, dirs), null);
  assert.match(fixToolRule('Bash', { command: 'curl https://evil.example/x' }, dirs), /Only the QA site/);
  assert.match(fixToolRule('Bash', { command: 'wp option get home --path=/x' }, dirs), /site_wp_run/);
  assert.match(fixToolRule('Bash', { command: 'cat ~/rexenv/Sites/qa-fix.rex/wp-config.php' }, dirs), /site folders/);
});
