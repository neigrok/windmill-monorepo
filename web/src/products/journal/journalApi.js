// The one place the journal frontend talks to the backend it was built against. Every call is
// cookie-credentialed (the wm_session the shell already holds) and same-origin in production; in dev
// it points at the local windmill_server. The wire shapes match the backend exactly:
//   GET  /v1/journal/page/:date        -> the page, or null on 404 (a day never written)
//   PUT  /v1/journal/page/:date        -> the WINNING page after a last-writer-wins upsert
//   GET  /v1/journal/pages?since=|from=&to=  -> { pages: [...] } (the delta feed / a window / all)
//   GET  /v1/journal/export            -> { pages: [...] }
//   GET  /v1/journal/echoes?from=&to=  -> { pages: [...], pagesWritten, firstEchoEver }
//   POST /v1/journal/echoes/:trigger/dismiss            ("Not useful" — retire the whole page, one call)
//   POST /v1/journal/echoes/:trigger/:match/dismiss     ("Not useful" — retire that pairing)
//   POST /v1/journal/echoes/:trigger/:match/useful      ("Useful" — the reader's own answer)
//   POST /v1/journal/echoes/:trigger/offer/dismiss      ("Not now" — retire the offer for that page)
//   POST /v1/journal/echoes/:trigger/:match/opened      (the relevance signal)
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

// The write twin of `json`, for the doors that answer 204 however many times they are pressed. There
// is nothing to read back, so the one fact worth returning is whether the server took it — and it
// has to be a rejection, because a bare `await call(...)` resolves just as happily on a 500 and the
// callers below act on the difference.
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

  // The whole corpus, ascending by day — what search indexes, what the zoom draws a year out of,
  // and what the nudge reads a rhythm from. `/pages` with no parameters at all is the backend's own
  // whole-shelf read (products/journal/adapters/http/JournalApi.cpp), and it is uncapped.
  //
  // This rode the delta feed from the zero cursor with `limit=5000` until 2026-08-07. That was two
  // untrue things at once: the server clamps any `since` limit to 1000, so a writer past ~2.7 years
  // of daily pages was silently searching and zooming an incomplete journal — and the feed is
  // ordered by STAMP, so the pages it dropped were an arbitrary scatter of days rather than the
  // oldest ones. There is no ceiling here now because there is none to state.
  async allPages() {
    return (await json(await call('/pages'))).pages;
  },

  async exportAll() {
    return (await json(await call('/export'))).pages;
  },

  // The whole envelope, not just the pages: `pagesWritten` is what suppresses marks under the ~20-page
  // floor, and `firstEchoEver` is the once-ever card's only honest source (a device flag can withhold
  // that card, never assert it — the first echo may have arrived on another device). Each match
  // carries `useful` for the same reason: the reader's answer is the server's to remember, not a
  // device's.
  async echoes(from, to) {
    return json(await call(`/echoes?from=${from}&to=${to}`));
  },

  // "Not useful" — retire this pairing. Keyed on both days: a dismissal survives re-derivation. The
  // server records the negative signal on this same call, so there is no second "bad" door to press.
  async dismissEcho(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/dismiss`, { method: 'POST' }));
  },

  // "Not useful" for the whole page — ONE request for the set. Nine matches must not cost nine round
  // trips, each able to fail on its own and leave a page half faded.
  async dismissEchoPage(triggerDay) {
    await sent(await call(`/echoes/${triggerDay}/dismiss`, { method: 'POST' }));
  },

  // "Useful" — the only answer the reader gives on purpose, and the one this feature is measured by.
  // Idempotent, and the read hands it back per match as `useful`: an answer given on a laptop is
  // still given on the phone, which a device flag could never manage.
  async echoUseful(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/useful`, { method: 'POST' }));
  },

  // "Not now" — retire the offer for this page. The echo still opens; nothing re-asks a page that
  // was answered, and nothing counts the decline.
  async dismissEchoOffer(triggerDay) {
    await sent(await call(`/echoes/${triggerDay}/offer/dismiss`, { method: 'POST' }));
  },

  // Opening a match's page is the one positive signal this feature has — the design has no "Read it"
  // button, so the row tap is it. Fire-and-forget: a failed beacon must never cost the walk.
  async echoOpened(triggerDay, matchDay) {
    await sent(await call(`/echoes/${triggerDay}/${matchDay}/opened`, { method: 'POST' }));
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
