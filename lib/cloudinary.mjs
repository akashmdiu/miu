// Cloudinary's Admin API for Miu's report screenshots (the project's folder, project.json `cloudinary_folder`):
// how much of the plan is used, which images there are, and removing old ones.
// The free plan has 25 credits a month, shared by storage, views and
// transformations, so screenshots of pull requests closed a while ago go.
import { project } from './project.mjs';
import { cloudinaryUrl } from './publish.mjs';

function account() {
  const u = cloudinaryUrl();
  if (!u) return null;
  const { username, password, hostname } = new URL(u);
  return { cloud: hostname, auth: 'Basic ' + Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64') };
}

async function admin(method, pathAndQuery) {
  const a = account();
  if (!a) throw new Error('Cloudinary is not set up');
  const res = await fetch(`https://api.cloudinary.com/v1_1/${a.cloud}/${pathAndQuery}`, { method, headers: { Authorization: a.auth }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudinary ${method} ${pathAndQuery.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

// { used, limit, percent } in credits for this month, or null without Cloudinary.
export async function usage() {
  if (!account()) return null;
  const u = await admin('GET', 'usage');
  const c = u.credits ?? {};
  return { used: c.usage ?? null, limit: c.limit ?? null, percent: c.used_percent ?? null, storageBytes: u.storage?.usage ?? null };
}

// Every image in that folder: [{ public_id, created_at, bytes }].
export async function listShots() {
  const out = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ type: 'upload', prefix: `${project().cloudinary_folder}/`, max_results: '500', ...(cursor ? { next_cursor: cursor } : {}) });
    const r = await admin('GET', `resources/image/upload?${q}`);
    out.push(...(r.resources ?? []).map((x) => ({ public_id: x.public_id, created_at: x.created_at, bytes: x.bytes })));
    cursor = r.next_cursor ?? null;
  } while (cursor && out.length < 20000);
  return out;
}

export async function deleteShots(ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const q = new URLSearchParams(); for (const id of ids.slice(i, i + 100)) q.append('public_ids[]', id);
    await admin('DELETE', `resources/image/upload?${q}`);
    n += Math.min(100, ids.length - i);
  }
  return n;
}
