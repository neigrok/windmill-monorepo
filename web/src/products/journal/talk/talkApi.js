// What Talk asks the server: may a take go, does the plan renew, and what a take said.

import { captureError } from '../../../telemetry/sentry.js';
import { API_BASE } from '../../../shell/apiBase.js';

// The largest take the server accepts (kMaxAudioBytes, backend/products/journal/adapters/http/VoiceApi.h).
export const AUDIO_CAP_BYTES = 6 * 1024 * 1024;
// The server answers a take within 60 s of receiving it (kIdleConnectionLimit, backend/platform/adapters/http/ReplyWait.h);
// the other 60 s carry the largest take, AUDIO_CAP_BYTES, up a link of 0.85 Mbit/s.
export const TRANSCRIBE_DEADLINE_MS = 120_000;
// Both reads stand between a press and the microphone, so a slow answer is skipped rather than waited out.
const READ_DEADLINE_MS = 4_000;

// A take the server did not transcribe: its status and what the body said — `code`, `reason`, `allowance`, `retryAtMs`.
export class TalkError extends Error {
  constructor(status, body) {
    super(`talk was refused: ${status}`);
    this.name = 'TalkError';
    this.status = status;
    this.body = body;
  }
}

// A failure the server did not explain is Sentry's: no answer, an answer past the deadline, or a 5xx with no `error`,
// which is a proxy's or a crash's. A refusal the server explains is the person's to read, not an Issue.
async function ask(operation, url, options, deadlineMs) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include', ...options, signal: AbortSignal.timeout(deadlineMs) });
  } catch (error) {
    captureError('journal', operation, '', '/journal', { failure: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' });
    throw error;
  }
  const body = response.ok ? await response.json() : await response.json().catch(() => ({}));
  if (response.status >= 500 && !body.error) captureError('journal', operation, '', '/journal', { failure: 'status', status: String(response.status) });
  return { status: response.status, ok: response.ok, body };
}

export const talkApi = {
  // Audio in, text out; no page is made. Anything but a transcript throws a TalkError, or the fetch's own error
  // when no answer came.
  async transcribe(audio) {
    const answer = await ask('journal-talk-transcribe', `${API_BASE}/v1/journal/transcribe`, {
      method: 'POST',
      body: audio,
      headers: { 'content-type': audio.type || 'application/octet-stream' },
    }, TRANSCRIBE_DEADLINE_MS);
    if (!answer.ok) throw new TalkError(answer.status, answer.body);
    return answer.body.text;
  },

  // The account's AI allowance as the ledger reads it now, or null when the ledger is off or did not answer:
  // the take's own refusal then says what the read would have.
  async allowance() {
    try {
      const answer = await ask('journal-talk-allowance', `${API_BASE}/v1/ai/allowance`, {}, READ_DEADLINE_MS);
      return answer.ok ? answer.body : null;
    } catch {
      return null;
    }
  },

  // Whether Windmill One renews at the end of this period, which is when a spent allowance comes back. Anything the
  // read cannot say for certain is false, so the sheet never names a date the plan will not reach.
  async renews() {
    try {
      const answer = await ask('journal-talk-subscription', `${API_BASE}/v1/subscription`, {}, READ_DEADLINE_MS);
      return answer.ok && answer.body.plan === 'windmill_one' && answer.body.governing?.autoRenew === true;
    } catch {
      return false;
    }
  },
};
