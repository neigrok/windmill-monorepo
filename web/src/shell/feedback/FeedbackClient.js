// POST /v1/feedback, credentialed but anonymous is allowed.

import { API_BASE } from '../apiBase.js';

export const MESSAGE_MAX = 2000;

// A send that did not land, with the status it was answered with: 0 when nothing answered.
export class FeedbackError extends Error {
  constructor(status) {
    super('Feedback failed to send');
    this.name = 'FeedbackError';
    this.status = status;
  }
}

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
    throw new FeedbackError(0);
  }
  if (!response.ok) throw new FeedbackError(response.status);
}
