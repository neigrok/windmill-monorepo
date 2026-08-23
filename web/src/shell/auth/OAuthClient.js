// The credentialed OAuth calls the #/oauth/authorize screen makes; every failure throws an
// AuthError carrying a `code`.

import { AuthError } from './AuthClient.js';
import { API_BASE } from '../apiBase.js';

// The registered client behind a client_id, so the screen renders a verified name, not URL text.
export async function fetchConsentClient(clientId) {
  const response = await get(`/v1/oauth/client?client_id=${encodeURIComponent(clientId)}`);
  if (response.ok) return response.json();
  if (response.status === 404) throw new AuthError('Unknown application', { code: 'unknown_client', status: 404 });
  throw await errorFrom(response);
}

// Approve or deny; the opaque PKCE/anti-CSRF params are echoed back byte-for-byte. Success is
// { redirect }.
export async function postDecision(decision) {
  const response = await post('/v1/oauth/decision', decision);
  if (response.ok) return response.json();
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  if (response.status === 400) throw new AuthError('Authorization request expired', { code: 'expired', status: 400 });
  throw await errorFrom(response);
}

// GET /v1/oauth/grants → one row per client: { clientId, name, grantedMs, lastUsedMs, scope }.
export async function listGrants() {
  const response = await get('/v1/oauth/grants');
  if (response.ok) return (await response.json()).grants ?? [];
  if (response.status === 401) throw new AuthError('Session lapsed', { code: 'unauthenticated', status: 401 });
  throw await errorFrom(response);
}

// DELETE /v1/oauth/grants/{clientId} → 204.
export async function revokeGrant(clientId) {
  const response = await del(`/v1/oauth/grants/${encodeURIComponent(clientId)}`);
  if (response.ok) return;
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
