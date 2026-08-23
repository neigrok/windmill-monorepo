// Every call is cookie-credentialed with the wm_session the shell holds, and same-origin in production.

import { API_BASE } from '../../shell/apiBase.js';

const base = `${API_BASE}/v1/journal`;

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return response;
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
  // A single day; null on a 404, which is a day never written rather than an error.
  async page(date) {
    const response = await call(`/page/${date}`);
    if (response.status === 404) return null;
    return json(response);
  },

  // `stamp` is the device's HLC (hlc.js), the sole convergence key; the reply is whatever won the upsert.
  async putPage(date, { body, mood, energy, source, stamp }) {
    return json(await call(`/page/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ body, mood, energy, source, stamp }),
    }));
  },

  // A window of the canvas [from, to] (ISO dates), oldest first.
  async range(from, to) {
    return (await json(await call(`/pages?from=${from}&to=${to}`))).pages;
  },

  // The whole corpus, ascending by day. `/pages` with no parameters is uncapped; the `since` feed clamps
  // to 1000 and orders by stamp, so it must not be used for this.
  async allPages() {
    return (await json(await call('/pages'))).pages;
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
