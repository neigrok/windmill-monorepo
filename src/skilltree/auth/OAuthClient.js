// The OAuth consent endpoints — the three credentialed calls the #/oauth/authorize
// screen makes. The backend is the authorization server: it owns every code, token,
// and PKCE value. This client only reads the *verified* client to display and posts
// the user's decision, then the screen follows the redirect the backend hands back.
// No secret ever passes through here. Reuses AuthError so a dead server is the same
// brick it is everywhere else, and every failure carries a `code` the screen maps to copy.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// The registered client behind a client_id, so the screen renders a name Windmill
// vouches for — never attacker-supplied text from the URL. 404 is an unknown app.
export async function fetchConsentClient(clientId) {
  const response = await get(`/v1/oauth/client?client_id=${encodeURIComponent(clientId)}`);
  if (response.ok) return response.json();
  if (response.status === 404) throw new AuthError('Unknown application', { code: 'unknown_client', status: 404 });
  throw await errorFrom(response);
}

// Approve or deny. The opaque PKCE/anti-CSRF params are echoed back byte-for-byte.
// On success the body is { redirect } — the screen navigates straight to it. A 401 is
// a lapsed session mid-flow (re-sign-in and retry); a 400 is an expired/malformed request.
export async function postDecision(decision) {
  const response = await post('/v1/oauth/decision', decision);
  if (response.ok) return response.json();
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  if (response.status === 400) throw new AuthError('Authorization request expired', { code: 'expired', status: 400 });
  throw await errorFrom(response);
}

async function get(path) {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: 'include' });
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
