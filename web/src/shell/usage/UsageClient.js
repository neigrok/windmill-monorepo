// The owner's two reads. There is no shared fetch wrapper in this app and this file does not invent
// one — it copies the shape AccountClient.js already uses, because two small private helpers beside
// their two callers read better than an abstraction with one consumer.
//
// THE 404 IS THE WHOLE AUTH POSTURE. The server answers these paths byte-identically for a visitor
// who is signed out, a signed-in account that is not an owner, and a path that does not exist. So
// there is nothing to check here and nothing to check on the user: `not_found` is the one answer
// this client distinguishes, and the room turns it into the app's ordinary unknown-route behaviour.
// Any client-side privilege test would be a second, weaker copy of a decision the server already
// made — and the first thing on this page that told a non-owner the room exists.

import { AuthError } from '../auth/AuthClient.js';
import { API_BASE } from '../apiBase.js';

// GET /v1/admin/usage/summary → the window's totals, its per-product split and its daily series.
// Money is integer nano-dollars on the wire and stays that until shell/usage/usage.js formats it.
export async function fetchSummary({ fromMs, toMs }) {
  const response = await get(`/v1/admin/usage/summary?from=${fromMs}&to=${toMs}`);
  if (response.ok) return response.json();
  throw await errorFrom(response);
}

// GET /v1/admin/usage/users → one row per account that spent in the window, unranked as far as this
// client is concerned; the pure module sorts and cuts, so the ranking rule is testable.
export async function fetchSpenders({ fromMs, toMs }) {
  const response = await get(`/v1/admin/usage/users?from=${fromMs}&to=${toMs}`);
  if (response.ok) return response.json();
  throw await errorFrom(response);
}

async function get(path) {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  } catch {
    throw new AuthError('Network request failed', { code: 'unreachable', status: 0 });
  }
}

async function errorFrom(response) {
  // A 404 here carries no body worth reading — that is the point of it — so the code is set from the
  // status rather than trusted from the payload, and the room can rely on it either way.
  if (response.status === 404) return new AuthError('Not found', { code: 'not_found', status: 404 });
  const body = await response.json().catch(() => ({}));
  return new AuthError(body.error ?? 'Request failed', {
    code: body.code,
    detail: body.detail,
    status: response.status,
  });
}
