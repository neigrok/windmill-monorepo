import assert from 'node:assert/strict';
import test from 'node:test';
import { syncTelemetry } from '../../../src/platform/sync/telemetry.js';

function recorded(options) {
  const events = [], failures = [];
  const telemetry = syncTelemetry({ ...options, event: (name, props) => events.push({ name, props }), failure: (operation) => failures.push(operation) });
  return { telemetry, events, failures };
}

test('telemetry drops content, ids, unknown labels and exceptions, and bounds failures and steps each by its own allowance', () => {
  let time = 0;
  const { telemetry, events, failures } = recorded({ limit: 2, now: () => time });
  telemetry.event('sync-digest-mismatch', { scopeKind: 'product', seq: 42, body: 'secret', account: 'A', token: 'secret' });
  telemetry.event('sync-persist', { outcome: 'denied', scope: 'tree/secret' });
  telemetry.event('sync-start', { outcome: 'ok' });
  telemetry.failure('storage');
  telemetry.failure('transport');
  telemetry.failure('live');
  telemetry.failure('secret');
  telemetry.event('secret', { token: 'secret' });
  assert.deepEqual(events, [{ name: 'sync-digest-mismatch', props: { scopeKind: 'product', seq: 42 } }, { name: 'sync-persist', props: { outcome: 'denied' } }]);
  assert.deepEqual(failures, ['storage', 'transport']);
  time = 60_000;
  telemetry.failure('live');
  telemetry.event('sync-start', { outcome: 'ok' });
  assert.deepEqual(failures, ['storage', 'transport', 'live']);
  assert.deepEqual(events.at(-1), { name: 'sync-start', props: { outcome: 'ok' } });
});

test('writer timings are a sample of each minute with an allowance of their own, which neither a step nor a failure spends', () => {
  let time = 0;
  const { telemetry, events, failures } = recorded({ limit: 1, writerLimit: 2, now: () => time });
  for (let n = 1; n <= 5; n++) telemetry.event('sync-writer', { durationMs: n, queueMs: 0 });
  telemetry.event('sync-commit', { outcome: 'ok' });
  telemetry.failure('transport');
  assert.deepEqual(events, [{ name: 'sync-writer', props: { durationMs: 1, queueMs: 0 } }, { name: 'sync-writer', props: { durationMs: 2, queueMs: 0 } },
    { name: 'sync-commit', props: { outcome: 'ok' } }]);
  assert.deepEqual(failures, ['transport']);
  time = 60_000;
  telemetry.event('sync-writer', { durationMs: 6, queueMs: 0 });
  assert.deepEqual(events.at(-1), { name: 'sync-writer', props: { durationMs: 6, queueMs: 0 } });
});

test('writer measurements are bounded numeric labels and never forward content or non-finite values', () => {
  const { telemetry, events } = recorded({});
  telemetry.event('sync-writer', { durationMs: 90000, queueMs: 12, body: 'secret', scope: 'private' });
  telemetry.event('sync-writer', { durationMs: Infinity, queueMs: -1, account: 'private' });
  assert.deepEqual(events, [{ name: 'sync-writer', props: { durationMs: 60000, queueMs: 12 } }, { name: 'sync-writer', props: {} }]);
});
