// The personal MCP key endpoints. Every failure throws an AuthError carrying a `code`.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// POST /v1/mcp-keys → 201 { id, name, token, createdMs }; the token is revealed once, here.
export async function createMcpKey(name) {
  const response = await post('/v1/mcp-keys', { name });
  if (response.ok) return response.json();
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// GET /v1/mcp-keys → { keys: [{ id, name, createdMs, lastUsedMs }] }, newest first, never a token.
export async function listMcpKeys() {
  const response = await get('/v1/mcp-keys');
  if (response.ok) return (await response.json()).keys ?? [];
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/mcp-keys/{id} → 204; a 404 is an already-gone key and reads as done.
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
