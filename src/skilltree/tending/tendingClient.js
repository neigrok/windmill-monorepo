// Tending's client half: read this account's meter + receipts. One GET tells the UI everything it
// needs — whether tending is armed at all (the composer gates on it), this month's budget and
// spend, when it resets, and the recent runs behind the receipts. Same-origin, credentialed, and
// tolerant of a miss: a null return simply means "no meter to show" (dark server, signed out, or
// the read failed), which every caller already treats as "tending isn't a thing here".

import { API_BASE } from '../apiBase.js';

export async function fetchTending() {
  try {
    const response = await fetch(`${API_BASE}/v1/tending`, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.json();  // { enabled, plan, limit, used, remaining, resetAtMs, runs[] }
  } catch {
    return null;
  }
}

// Start a tend run: POST the sentence and get back either a 202 { runId } (the agent loop is
// underway server-side) or a 200 refused run ({ status:'refused', refusal }) — a quiet face, not an
// error. Null only on a transport miss, which the caller shows as the "didn't land" face.
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

// The catch-up read: the run by id, however long after the socket that started it died — a phone
// that locked mid-tend reads the finished run back here. Null on a miss.
export async function fetchRun(runId) {
  try {
    const response = await fetch(`${API_BASE}/v1/tend/${encodeURIComponent(runId)}`, { credentials: 'include' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
