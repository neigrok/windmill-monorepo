import { captureError } from '../../telemetry/sentry.js';

// A static operation name and stack frames, never a message.
export function reportRoadmapFailure(operation, error) {
  const stack = typeof error?.stack === 'string' && error.stack.trim() ? error.stack : new Error(operation).stack;
  captureError('roadmap', operation, stack, '#/app');
}
