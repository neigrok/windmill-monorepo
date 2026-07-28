// The one place the journal frontend talks to the backend it was built against. Every call is
// cookie-credentialed (the wm_session the shell already holds) and same-origin in production; in dev
// it points at the local windmill_server. The wire shapes match the backend exactly:
//   GET  /v1/journal/page/:date        -> the page, or null on 404 (a day never written)
//   PUT  /v1/journal/page/:date        -> the WINNING page after a last-writer-wins upsert
//   GET  /v1/journal/pages?since=|from=&to=  -> { pages: [...] } (the delta feed / a window)
//   GET  /v1/journal/export            -> { pages: [...] }
//   GET  /v1/journal/echoes?from=&to=  -> { echoes: [...] }  (empty unless subscribed)
//   POST /v1/journal/echoes/:date/dismiss
//   GET/PATCH /v1/journal/nudge
//   POST /v1/journal/transcribe (audio body) -> { text }

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

export class JournalError extends Error {
  constructor(status) {
    super(`journal request failed: ${status}`);
    this.status = status;
  }
}

export const journalApi = {
  // A single day. null means the day exists as a blank — the canvas draws a placeholder, not an error.
  async page(date) {
    const response = await call(`/page/${date}`);
    if (response.status === 404) return null;
    return json(response);
  },

  // Write a day. `stamp` is the device's HLC (see hlc.js) — the sole convergence key; the reply is
  // whatever won, so a client that raced sees the winning body immediately.
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

  // The delta feed: everything past an HLC cursor, ascending — the one read that maintains the
  // offline cache and the on-device search index. Pass '0:0:' for the whole history.
  async since(cursor, limit = 500) {
    return (await json(await call(`/pages?since=${encodeURIComponent(cursor)}&limit=${limit}`))).pages;
  },

  async exportAll() {
    return (await json(await call('/export'))).pages;
  },

  async echoes(from, to) {
    return (await json(await call(`/echoes?from=${from}&to=${to}`))).echoes;
  },

  async dismissEcho(date) {
    await call(`/echoes/${date}/dismiss`, { method: 'POST' });
  },

  async nudge() {
    return json(await call('/nudge'));
  },

  async patchNudge(patch) {
    return json(await call('/nudge', { method: 'PATCH', body: JSON.stringify(patch) }));
  },

  // Voice: audio bytes in, text out (Windmill One). 403 when not subscribed, 503 when no vendor is
  // wired — the caller hides Talk on either. No page is created here; the text is dropped into today.
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
