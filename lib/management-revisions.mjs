import { rest } from './github.mjs';
import { withGitHubPolicy } from './github-policy.mjs';

/** Resolve immutable revisions without loading diff, comments, or ambient identity. */
export async function readManagedRevisions(repository, pr) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
      || repository.split('/').some((part) => part === '.' || part === '..')
      || !Number.isSafeInteger(pr) || pr < 1) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
  const repo = repository.toLowerCase();
  return withGitHubPolicy({ mode: 'app-only', repositories: [repo] }, async () => {
    const result = await rest('GET', `repos/${repo}/pulls/${pr}`);
    const baseSha = result?.base?.sha;
    const headSha = result?.head?.sha;
    if (![baseSha, headSha].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) {
      throw Object.assign(new Error('invalid_revision'), { code: 'invalid_revision' });
    }
    return Object.freeze({ baseSha, headSha });
  });
}
