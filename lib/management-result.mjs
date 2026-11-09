const VERDICTS = new Set(['ok', 'partial', 'not_ok', 'already_fixed', 'inconclusive', 'no_result']);
const fail = () => { throw Object.assign(new Error('invalid_result'), { code: 'operation_failed' }); };

/** A finite projection: no report text, URLs, paths, provider responses, or logs. */
export function projectResult(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.verdict !== null && !VERDICTS.has(value.verdict))
      || (value.mode !== null && !['full', 'light'].includes(value.mode))
      || !Array.isArray(value.sites) || value.sites.length > 2) fail();
  const roles = new Set();
  const sites = value.sites.map((site) => {
    if (!site || !['pr', 'dev'].includes(site.role) || roles.has(site.role)
        || typeof site.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(site.id)) fail();
    roles.add(site.role);
    return { role: site.role, id: site.id };
  });
  return { verdict: value.verdict, mode: value.mode, sites };
}
