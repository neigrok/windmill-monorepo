import test from 'node:test';
import assert from 'node:assert/strict';

import { useGymRead } from '../../../src/products/gym/useGymRead.js';
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
