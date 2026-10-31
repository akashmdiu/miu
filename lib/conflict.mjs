// The note Miu leaves on a pull request it will not test because of merge
// conflicts. One comment per commit; a "Needs Rebase" label that the next test
// start takes off again.
import { setLabels } from './publish.mjs';
import { rest, restAll } from './github.mjs';
import { project } from './project.mjs';

export const REBASE_LABEL = 'Needs Rebase';
// Whether a comment carrying this marker is on the PR already.
const asked = async (repo, pr, mark) => (await restAll(`repos/${repo}/issues/${pr}/comments`)).some((c) => (c.body ?? '').includes(mark));
const comment = async (repo, pr, body) => (await rest('POST', `repos/${repo}/issues/${pr}/comments`, { body: { body } })).html_url;
const MARK = (sha) => `<!-- miu-conflict sha=${sha} -->`;

export async function askToResolve({ repo, pr, sha, author, base, files, log = () => {} }) {
  if (await asked(repo, pr, MARK(sha))) { log('conflict: already asked for this commit'); return; }
  const list = files.length ? `\n\nFiles in conflict:\n${files.slice(0, 20).map((f) => `- \`${f}\``).join('\n')}${files.length > 20 ? `\n- and ${files.length - 20} more` : ''}` : '';
  const body = `${author ? `@${author} ` : ''}This pull request has merge conflicts with \`${base}\`, so it has not been tested yet: the code that would be merged depends on how the conflicts are resolved.${list}

Please rebase on \`${base}\` (or merge \`${base}\` in), resolve the conflicts and push. Miu tests it again when the new commit arrives.

<sub>Miu, at \`${sha.slice(0, 7)}\`</sub>
${MARK(sha)}
<!-- ${project().marker}-conflict -->`;
  const url = await comment(repo, pr, body);
  log(`conflict: asked the author to resolve, ${url}`);
  try { await setLabels(repo, pr, { add: [REBASE_LABEL], remove: [] }); } catch (e) { log(`conflict: label not added: ${e.message.split('\n')[0]}`); }
  return url;
}

export const ALREADY_LABEL = 'Already In Dev';
const MARK2 = (sha) => `<!-- miu-already sha=${sha} -->`;

// Every line of the PR is already in the base branch: merging it changes
// nothing. Miu never closes a PR; it asks the author to check.
export async function askToClose({ repo, pr, sha, author, base, log = () => {} }) {
  if (await asked(repo, pr, MARK2(sha))) { log('already in base: already asked for this commit'); return; }
  const body = `${author ? `@${author} ` : ''}Merging this pull request into \`${base}\` would change nothing: everything in it is already in \`${base}\`, most likely through another pull request. It has not been tested.

Please check, and close it if it is no longer needed. If something here is still missing from \`${base}\`, push it and Miu tests the new commit.

<sub>Miu, at \`${sha.slice(0, 7)}\`</sub>
${MARK2(sha)}
<!-- ${project().marker}-conflict -->`;
  const url = await comment(repo, pr, body);
  log(`already in base: asked the author to check, ${url}`);
  try { await setLabels(repo, pr, { add: [ALREADY_LABEL], remove: [] }); } catch (e) { log(`already in base: label not added: ${e.message.split('\n')[0]}`); }
  return url;
}
