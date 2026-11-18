import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';

const EVENTS = new Set(['sync-start', 'sync-commit', 'sync-release', 'sync-undo', 'sync-inverse', 'sync-signin',
  'sync-signout', 'sync-auth-paused', 'sync-upgrade', 'sync-persist', 'sync-leader',
  'sync-digest-mismatch', 'sync-push-malformed', 'sync-refused', 'sync-writer']);
const OPERATIONS = new Set(['storage', 'transport', 'live', 'leadership', 'observer', 'auth']);
const OUTCOMES = new Set(['ok', 'denied', 'unavailable', 'pending', 'paused', 'failed', 'acquired', 'released']);

// The first `limit` reports of one kind in each minute, at most 100.
function allowance(now, limit) {
  const most = Math.min(100, Math.max(0, limit));
  let start = now(), used = 0;
  return () => {
    if (now() - start >= 60_000) { start = now(); used = 0; }
    return used++ < most;
  };
}

// Failures, step events and writer timings each spend their own allowance; writer timings sample each minute's first writes.
export function syncTelemetry({ event = (name, props) => track(name.replaceAll('-', '_'), props), failure = (operation) => captureError('sync', `sync-${operation}`, '', '/sync'),
  now = Date.now, limit = 30, writerLimit = 10 } = {}) {
  const failures = allowance(now, limit), steps = allowance(now, limit), writers = allowance(now, writerLimit);
  return {
    event(name, props = {}) {
      if (!EVENTS.has(name) || !(name === 'sync-writer' ? writers : steps)()) return;
      const safe = {};
      if (['product', 'tree', 'overlay', 'device'].includes(props.scopeKind)) safe.scopeKind = props.scopeKind;
      for (const key of ['durationMs', 'queueMs']) if (Number.isSafeInteger(props[key]) && props[key] >= 0) safe[key] = Math.min(60_000, props[key]);
      if (OUTCOMES.has(props.outcome)) safe.outcome = props.outcome;
      if (Number.isSafeInteger(props.seq) && props.seq >= 0) safe.seq = props.seq;
      try { event(name, safe); } catch { /* telemetry must not stop sync */ }
    },
    failure(operation) {
      if (!OPERATIONS.has(operation) || !failures()) return;
      try { failure(operation); } catch { /* telemetry must not stop sync */ }
    },
  };
}
