import test from 'node:test';
import assert from 'node:assert/strict';

import { useGymRead } from '../../../src/products/gym/useGymRead.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { renderHook, settle } from './harness.mjs';

test('retry reads again from loading; refresh reads again in place, keeping what is drawn until the new read lands', async (t) => {
  const reads = [];
  const read = () => new Promise((resolve, reject) => reads.push({ resolve, reject }));
  const screen = renderHook(t, () => useGymRead(read, []));
  assert.equal(screen.log.phase, 'loading');
  reads[0].resolve({ n: 1 });
  await settle();
  assert.deepEqual(screen.log.data, { n: 1 });

  screen.log.retry();
  assert.equal(screen.log.phase, 'loading', 'retry drops what was drawn');
  reads[1].resolve({ n: 2 });
  await settle();
  assert.equal(screen.log.phase, 'ready');
  assert.deepEqual(screen.log.data, { n: 2 });

  screen.log.refresh();
  assert.equal(screen.log.phase, 'ready', 'refresh keeps what was drawn');
  assert.deepEqual(screen.log.data, { n: 2 });
  assert.equal(reads.length, 3, 'and reads again');
  reads[2].resolve({ n: 3 });
  await settle();
  assert.deepEqual(screen.log.data, { n: 3 });

  screen.log.refresh();
  reads[3].reject(new Error('down'));
  await settle();
  assert.equal(screen.log.phase, 'failed', 'a refresh that fails says so');
});

test('a read that resolves null is absent, and a read that lands after a newer one began is dropped', async (t) => {
  const reads = [];
  const read = () => new Promise((resolve) => reads.push(resolve));
  const screen = renderHook(t, () => useGymRead(read, []));
  screen.log.refresh();
  await settle();
  assert.equal(reads.length, 2);
  reads[0]({ stale: true });
  await settle();
  assert.equal(screen.log.phase, 'loading', 'the first read was abandoned when the second began');
  reads[1](null);
  await settle();
  assert.equal(screen.log.phase, 'absent');
});

test('sync invalidation refreshes projections in place and leaves ancillary REST reads alone', async (t) => {
  let records = { replica: 'account', drawn: [], stored: [], notices: [], firstPullComplete: true };
  const observation = { subscribe: () => () => {}, getSnapshot: () => records };
  const session = { engine: { observe: () => observation }, ready: true, signedIn: false };
  t.mock.method(syncSession, 'getSnapshot', () => session);
  const pending = [];
  const local = renderHook(t, () => useGymRead(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), [], { sync: true }));
  let ancillaryReads = 0;
  const ancillary = renderHook(t, () => useGymRead(async () => ({ reads: ++ancillaryReads }), []));
  pending[0].resolve({ sessions: ['first'] });
  await settle();
  records = { ...records, drawn: [{ id: 'phone-workout' }] };
  local.redraw(); ancillary.redraw();
  assert.deepEqual(local.log.data, { sessions: ['first'] });
  assert.equal(local.log.phase, 'ready');
  assert.equal(pending.length, 2);
  assert.equal(ancillaryReads, 1);
  records = { ...records, drawn: [{ id: 'newer-phone-workout' }] };
  local.redraw();
  pending[1].resolve({ sessions: ['outdated'] });
  await settle();
  assert.deepEqual(local.log.data, { sessions: ['first'] });
  pending[2].reject(new Error('projection failed'));
  await settle();
  assert.equal(local.log.phase, 'failed');
  local.log.retry();
  pending[3].resolve({ sessions: ['newer-phone-workout'] });
  await settle();
  assert.deepEqual(local.log.data, { sessions: ['newer-phone-workout'] });
});

test('boot readiness gates reads and a stalled read cannot update an unmounted screen', async (t) => {
  let ready = false;
  let finish;
  let reads = 0;
  const screen = renderHook(t, () => useGymRead(() => {
    reads += 1;
    return new Promise((resolve) => { finish = resolve; });
  }, [], { sync: true, ready }));
  assert.equal(reads, 0);
  ready = true; screen.redraw();
  assert.equal(reads, 1);
  assert.equal(screen.log.phase, 'loading');
  screen.unmount();
  finish({ sessions: ['late'] });
  await settle();
  assert.deepEqual({ phase: screen.log.phase, data: screen.log.data }, { phase: 'loading', data: undefined });
});
