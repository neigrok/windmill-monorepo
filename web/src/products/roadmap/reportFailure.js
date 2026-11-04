import { captureError } from '../../telemetry/sentry.js';

// A static operation name and stack frames, never a message.
export function reportRoadmapFailure(operation, error, tags) {
  const stack = typeof error?.stack === 'string' && error.stack.trim() ? error.stack : new Error(operation).stack;
  captureError('roadmap', operation, stack, '#/app', tags);
}

// A refusal and a request lost offline are expected answers; a server failure or a lost request while online is not.
export function reportUnexpectedFailure(operation, error) {
  const lostOnline = error?.status === 0 && navigator.onLine !== false;
  if (error?.status < 500 && !lostOnline) return;
  reportRoadmapFailure(operation, error);
}
