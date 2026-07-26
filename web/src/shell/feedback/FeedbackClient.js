// The feedback door's one call. A user — signed in or signed out — sends a line to the
// team, and this fires it once at POST /v1/feedback, then returns or throws. Same-origin
// and credentialed so a signed-in report carries its session, but anon is allowed on
// purpose: the landing footer posts with no account at all. The current route rides along
// as context, so a note says which screen it came from without ever asking the reporter.

import { API_BASE } from '../apiBase.js';

export const MESSAGE_MAX = 2000;

// The gate the Send button reads, and the same shape the backend enforces: a real line
// after trimming, never longer than the cap.
export function isSendableMessage(message) {
  const trimmed = (message ?? '').trim();
  return trimmed.length >= 1 && trimmed.length <= MESSAGE_MAX;
}

export async function sendFeedback({ message, email }) {
  const route = typeof window !== 'undefined' && window.location
    ? (window.location.hash || window.location.pathname || '')
    : '';
  const body = {
    message: (message ?? '').trim(),
    ...(email?.trim() ? { email: email.trim() } : {}),
    ...(route ? { context: route.slice(0, 200) } : {}),
  };
  let response;
  try {
    response = await fetch(`${API_BASE}/v1/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
  } catch {
    throw new Error('Network request failed');
  }
  if (response.ok) return;
  const detail = await response.json().catch(() => ({}));
  throw new Error(detail.error ?? 'Feedback failed to send');
}
