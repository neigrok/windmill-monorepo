import { API_BASE } from '../../../shell/apiBase.js';
import { GymError } from '../gymApi.js';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}/v1/gym${path}`, {
    credentials: 'include', ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new GymError(response.status, data?.error ?? '', data?.code ?? '', data);
  return data;
}

function queryString(query) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value != null && value !== '') result.set(key, String(value));
  return result.toString();
}

export const logShareApi = {
  list: async () => (await request('/log-shares')).shares,
  create: (body) => request('/log-shares', { method: 'POST', body: JSON.stringify(body) }),
  revoke: (id) => request(`/log-shares/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  preview: (query = {}) => request(`/history?${queryString({ ...query, projection: 'progress' })}`),
  read: (token, query = {}) => request(`/shared-logs/${encodeURIComponent(token)}?${queryString({ ...query, projection: 'progress' })}`, { credentials: 'omit' }),
};
