// The magic-link API. Every failure throws an AuthError whose `code` maps to copy and whose `said` is the
// server's own sentence, shown as received; fetchMe answers a `user` of null only for a real 401 and undefined for a blip,
// and clearLapsedCookie answers what it did.

import { API_BASE } from '../apiBase.js';

const LINK_SENT_KEY = 'windmill:link-sent';
const LINK_SENT_TTL_MS = 15 * 60 * 1000;
// One tab at a time changes the browser's session cookie: a sign-in that sets it (`verifyToken`) and the clearing of one no
// live session holds (`clearLapsedCookie`). A sign-in whose cookie arrives on a navigation, Google's callback, holds none.
const COOKIE_LOCK = 'windmill:auth-cookie';

export class AuthError extends Error {
  constructor(message, { code, detail, status, said }) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.said = said;
  }
}

export async function requestMagicLink(email, { forkOf } = {}) {
  const response = await send('/v1/auth/magic-link', forkOf ? { email, forkOf } : { email });
  if (!response.ok) throw await errorFrom(response);
  try { sessionStorage.setItem(LINK_SENT_KEY, JSON.stringify({ email, at: Date.now() })); } catch { /* storage unavailable */ }
  return response.json();
}

export function pendingMagicLink() {
  try {
    const record = JSON.parse(sessionStorage.getItem(LINK_SENT_KEY) ?? 'null');
    if (!record?.email || !record?.at) return null;
    const expiresAt = record.at + LINK_SENT_TTL_MS;
    if (Date.now() >= expiresAt) return null;
    return { email: record.email, at: record.at, expiresAt };
  } catch {
    return null;
  }
}

export async function verifyToken(token) {
  return navigator.locks.request(COOKIE_LOCK, async () => {
    const response = await send('/v1/auth/verify', { token });
    if (response.ok) {
      const body = await response.json();
      return { user: body.user, forkedTree: body.forkedTree };
    }
    throw await errorFrom(response);
  });
}

// What the server says of this browser's session: its `user`, and `syncReplica`, the replica the session last pushed for
// (null until its first accepted push, and from a server that names none). `heard` is told whether the server answered:
// an answer under 500, where no answer and a 5xx are none.
export async function fetchMe({ heard = () => {} } = {}) {
  let response;
  try { response = await fetch(`${API_BASE}/v1/me`, { credentials: 'include', signal: AbortSignal.timeout(10000) }); }
  catch {
    heard(false);
    return undefined;
  }
  heard(response.status < 500);
  if (response.status === 401) return { user: null, syncReplica: null };
  if (!response.ok) return undefined;
  try {
    const { user, syncReplica } = await response.json();
    return { user, syncReplica: typeof syncReplica === 'string' ? syncReplica : null };
  } catch { return undefined; }
}

export async function logout() {
  try { sessionStorage.removeItem(LINK_SENT_KEY); } catch { /* storage unavailable */ }
  const response = await fetch(`${API_BASE}/v1/auth/logout`, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new AuthError('Sign out failed', { code: 'unreachable', status: response.status });
}

// Clears the cookie of a session the server no longer holds. JavaScript cannot see the HttpOnly cookie, so `read`, the
// account's read, decides under the cookie lock: no session still, and the logout expires the cookie (`cleared`); a
// sign-in another tab made meanwhile, which stays (`kept`); no answer, no lock within 10 s or a logout that fails
// (`failed`, the logout's `error` with it). Answers that read, undefined when there was none.
export async function clearLapsedCookie(read) {
  try {
    return await navigator.locks.request(COOKIE_LOCK, { signal: AbortSignal.timeout(10000) }, async () => {
      const account = await read();
      if (account?.user !== null) return { read: account, outcome: account ? 'kept' : 'failed' };
      try { await logout(); } catch (error) { return { read: account, outcome: 'failed', error }; }
      return { read: account, outcome: 'cleared' };
    });
  } catch {
    return { read: undefined, outcome: 'failed' };
  }
}

async function send(path, body) {
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
