// The X6 magic-link API — one door keyed by email: passwordless, single-use links,
// rolling sessions. Every call carries the session cookie; every failure throws an
// AuthError whose `code` maps straight to the copy in auth.md §7. A dead server is
// never a crash — requestMagicLink/verifyToken report `unreachable`, fetchMe goes null.

import { API_BASE } from '../apiBase.js';

export class AuthError extends Error {
  constructor(message, { code, detail, status }) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export async function requestMagicLink(email) {
  const response = await send('/v1/auth/magic-link', { email });
  if (response.ok) return response.json();
  throw await errorFrom(response);
}

export async function verifyToken(token) {
  const response = await send('/v1/auth/verify', { token });
  if (response.ok) {
    const body = await response.json();
    return { user: body.user };
  }
  throw await errorFrom(response);
}

export async function fetchMe() {
  try {
    const response = await fetch(`${API_BASE}/v1/me`, { credentials: 'include' });
    if (!response.ok) return null;
    const body = await response.json();
    return body.user;
  } catch {
    // No reachable server is just "no session, ghost" — never a crash on boot.
    return null;
  }
}

export async function logout() {
  // Going ghost is a local decision; a failed logout call must never block it.
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
