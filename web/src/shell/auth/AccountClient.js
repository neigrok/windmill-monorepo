// The account-management API (X6 §5 settings). The credentialed calls the settings page
// makes on the signed-in user's own account: renaming, listing and revoking browser
// sessions, signing out everywhere, and closing the account. Reuses AuthError so a dead
// server is the same brick it is everywhere else, and every call carries the session
// cookie. A 401 anywhere means the session lapsed mid-visit — the caller re-opens the door.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// PATCH /v1/me {name} → the updated user. 400 is a name the server refused (blank/too long);
// 401 is a lapsed session. The caller writes the returned user back through useAuth().refresh().
export async function updateProfile({ name }) {
  const response = await send('/v1/me', 'PATCH', { name });
  if (response.ok) return (await response.json()).user;
  if (response.status === 400) throw new AuthError('That name was not accepted', { code: 'invalid', status: 400 });
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// GET /v1/sessions → this account's active sessions, current one flagged. Each row carries
// { id, userAgent, lastSeenMs, createdMs, ip, current } — device/recency are the settings
// page's to format; place has no geo-IP, so it never renders one.
export async function listSessions() {
  const response = await get('/v1/sessions');
  if (response.ok) return (await response.json()).sessions ?? [];
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/sessions/{id} → 204. Revoking the current session clears the cookie server-side;
// the caller also signs out locally and returns home. 404 is a session already gone.
export async function revokeSession(id) {
  const response = await send(`/v1/sessions/${encodeURIComponent(id)}`, 'DELETE');
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  if (response.status === 404) throw new AuthError('That session is already gone', { code: 'not_found', status: 404 });
  throw await errorFrom(response);
}

// DELETE /v1/sessions → 204. Sign out everywhere: every session but this one (the standing
// promise — other devices keep their local copies).
export async function signOutEverywhere() {
  const response = await send('/v1/sessions', 'DELETE');
  if (response.ok) return;
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/me → { closingOn: <iso>, closesMs: <ms> }. What the server actually does on this call
// is revoke every session, disconnect every connected tool, and stamp the account closed
// (AuthService::closeAccount) — nothing is erased, and `closingOn` is a date no code enforces:
// signing in revives a closed account whenever it happens. The caller signs out locally and says
// only those three things; see shell/settings/accountClosure.js for the whole reasoning.
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
