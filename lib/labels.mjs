// The PR labels of the team's QA flow, by role. Settings → GitHub and notices
// edits them (runs/.config.json `labels`); the dashboard hands them to each
// run with --labels, so a run and the dashboard always agree.
//
// The flow: a request label asks Miu to test. Miu passes it to a person
// (miuOk) or reports what it found (miuBugs). The person's own labels
// (humanOk, humanBugs) are a QA result Miu reads but never puts on.
export const ROLES = {
  request: { list: true, title: 'Ask Miu to test', help: 'Any of these on a pull request starts a test. Miu takes them off when it starts.' },
  ongoing: { title: 'Testing now', help: 'On while a test runs, by Miu or a person.' },
  miuOk: { title: 'Miu found it OK', help: 'Miu puts this on when its test passes, for a person to test next.' },
  miuBugs: { title: 'Miu found an issue', help: 'Miu puts this on when its test finds a problem.' },
  humanOk: { list: true, title: 'A person found it OK', help: 'A person puts this on. Miu reads it as tested and does not test that commit again.' },
  humanBugs: { list: true, title: 'A person found an issue', help: 'A person puts this on. Miu reads it as tested, with problems.' },
  retest: { title: 'Needs another test', help: 'Miu puts this on when new commits land during its test.' },
  tested: { title: 'Tested by Miu', help: 'Miu puts this on every pull request it reports on.' },
  skip: { title: 'Never test', help: 'Miu leaves a pull request with this label alone.' },
};

export const DEFAULT_LABELS = {
  request: ['Ready for Miu Testing', 'Ready For Testing', 'Needs Re-Test'],
  ongoing: 'Test Ongoing',
  miuOk: 'Ready for Human Testing',
  miuBugs: 'Miu Tested & Reported Issue',
  humanOk: ['Tested & Ready For Merge'],
  // "Tested & Reported Bugs" is the older name; PRs labelled before still count.
  humanBugs: ['Tested & Reported Issue', 'Tested & Reported Bugs'],
  retest: 'Needs Re-Test',
  tested: 'Miu Tested',
  skip: 'Miu Skip',
};

// GitHub allows 50 characters; commas split a list, so a name has none.
const cleanName = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.length > 50 || /[,\n\r]/.test(s)) throw new Error(`"${s.slice(0, 50)}" is not a label name.`);
  return s;
};

// Saved names over the defaults; an empty or broken entry falls back.
export function labelNames(saved) {
  const out = { ...DEFAULT_LABELS };
  for (const [k, role] of Object.entries(ROLES)) {
    const v = saved?.[k];
    if (v === undefined) continue;
    try {
      if (role.list) {
        const list = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map(cleanName).filter(Boolean))];
        if (list.length) out[k] = list.slice(0, 10);
      } else {
        const one = cleanName(Array.isArray(v) ? v[0] : v);
        if (one) out[k] = one;
      }
    } catch { /* keep the default */ }
  }
  return out;
}

// What the page sends: { role: value }. Throws on a bad name, unlike labelNames.
export function cleanPatch(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Labels must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const role = ROLES[k];
    if (!role) throw new Error(`${String(k).slice(0, 30)} is not a label role.`);
    if (role.list) {
      const list = [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(cleanName).filter(Boolean))];
      if (!list.length) throw new Error(`${role.title} needs at least one label.`);
      out[k] = list.slice(0, 10);
    } else {
      const one = cleanName(v);
      if (!one) throw new Error(`${role.title} needs a label.`);
      out[k] = one;
    }
  }
  return out;
}
