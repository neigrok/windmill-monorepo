// Credentialed calls on the signed-in user's own account; every failure throws AuthError.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// PATCH /v1/me {name} → the updated user.
export async function updateProfile({ name }) {
  const response = await send('/v1/me', 'PATCH', { name });
  if (response.ok) return (await response.json()).user;
  if (response.status === 400) throw new AuthError('That name was not accepted', { code: 'invalid', status: 400 });
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// GET /v1/sessions → { id, userAgent, lastSeenMs, createdMs, ip, current }[].
export async function listSessions() {
  const response = await get('/v1/sessions');
  if (response.ok) return (await response.json()).sessions ?? [];
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/sessions/{id} → 204; revoking the current session clears the cookie server-side.
export async function revokeSession(id) {
  const response = await send(`/v1/sessions/${encodeURIComponent(id)}`, 'DELETE');
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  if (response.status === 404) throw new AuthError('That session is already gone', { code: 'not_found', status: 404 });
  throw await errorFrom(response);
}

// DELETE /v1/sessions → 204. Every session but this one.
export async function signOutEverywhere() {
  const response = await send('/v1/sessions', 'DELETE');
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/me → { closingOn: <iso>, closesMs: <ms> }.
export async function closeAccount() {
  const response = await send('/v1/me', 'DELETE');
  if (response.ok) return response.json();
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

async function send(path, method, body) {
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
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
