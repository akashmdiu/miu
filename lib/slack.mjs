// One-line notice in Slack when Miu posts a result on a pull request. Off
// until the dashboard's Slack switch is on, and optional: it needs a channel
// (project.json `slack_channel` or MIU_SLACK_CHANNEL) and SLACK_USER_TOKEN,
// from the environment or the env file named by MIU_SLACK_ENV (token only).
import fs from 'node:fs';
import { project, profileOf } from './project.mjs';

export const slackChannel = () => project().slack_channel;

function token() {
  if (process.env.SLACK_USER_TOKEN) return process.env.SLACK_USER_TOKEN;
  for (const f of process.env.MIU_SLACK_ENV ? [process.env.MIU_SLACK_ENV] : []) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^SLACK_USER_TOKEN=["']?([^"'\n]+)/m);
      if (m) return m[1].trim();
    } catch { /* next */ }
  }
  return null;
}

const MARK = { ok: '✅ Found OK', partial: '🔁 Found partially OK', not_ok: '❌ Found NOT OK' };

// verdict, repo ("owner/name"), pr number, title, round, url of the comment.
export async function notify({ verdict, repo, pr, title, round, url, stale }) {
  if (!MARK[verdict]) return { skipped: 'no result to announce' };
  if (!slackChannel()) return { skipped: 'no Slack channel set' };
  const t = token();
  if (!t) return { skipped: 'no SLACK_USER_TOKEN' };
  const name = profileOf(repo)?.label ?? repo;
  const text = `${MARK[verdict]} · ${name} #${pr} ${title}${round > 1 ? ` · round ${round}` : ''}${stale ? ' · tested an older commit, needs another test' : ''}\n${url}`;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: slackChannel().replace(/^#/, ''), text, unfurl_links: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Slack: ${body.error ?? res.status}`);
  return { ok: true, ts: body.ts };
}
