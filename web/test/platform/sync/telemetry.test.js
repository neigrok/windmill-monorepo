import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { EVENTS, OPERATIONS, syncTelemetry } from '../../../src/platform/sync/telemetry.js';

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

test('inverse settlement and waiting counts are bounded numeric labels with no id or value', () => {
  const { telemetry, events } = recorded({});
  telemetry.event('sync-inverse', { outcome: 'settled', applied: 2, skipped: 5000, requestId: 'g3', before: 'secret' });
  telemetry.event('sync-inverse', { outcome: 'pending', waiting: 1, count: 4, ageMs: 9e12, actId: 'g1' });
  telemetry.event('sync-inverse', { outcome: 'settled', applied: -1, skipped: 0.5, ageMs: Infinity });
  assert.deepEqual(events, [
    { name: 'sync-inverse', props: { outcome: 'settled', applied: 2, skipped: 1000 } },
    { name: 'sync-inverse', props: { outcome: 'pending', waiting: 1, ageMs: 2_592_000_000 } },
    { name: 'sync-inverse', props: { outcome: 'settled' } }]);
});

test('every event and failure the engine may send has its row in OBSERVABILITY.md, every row names one it may send, and each has a sender', () => {
  const doc = readFileSync(new URL('../../../OBSERVABILITY.md', import.meta.url), 'utf8');
  const named = (header) => {
    const table = doc.slice(doc.indexOf(header));
    const cells = table.slice(0, table.indexOf('\n\n')).split('\n').slice(2).map((line) => line.split(' | ')[0]);
    return [...new Set(cells.flatMap((cell) => [...cell.matchAll(/`(sync-[a-z-]+)`/g)].map((match) => match[1])))].sort();
  };
  const code = [new URL('../../../src/platform/sync/', import.meta.url), new URL('../../../../packages/api-contract/sync/reference/client/', import.meta.url)]
    .flatMap((folder) => readdirSync(folder).filter((name) => name.endsWith('.js')).map((name) => readFileSync(new URL(name, folder), 'utf8'))).join('\n');
  const sent = [...new Set([...code.matchAll(/(?:event\(|event: |write\()'(sync-[a-z-]+)'/g)].map((match) => match[1]))].sort();
  const failed = [...new Set([...code.matchAll(/[fF]ailure\('([a-z]+)'\)/g)].map((match) => match[1]))].sort();
  assert.deepEqual({ events: named('| Events | Meaning |'), failures: named('| Failure | When |'), sent, failed }, {
    events: [...EVENTS].sort(),
    failures: [...OPERATIONS].map((operation) => `sync-${operation}`).sort(),
    sent: [...EVENTS].sort(),
    failed: [...OPERATIONS].sort(),
  });
});
