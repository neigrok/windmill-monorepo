// The X6 magic-link API — one door keyed by email: passwordless, single-use links,
// rolling sessions. Every call carries the session cookie; every failure throws an
// AuthError whose `code` maps straight to the copy in auth.md §7. A dead server is
// never a crash — requestMagicLink/verifyToken report `unreachable`; fetchMe answers
// null only for a real 401, undefined for a blip (unknown — not signed out).

import { API_BASE } from '../apiBase.js';

const LINK_SENT_KEY = 'windmill:link-sent';
const LINK_SENT_TTL_MS = 15 * 60 * 1000;

export class AuthError extends Error {
  constructor(message, { code, detail, status }) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export async function requestMagicLink(email, { forkOf } = {}) {
  const response = await send('/v1/auth/magic-link', forkOf ? { email, forkOf } : { email });
  if (!response.ok) throw await errorFrom(response);
  try { sessionStorage.setItem(LINK_SENT_KEY, JSON.stringify({ email, at: Date.now() })); } catch { /* storage unavailable */ }
  return response.json();
}

// The link-sent record a successful request leaves behind — the marketing nav reads it
// to show the "Link sent — check your email" chip. Expires with the link itself (15 min).
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
  const response = await send('/v1/auth/verify', { token });
  if (response.ok) {
    const body = await response.json();
    return { user: body.user, forkedTree: body.forkedTree };
  }
  throw await errorFrom(response);
}

export async function fetchMe() {
  try {
    const response = await fetch(`${API_BASE}/v1/me`, { credentials: 'include' });
    if (response.status === 401) return null; // the one honest "no session"
    if (!response.ok) return undefined; // a server blip is unknown, never a sign-out
    const body = await response.json();
    return body.user;
  } catch {
    return undefined; // unreachable — unknown, never a crash on boot
  }
}

export async function logout() {
  // Going ghost is a local decision; a failed logout call must never block it.
  // Any pending link ceremony is moot once you choose to go ghost.
  try { sessionStorage.removeItem(LINK_SENT_KEY); } catch { /* storage unavailable */ }
  await fetch(`${API_BASE}/v1/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
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
    // fetch only rejects when the request never reached the server — the one true brick.
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
