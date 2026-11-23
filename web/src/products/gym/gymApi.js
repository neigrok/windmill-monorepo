import { API_BASE } from '../../shell/apiBase.js';
import { registry } from '../../platform/sync/schema.js';
import { GymError } from './errors.js';

const base = `${API_BASE}/v1/gym`;

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}), 'Sync-Schema': String(registry.version) },
  });
  return response;
}

async function json(response) {
  if (response.status === 204) return null;
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new GymError(response.status, body?.error ?? '', body?.code ?? '', body);
}

export const gymApi = {
  async shareSession(id) {
    return json(await call(`/sessions/${id}/share`, { method: 'POST' }));
  },

  async revokeShare(id) {
    const response = await call(`/sessions/${id}/share`, { method: 'DELETE' });
    if (response.status === 404) return null;
    return json(response);
  },

  async sharedSession(token) {
    const response = await call(`/shared/${encodeURIComponent(token)}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async logShares() {
    return (await json(await call('/log-shares'))).shares;
  },

  async createLogShare(share) {
    return json(await call('/log-shares', { method: 'POST', body: JSON.stringify(share) }));
  },

  async revokeLogShare(id) {
    return json(await call(`/log-shares/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

  // A recipient's read: no cookie, and the complete progress beside the page of sessions.
  async sharedLog(token, filters = {}) {
    const query = new URLSearchParams(Object.entries({ ...filters, projection: 'progress' })
      .filter(([, value]) => value != null && value !== ''));
    return json(await call(`/shared-logs/${encodeURIComponent(token)}?${query}`, { credentials: 'omit' }));
  },
};
