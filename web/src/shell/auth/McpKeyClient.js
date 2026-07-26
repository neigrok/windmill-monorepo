// The personal MCP key endpoints — a static bearer a signed-in account mints for clients
// that can't run the OAuth flow. The backend owns every token: it mints, lists (never the
// secret again), and revokes. This client carries only the credentialed calls the connect
// Advanced panel and settings' API keys section make. Reuses AuthError so a lapsed session
// is the same brick it is everywhere, carrying the `code` the callers map to copy.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// POST /v1/mcp-keys → 201 { id, name, token, createdMs }. The token is revealed once here
// and never again — the server keeps only its hash. A 401 is a lapsed session mid-mint.
export async function createMcpKey(name) {
  const response = await post('/v1/mcp-keys', { name });
  if (response.ok) return response.json();
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// GET /v1/mcp-keys → { keys: [{ id, name, createdMs, lastUsedMs }] }, newest first, never a
// token. A 401 is a lapsed session mid-visit.
export async function listMcpKeys() {
  const response = await get('/v1/mcp-keys');
  if (response.ok) return (await response.json()).keys ?? [];
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/mcp-keys/{id} → 204. Revoke acts immediately, and a 404 is an already-gone key
// — either way the intent is met, so both read as done. A 401 is a lapsed session mid-visit.
export async function revokeMcpKey(id) {
  const response = await del(`/v1/mcp-keys/${encodeURIComponent(id)}`);
  if (response.ok || response.status === 404) return;
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

async function get(path) {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
}

async function del(path) {
  try {
    return await fetch(`${API_BASE}${path}`, { method: 'DELETE', credentials: 'include' });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
}

async function post(path, body) {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
}

async function errorFrom(response) {
  const body = await response.json().catch(() => ({}));
  return new AuthError(body.error ?? 'Request failed', {
    code: body.code,
    detail: body.detail,
    status: response.status,
  });
}
