// The per-user tree registry (F1·F2): the account-level list of roadmaps and the
// door that plants a new one. Distinct from HttpTreeRepository, which is scoped to a
// single tree — this is the "which trees do I own" surface the TreeSwitcher reads and
// the birth canvas writes to. Credentialed (X6 cookie); a signed-in concern.
//
// list() degrades to [] whenever the registry can't answer (not built yet, offline,
// signed out) so the switcher still shows the current tree + New tree. create() is the
// signed-in plant path (POST /v1/trees, docs/backend/landing-and-quests.md §2); a 401
// surfaces as an AuthError the birth canvas turns into a sign-in prompt.

import { AuthError } from '../auth/AuthClient.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL ?? 'http://localhost:8088';

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

// Plant a roadmap in the caller's registry → { treeId }. `blank` makes an empty tree
// with the default legend; `title` names it; `fromQuest` clones a starter template.
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
