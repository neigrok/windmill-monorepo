// The account-level list of roadmaps and the door that plants one, credentialed by cookie. Reads
// degrade to [] whenever the registry can't answer; a 401 surfaces as an AuthError.

import { AuthError } from '../../../shell/auth/AuthClient.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { LocalTreeRegistry, resolveDeviceOwner } from './LocalTreeRegistry.js';

// One row per owned roadmap: { id, title, done, total, updatedAt }.
export async function listTrees() {
  try {
    const response = await fetch(`${API_BASE}/v1/trees`, { credentials: 'include' });
    if (!response.ok) return [];
    const body = await response.json();
    return body.trees ?? [];
  } catch {
    return [];
  }
}

// The account's server trees united with this device's own, deduped by id with the server row
// winning. Rows carry their origin: 'server' rows PATCH/DELETE the registry, 'device' rows only
// touch local seams. Device rows use the holder confirmed by the server or restored bound replica.
export async function listAllTrees() {
  const [owner, server] = await Promise.all([resolveDeviceOwner(), fetchServerList()]);
  const registry = new LocalTreeRegistry();
  const serverIds = new Set(server.rows.map((tree) => tree.id));
  // Attribution requires an authoritative server list and a resolved device holder.
  if (server.authoritative && owner) {
    registry.attribute([...serverIds], owner);
    // Unclaimed entries are local-born and waiting to claim; those always stay.
    registry.list(owner).filter((tree) => tree.claimed && !serverIds.has(tree.id))
      .forEach((tree) => registry.remove(tree.id));
  }
  const device = registry.list(owner).filter((tree) => !serverIds.has(tree.id));
  return [
    ...server.rows.map((tree) => ({ ...tree, origin: 'server' })),
    ...device.map((tree) => ({ ...tree, origin: 'device' })),
  ].sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
}

// `authoritative` says whether an empty list means anything: a 200 is the account's true list, a
// 401 or a dead network vouches for nothing.
async function fetchServerList() {
  try {
    const response = await fetch(`${API_BASE}/v1/trees`, { credentials: 'include' });
    if (!response.ok) return { rows: [], authoritative: false };
    const body = await response.json();
    return { rows: body.trees ?? [], authoritative: true };
  } catch {
    return { rows: [], authoritative: false };
  }
}

function timestampOf(updatedAt) {
  if (typeof updatedAt === 'number') return updatedAt;
  const parsed = Date.parse(updatedAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

// Plants a roadmap → { treeId, existed }. `request` is the starting TreeData; omit `nodes`/`kinds`
// for an empty tree with the default legend. A client-minted `id` (t_ + 16 hex) is kept by the
// server: `existed: true` is its idempotent resume, 409 { code: 'id-taken' } a remap signal, and
// 409 { code: 'id-retired' } an id this account deleted, which must be let go of, never remapped.
export async function createTree(request) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) return response.json();
  if (response.status === 401) throw new AuthError('Sign in to plant a roadmap', { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  throw new AuthError('Could not plant the roadmap', { code: body.code, said: typeof body.error === 'string' ? body.error : undefined, status: response.status });
}

// One register of a roadmap, its owner's alone (PATCH /v1/trees/:id, 204): `refused` names the 401 and `failed`
// every other refusal, which keeps the server's code, sentence and detail.
async function patchTree(treeId, change, { refused, failed }) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees/${treeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) return;
  if (response.status === 401) throw new AuthError(refused, { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  throw new AuthError(failed, { code: body.code, said: typeof body.error === 'string' ? body.error : undefined, detail: body.detail, status: response.status });
}

// Retitle a roadmap. The server trims and refuses a blank.
export function renameTree(treeId, title) {
  return patchTree(treeId, { title }, { refused: 'Sign in to rename a roadmap', failed: 'Could not rename the roadmap' });
}

// Set a roadmap's visibility. 'private' ⇒ owner-only reads; 'unlisted'/'public' ⇒ anyone with the link.
export function setVisibility(treeId, visibility) {
  return patchTree(treeId, { visibility }, { refused: 'Sign in to change visibility', failed: 'Could not change visibility' });
}

// Set a roadmap's guide; an empty one removes it. The server refuses one past its 5,000 code points with a 400.
export function setGuide(treeId, guide) {
  return patchTree(treeId, { guide }, { refused: 'Sign in to write a guide', failed: 'Could not save the guide' });
}

// Retire a roadmap (DELETE /v1/trees/:id, 204 — a soft delete; it leaves every list).
export async function deleteTree(treeId) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees/${treeId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Sign in to delete a roadmap', { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  throw new AuthError('Could not delete the roadmap', { code: body.code, said: typeof body.error === 'string' ? body.error : undefined, status: response.status });
}

// Forks a shared roadmap → { treeId }. The server mints the id; progress starts cleared.
export async function forkTree(sourceId) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees/${sourceId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) {
    const body = await response.json();
    return { treeId: body.data.id };
  }
  if (response.status === 401) throw new AuthError('Sign in to fork', { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  throw new AuthError('Could not fork the roadmap', { code: body.code, said: typeof body.error === 'string' ? body.error : undefined, status: response.status });
}
