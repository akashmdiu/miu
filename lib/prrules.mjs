// Which pull requests Miu tests on its own: rules set in Settings. Each rule is
// "if <field> <op> <value>, then test | skip"; the first rule that matches a
// pull request decides, and the default covers the rest. A draft and the
// qa:skip label always skip. The Test button on a pull request ignores rules.
export const FIELDS = { repo: 'Repo', author: 'Author', label: 'Label', title: 'Title', branch: 'Branch', draft: 'Draft' };
export const OPS = { is: 'is', not: 'is not', contains: 'contains', starts: 'starts with' };
export const ACTIONS = { test: 'Test', skip: 'Skip' };

// The values a field has on a pull request (a label field has several).
function values(field, p) {
  switch (field) {
    case 'repo': return [p.repo, String(p.repo || '').split('/')[1]];
    case 'author': return [p.author?.login ?? p.author ?? ''];
    case 'label': return (p.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    case 'title': return [p.title ?? ''];
    case 'branch': return [p.headRefName ?? p.branch ?? ''];
    case 'draft': return [p.isDraft ? 'yes' : 'no'];
    default: return [];
  }
}

export function matches(rule, p) {
  const want = String(rule.value ?? '').trim().toLowerCase();
  const have = values(rule.field, p).map((v) => String(v ?? '').toLowerCase());
  const hit = (v) => (rule.op === 'contains' ? v.includes(want) : rule.op === 'starts' ? v.startsWith(want) : v === want);
  // "is not": none of the values is it (a PR with no such label, too).
  return rule.op === 'not' ? !have.some((v) => v === want) : have.some(hit);
}

// { action, index (or -1 for the default), rule }
export function decide(rules = [], fallback = 'test', p) {
  for (const [index, rule] of rules.entries()) if (matches(rule, p)) return { action: rule.action, index, rule };
  return { action: fallback === 'skip' ? 'skip' : 'test', index: -1, rule: null };
}

export const describe = (r) => `${FIELDS[r.field] ?? r.field} ${OPS[r.op] ?? r.op} "${r.value}"`;

// What the dashboard accepts from the page: known fields and words, a value, at most 50 rules.
export function cleanRules(input) {
  if (!Array.isArray(input)) throw new Error('Rules must be a list.');
  return input.slice(0, 50).map((r) => {
    const rule = { field: String(r?.field), op: String(r?.op), value: String(r?.value ?? '').trim().slice(0, 200), action: String(r?.action) };
    if (!FIELDS[rule.field] || !OPS[rule.op] || !ACTIONS[rule.action]) throw new Error('A rule has an unknown field, comparison or action.');
    if (!rule.value) throw new Error(`Rule "${FIELDS[rule.field]} ${OPS[rule.op]}" needs a value.`);
    if (rule.field === 'draft' && !['yes', 'no'].includes(rule.value.toLowerCase())) throw new Error('Draft is "yes" or "no".');
    return rule;
  });
}
