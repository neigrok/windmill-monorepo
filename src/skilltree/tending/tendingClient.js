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
