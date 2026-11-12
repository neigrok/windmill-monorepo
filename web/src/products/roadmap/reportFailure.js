import { captureError } from '../../telemetry/sentry.js';

// A failure its boundary has already judged, reported or not: a catch further up passes it on without a second Issue.
export class BoundaryFailure extends Error {}

// A static operation name and stack frames, never a message: V8 repeats the message at the head of the stack, so it goes first.
export function reportRoadmapFailure(operation, error, tags, route = '#/app') {
  if (error instanceof BoundaryFailure) return;
  const stack = typeof error?.stack === 'string' ? error.stack.replace(`: ${error.message}`, '') : '';
  captureError('roadmap', operation, stack.trim() ? stack : new Error(operation).stack, route, tags);
}

// Invalid progress rows report no content; the shared Sentry boundary bounds repeated reports.
export function reportInvalidProgressMark(report = reportRoadmapFailure) {
  report('roadmap-sync-progress-mark', new Error('Roadmap progress mark invalid'), { lane: 'progress' });
}

// Whether a lost request had anyone waiting on it: offline or behind a hidden page, losing one is expected.
export function pageWatching() {
  return globalThis.document?.visibilityState === 'visible' && globalThis.navigator?.onLine !== false;
}

const STORAGE_REFUSALS = new Set(['SecurityError', 'QuotaExceededError']);

// A refusal, a request nobody was waiting on and a browser refusing storage are expected answers; anything else reports,
// under the tags its boundary gives it.
export function reportUnexpectedFailure(operation, error, tags) {
  if (STORAGE_REFUSALS.has(error?.name)) return;
  if (error?.status === 0 && !pageWatching()) return;
  if (error?.status > 0 && error.status < 500) return;
  reportRoadmapFailure(operation, error, tags);
}
