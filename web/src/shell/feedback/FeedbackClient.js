// POST /v1/feedback, credentialed but anonymous is allowed.

import { API_BASE } from '../apiBase.js';

export const MESSAGE_MAX = 2000;

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
