import { API_BASE } from '../../../shell/apiBase.js';

export async function fetchTending() {
  try {
    const response = await fetch(`${API_BASE}/v1/tending`, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.json();  // { enabled, plan, limit, used, remaining, resetAtMs, runs[] }
  } catch {
    return null;
  }
}

// 202 { runId } for a started run, 200 { status:'refused', refusal } for a refusal; null on a transport miss.
export async function startTend(treeId, prompt) {
  try {
    const response = await fetch(`${API_BASE}/v1/trees/${encodeURIComponent(treeId)}/tend`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) return null;
    return await response.json();  // { runId } on 202, or a refused run on 200
  } catch {
    return null;
  }
}

// The run by id, however long after the socket that started it died. Null on a miss.
export async function fetchRun(runId) {
  try {
    const response = await fetch(`${API_BASE}/v1/tend/${encodeURIComponent(runId)}`, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
