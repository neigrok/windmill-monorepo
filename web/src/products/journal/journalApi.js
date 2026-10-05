// Server features use the session cookie. Page reads come from the active browser replica.

import { corpus } from './pages.js';
import { captureError } from '../../telemetry/sentry.js';
import { syncSession } from '../../platform/sync/session.js';
import { API_BASE } from '../../shell/apiBase.js';

const base = `${API_BASE}/v1/journal`;

async function call(path, options = {}) {
  try {
    const response = await fetch(`${base}${path}`, {
      credentials: 'include',
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      signal: options.signal ?? AbortSignal.timeout(30000),
    });
    if (response.status >= 500) captureError('journal', 'journal-rest', '', '/journal');
    return response;
  } catch (error) { captureError('journal', 'journal-rest', '', '/journal'); throw error; }
}

async function json(response) {
  if (!response.ok) throw new JournalError(response.status);
  return response.json();
}

// For the doors that answer 204: a bare `await call(...)` resolves just as happily on a 500.
async function sent(response) {
  if (!response.ok) throw new JournalError(response.status);
}

export class JournalError extends Error {
  constructor(status) {
    super(`journal request failed: ${status}`);
    this.status = status;
  }
}

export const journalApi = {
  async page(date) {
    return (await corpus({ account: syncSession.engine?.device.activeReplica.meta.account ?? null })).pages.find((page) => page.day === date) ?? null;
  },
  async allPages() {
    return (await corpus({ account: syncSession.engine?.device.activeReplica.meta.account ?? null })).pages;
  },

  async exportAll() {
    return (await json(await call('/export'))).pages;
  },

  // `pagesWritten` suppresses marks under the page floor, `firstEchoEver` is the once-ever card's only
  // source, and each match's `useful` is the server's to remember rather than a device's.
  async echoes(from, to) {
    return json(await call(`/echoes?from=${from}&to=${to}`));
  },

  // "Not useful" — retire this pairing. Keyed on both days, so a dismissal survives re-derivation.
  async dismissEcho(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/dismiss`, { method: 'POST' }));
  },

  // "Not useful" for the whole page — one request for the set, never one per match.
  async dismissEchoPage(triggerDay) {
    await sent(await call(`/echoes/${triggerDay}/dismiss`, { method: 'POST' }));
  },

  // "Useful" — idempotent; the read hands it back per match, so the answer follows the account.
  async echoUseful(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/useful`, { method: 'POST' }));
  },

  // "Not now" — retire the offer for this page; the echo still opens.
  async dismissEchoOffer(triggerDay) {
    await sent(await call(`/echoes/${triggerDay}/offer/dismiss`, { method: 'POST' }));
  },

  // Fire-and-forget: a failed beacon must never cost the walk.
  async echoOpened(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/opened`, { method: 'POST' }));
  },

  async nudge() {
    return json(await call('/nudge'));
  },

  async patchNudge(patch) {
    return json(await call('/nudge', { method: 'PATCH', body: JSON.stringify(patch) }));
  },

  // Audio bytes in, text out. 403 when not subscribed, 503 when no vendor is wired. No page is created.
  async transcribe(audioBlob, mimeType) {
    const response = await call('/transcribe', {
      method: 'POST',
      body: audioBlob,
      headers: { 'content-type': mimeType || 'application/octet-stream' },
    });
    if (!response.ok) throw new JournalError(response.status);
    return (await response.json()).text;
  },
};
