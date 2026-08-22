// The per-user tree registry (F1·F2): the account-level list of roadmaps and the
// door that plants a new one. Distinct from HttpTreeRepository, which is scoped to a
// single tree — this is the "which trees do I own" surface the TreeSwitcher reads and
// the birth canvas writes to. Credentialed (X6 cookie); a signed-in concern.
//
// list() degrades to [] whenever the registry can't answer (not built yet, offline,
// signed out) so the switcher still shows the current tree + New tree. create() is the
// signed-in plant path (POST /v1/trees); a 401
// surfaces as an AuthError the birth canvas turns into a sign-in prompt.

import { AuthError } from '../../../shell/auth/AuthClient.js';
import { API_BASE } from '../../../shell/apiBase.js';
import { LocalTreeRegistry, resolveDeviceOwner } from './LocalTreeRegistry.js';

// One row per owned roadmap: { id, title, done, total, updatedAt }. Missing fields are
// the backend's to fill; the switcher renders whatever it gets and skips the rest.
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

// The switcher's one list (anon-first-tree F3): the account's server trees united with
// this device's own. Dedupe by id — the server row wins (its counts are live, and a
// just-claimed tree keeps its flipped device entry only for signed-out listing). Rows
// carry their origin so the switcher can tag them and route their edits: 'server' rows
// PATCH/DELETE the registry, 'device' rows only ever touch local seams.
//
// The device half is scoped to the account the SERVER says is holding this browser, never
// to the remembered marker: a signed-out browser lists its own anonymous work and nothing
// else, and one account never sees another's rows (audit WEB-4 — a 401 used to leave every
// device entry standing, which is how the next person was auto-navigated into a private
// tree). The two answers are asked for together so the scope costs no extra round trip.
export async function listAllTrees() {
  const [owner, server] = await Promise.all([resolveDeviceOwner(), fetchServerList()]);
  const registry = new LocalTreeRegistry();
  const serverIds = new Set(server.rows.map((tree) => tree.id));
  // Both halves have to be true to touch the index: the list is the account's whole truth, and
  // we know WHICH account it is. A list that arrived while /v1/me blipped names rows we cannot
  // attribute — stamping them anonymous would offer this account's trees to the next one.
  if (server.authoritative && owner) {
    // The server just vouched for the whole account list: every row it names is this
    // account's, which heals a device entry written before entries carried an owner…
    registry.attribute([...serverIds], owner);
    // …and a CLAIMED device entry it no longer names is a tree deleted elsewhere or never
    // this account's — prune it, or it zombies the union forever with a "synced" tag and no
    // affordance to remove. Unclaimed entries are local-born and waiting to claim; those
    // always stay, and another account's rows are not ours to prune.
    registry.list(owner).filter((tree) => tree.claimed && !serverIds.has(tree.id))
      .forEach((tree) => registry.remove(tree.id));
  }
  const device = registry.list(owner).filter((tree) => !serverIds.has(tree.id));
  return [
    ...server.rows.map((tree) => ({ ...tree, origin: 'server' })),
    ...device.map((tree) => ({ ...tree, origin: 'device' })),
  ].sort((a, b) => timestampOf(b.updatedAt) - timestampOf(a.updatedAt));
}

// The union needs to know whether an empty server list MEANS anything: a 200 is the
// account's true (possibly empty) list; a 401 or a dead network vouches for nothing.
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

// Plant a roadmap in the caller's registry → { treeId, existed }. `request` is the starting
// TreeData: `title` names it, and `nodes`/`kinds` seed its structure + legend (the birth sends
// one root node); omit them for an empty tree with the default legend. The claim path passes a
// client-minted `id` (t_ + 16 hex) the server keeps — `existed: true` is its idempotent resume,
// 409 { code: 'id-taken' } its remap signal, and 409 { code: 'id-retired' } an id this account itself deleted —
// which the claim must let go of rather than remap, since a remap re-plants the deleted tree under a fresh id.
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
  throw new AuthError(body.error ?? 'Could not plant the roadmap', { code: body.code, status: response.status });
}

// Retitle a roadmap in the caller's registry (PATCH /v1/trees/:id, 204). The server trims,
// refuses a blank (a tree always has a name), and — when the tree's room is live — routes
// the title through it so every subscriber sees the rename on their socket.
export async function renameTree(treeId, title) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees/${treeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Sign in to rename a roadmap', { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  throw new AuthError(body.error ?? 'Could not rename the roadmap', { code: body.code, status: response.status });
}

// Set a roadmap's visibility (PATCH /v1/trees/:id, 204). 'private' ⇒ owner-only reads;
// 'unlisted'/'public' ⇒ anyone with the link. The Share flip rides this so a copied link
// actually resolves for its recipient. A non-owner's stray call harmlessly 403s.
export async function setVisibility(treeId, visibility) {
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/trees/${treeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility }),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Sign in to change visibility', { code: 'unauthenticated', status: 401 });
  const body = await response.json().catch(() => ({}));
  // `detail` rides along: a refusal like "that's part of Windmill One" carries its own second line, and the
  // dialog shows the server's words rather than inventing its own.
  throw new AuthError(body.error ?? 'Could not change visibility', { code: body.code, detail: body.detail, status: response.status });
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
  throw new AuthError(body.error ?? 'Could not delete the roadmap', { code: body.code, status: response.status });
}

// Fork a shared roadmap into the caller's registry → { treeId }. The server mints the new
// id and copies the source's live state; progress starts cleared.
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
  throw new AuthError(body.error ?? 'Could not fork the roadmap', { code: body.code, status: response.status });
}
