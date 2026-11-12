import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const legacy = Object.freeze({ mode: 'legacy' });
let processPolicy;

function freezePolicy(policy) {
  if (!policy || policy.mode !== 'app-only' || !Array.isArray(policy.repositories) || !policy.repositories.length ||
      policy.repositories.some((r) => typeof r !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)
        || r.split('/').some((part) => part === '.' || part === '..'))) {
    throw Object.assign(new Error('invalid GitHub policy'), { code: 'invalid_policy' });
  }
  return Object.freeze({ mode: 'app-only', repositories: Object.freeze([...new Set(policy.repositories.map((r) => r.toLowerCase()))]) });
}

export function currentGitHubPolicy() { return context.getStore() ?? processPolicy ?? legacy; }
export function configureGitHubPolicy(policy) {
  if (processPolicy) throw Object.assign(new Error('GitHub policy already configured'), { code: 'policy_already_configured' });
  processPolicy = freezePolicy(policy);
  return processPolicy;
}
export function withGitHubPolicy(policy, callback) {
  const parent = currentGitHubPolicy();
  if (parent.mode === 'app-only' && policy?.mode !== 'app-only') {
    throw Object.assign(new Error('GitHub policy cannot be downgraded'), { code: 'policy_downgrade' });
  }
  const next = freezePolicy(policy);
  if (parent.mode === 'app-only' && next.repositories.some((r) => !parent.repositories.includes(r))) {
    throw Object.assign(new Error('GitHub policy cannot be downgraded'), { code: 'policy_downgrade' });
  }
  return context.run(next, callback);
}
export function assertGitHubRepository(repo) {
  const policy = currentGitHubPolicy();
  if (policy.mode === 'app-only' && (typeof repo !== 'string' || !policy.repositories.includes(repo.toLowerCase()))) {
    throw Object.assign(new Error('GitHub repository is not allowed'), { code: 'repository_not_allowed' });
  }
  return repo;
}
