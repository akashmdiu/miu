// What GitHub says about a pull request's QA, beyond Miu's own runs: who last
// reported on it (a person or Miu), whether commits landed after that report,
// and who put "Test Ongoing" on it. The dashboard uses this so a PR a person
// already tested, or one a developer fixed after a report, shows as such.
//
// One GraphQL query covers up to 20 PRs (aliases). Results are cached per PR
// by its updatedAt, so a refresh only asks about PRs that changed.
import { project } from './project.mjs';
import { graphql, validRepo } from './github.mjs';
import { DEFAULT_LABELS, labelNames } from './labels.mjs';

const cache = new Map(); // "owner/name#n" -> { updatedAt, qa }

const VERDICT = [
  [/FOUND\s+NOT\s+OK/i, 'not_ok'],
  [/FOUND\s+PARTIALLY\s+OK/i, 'partial'],
  [/FOUND\s+OK/i, 'ok'],
];
// A person's result labels, and "testing now" (Settings, lib/labels.mjs).
let names = DEFAULT_LABELS;
export function setLabelNames(saved) { names = labelNames(saved); cache.clear(); }
const M = project().marker;
const isMiu = (body) => body.includes(`<!-- ${M} pr=`);
const isMiuNote = (body) => new RegExp(`<!-- ${M}-(superseded|conflict) -->`).test(body);

function verdictOf(body) {
  const head = body.split('\n').slice(0, 6).join('\n');
  for (const [re, v] of VERDICT) if (re.test(head)) return v;
  return null;
}

// The QA picture of one PR from its recent comments, head commit and label events.
export function qaFrom(node) {
  const comments = node?.comments?.nodes ?? [];
  const reports = [];
  for (const c of comments) {
    const body = c.body ?? '';
    if (isMiu(body) && isMiuNote(body)) continue;
    const verdict = verdictOf(body);
    if (!verdict) continue;
    reports.push({
      by: c.author?.login ?? 'someone',
      kind: isMiu(body) ? 'miu' : 'person',
      verdict, at: c.createdAt, url: c.url,
      sha: body.match(new RegExp(`<!-- ${M}-sha=([0-9a-f]+) -->`))?.[1] ?? null,
    });
  }
  const last = reports.at(-1) ?? null;
  const lastPerson = [...reports].reverse().find((r) => r.kind === 'person') ?? null;
  const head = node?.commits?.nodes?.[0]?.commit ?? null;
  const events = node?.timelineItems?.nodes ?? [];
  // When the code last changed: the head commit's date, or a force push after
  // it (a rebase keeps old commit dates).
  const pushes = events.filter((e) => e?.__typename === 'HeadRefForcePushedEvent').map((e) => Date.parse(e.createdAt));
  const headAt = Math.max(head ? Date.parse(head.committedDate) : 0, ...pushes, 0);
  // Miu's report names its commit; anything else is compared by time.
  const after = (r) => !!(r && head && (r.sha ? !head.oid.startsWith(r.sha) && r.sha !== head.oid : headAt > Date.parse(r.at)));
  // A person's result label is a report too: the last one still on the PR,
  // with who added it and when.
  const labelEvents = events.filter((e) => e?.label);
  const on = new Map();
  for (const e of labelEvents) {
    if (e.__typename === 'LabeledEvent') on.set(e.label.name, e); else on.delete(e.label.name);
  }
  const qaLabel = [...names.humanOk, ...names.humanBugs].map((n) => on.get(n)).filter(Boolean).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
  const labelReport = qaLabel ? { by: qaLabel.actor?.login ?? 'someone', kind: 'label', verdict: names.humanOk.includes(qaLabel.label.name) ? 'ok' : 'bugs', at: qaLabel.createdAt, label: qaLabel.label.name, url: null, sha: null } : null;
  const ongoing = [...labelEvents].reverse().find((e) => e.label.name === names.ongoing && e.__typename === 'LabeledEvent');
  return {
    last, lastPerson, labelReport,
    newCommitsSince: after(last),
    newCommitsSincePerson: after(lastPerson),
    newCommitsSinceLabel: after(labelReport),
    head: head ? { sha: head.oid, at: new Date(headAt || Date.parse(head.committedDate)).toISOString() } : null,
    ongoingBy: ongoing?.actor?.login ?? null,
  };
}

const FIELDS = `number updatedAt
  comments(last: 25) { nodes { author { login } createdAt url body } }
  commits(last: 1) { nodes { commit { oid committedDate } } }
  timelineItems(last: 40, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { __typename
    ... on LabeledEvent { createdAt actor { login } label { name } }
    ... on UnlabeledEvent { createdAt actor { login } label { name } }
    ... on HeadRefForcePushedEvent { createdAt } } }`;

// Through lib/github.mjs (App token when installed). Repo names and numbers
// are checked before they reach a query.
const okRepo = (r) => { if (!validRepo(r)) throw new Error('not a repo name'); return r.split('/'); };
const okNum = (n) => { const v = Number(n); if (!Number.isInteger(v) || v < 1) throw new Error('not a PR number'); return v; };

// prs: [{ repo: 'owner/x', number, updatedAt }]. Returns Map key -> qa.
export async function qaSignals(prs) {
  const out = new Map();
  const need = [];
  for (const p of prs) {
    const key = `${p.repo}#${p.number}`;
    const hit = cache.get(key);
    if (hit && hit.updatedAt === p.updatedAt) out.set(key, hit.qa);
    else need.push(p);
  }
  const byRepo = new Map();
  for (const p of need) (byRepo.get(p.repo) ?? byRepo.set(p.repo, []).get(p.repo)).push(p);
  for (const [repo, list] of byRepo) {
    const [owner, name] = okRepo(repo);
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      try {
        // Aliases need the numbers in the text: they are checked integers.
        const data = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${chunk.map((p) => `p${okNum(p.number)}: pullRequest(number: ${okNum(p.number)}) { ${FIELDS} }`).join('\n')} } }`, { owner, name });
        for (const p of chunk) {
          const node = data.repository[`p${p.number}`];
          const qa = qaFrom(node);
          cache.set(`${repo}#${p.number}`, { updatedAt: p.updatedAt, qa });
          out.set(`${repo}#${p.number}`, qa);
        }
      } catch (e) {
        console.error(`qa signals for ${repo}: ${e.message}`);
      }
    }
  }
  return out;
}

// A PR's whole conversation, GitHub style: comments, commits, label changes,
// reviews, force pushes, merges. Fetched when someone opens it.
const historyCache = new Map();
export async function prHistory(repo, number) {
  const key = `${repo}#${number}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
  const [owner, name] = okRepo(repo);
  const data = (await graphql(`query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    number title url body createdAt author { login avatarUrl } headRefName baseRefName state isDraft
    timelineItems(last: 150, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_COMMIT, LABELED_EVENT, UNLABELED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_REVIEW, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes { __typename
      ... on IssueComment { id createdAt url body author { login avatarUrl } }
      ... on PullRequestCommit { commit { oid abbreviatedOid messageHeadline committedDate author { user { login avatarUrl } name avatarUrl } } }
      ... on LabeledEvent { createdAt actor { login avatarUrl } label { name color } }
      ... on UnlabeledEvent { createdAt actor { login avatarUrl } label { name color } }
      ... on HeadRefForcePushedEvent { createdAt actor { login avatarUrl } afterCommit { abbreviatedOid } }
      ... on PullRequestReview { createdAt url state body author { login avatarUrl } }
      ... on MergedEvent { createdAt actor { login avatarUrl } }
      ... on ClosedEvent { createdAt actor { login avatarUrl } }
      ... on ReopenedEvent { createdAt actor { login avatarUrl } }
      ... on ReadyForReviewEvent { createdAt actor { login avatarUrl } }
      ... on ConvertToDraftEvent { createdAt actor { login avatarUrl } } } } } } }`, { owner, name, n: okNum(number) })).repository.pullRequest;
  const items = data.timelineItems.nodes.map((n) => {
    switch (n.__typename) {
      case 'IssueComment': return { type: 'comment', at: n.createdAt, by: n.author?.login, av: n.author?.avatarUrl, url: n.url, body: n.body, miu: isMiu(n.body ?? ''), verdict: verdictOf(n.body ?? ''), superseded: isMiuNote(n.body ?? '') };
      case 'PullRequestCommit': return { type: 'commit', at: n.commit.committedDate, by: n.commit.author?.user?.login ?? n.commit.author?.name, av: n.commit.author?.user?.avatarUrl ?? n.commit.author?.avatarUrl, sha: n.commit.abbreviatedOid, text: n.commit.messageHeadline };
      case 'LabeledEvent': return { type: 'label', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, label: n.label.name, color: n.label.color, added: true };
      case 'UnlabeledEvent': return { type: 'label', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, label: n.label.name, color: n.label.color, added: false };
      case 'HeadRefForcePushedEvent': return { type: 'forcepush', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, sha: n.afterCommit?.abbreviatedOid };
      case 'PullRequestReview': return { type: 'review', at: n.createdAt, by: n.author?.login, av: n.author?.avatarUrl, url: n.url, state: n.state, body: n.body };
      case 'MergedEvent': return { type: 'event', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, text: 'merged this pull request' };
      case 'ClosedEvent': return { type: 'event', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, text: 'closed this pull request' };
      case 'ReopenedEvent': return { type: 'event', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, text: 'reopened this pull request' };
      case 'ReadyForReviewEvent': return { type: 'event', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, text: 'marked this ready for review' };
      case 'ConvertToDraftEvent': return { type: 'event', at: n.createdAt, by: n.actor?.login, av: n.actor?.avatarUrl, text: 'marked this as a draft' };
      default: return null;
    }
  }).filter(Boolean);
  const value = { repo, number: data.number, title: data.title, url: data.url, body: data.body, author: data.author?.login, authorAv: data.author?.avatarUrl, createdAt: data.createdAt, head: data.headRefName, base: data.baseRefName, state: data.state, isDraft: data.isDraft, items };
  historyCache.set(key, { at: Date.now(), value });
  return value;
}
