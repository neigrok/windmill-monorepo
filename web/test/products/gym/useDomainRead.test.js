import test from 'node:test';
import assert from 'node:assert/strict';
import { useDomainRead } from '../../../src/products/gym/useDomainRead.js';
import { browserWith, gymAccount, renderHook, settle } from './harness.mjs';

test('domain reads reuse the observation until its metadata, selector inputs or explicit refresh changes', async (t) => {
  browserWith();
  const { engine } = await gymAccount(t);
  let input = 'first', calls = 0;
  const view = renderHook(t, () => useDomainRead((read) => {
    calls += 1;
    return { input, complete: read.firstPullComplete(), receipt: read.device('memo') };
  }, [input]), { live: true });
  const initial = view.tree.data;
  view.redraw();
  assert.equal(calls, 1);
  assert.equal(view.tree.data, initial);

  input = 'second';
  view.redraw();
  assert.equal(calls, 2);
  assert.deepEqual(view.tree.data, { input: 'second', complete: true, receipt: null });
  await engine.write(null, (device) => { device.activeReplica.deviceRows('gym').memo = 'saved'; }, ['self/gym']);
  await settle();
  assert.deepEqual(view.tree.data, { input: 'second', complete: true, receipt: 'saved' });
  const before = engine.observe('self/gym').getSnapshot();
  await engine.write(null, (device) => { device.activeReplica.cursors['self/gym'].booted = false; }, ['self/gym']);
  await settle();
  assert.notEqual(engine.observe('self/gym').getSnapshot(), before);
  assert.deepEqual(view.tree.data, { input: 'second', complete: false, receipt: 'saved' });
  const after = calls;
  view.redraw();
  assert.equal(calls, after);
  view.tree.retry();
  assert.equal(calls, after + 1);
});

test('a cached failed domain read retries without waiting for the replica to change', async (t) => {
  browserWith();
  const { engine } = await gymAccount(t);
  const metadata = engine.readMetadata.bind(engine);
  let broken = true, calls = 0;
  t.mock.method(engine, 'readMetadata', (...args) => {
    calls += 1;
    if (broken) throw new Error('private storage details');
    return metadata(...args);
  });
  const view = renderHook(t, () => useDomainRead((read) => read.firstPullComplete()));
  assert.equal(view.tree.phase, 'failed');
  view.redraw();
  assert.equal(calls, 1);
  broken = false;
  view.tree.retry();
  assert.equal(calls, 2);
  assert.deepEqual({ phase: view.tree.phase, data: view.tree.data }, { phase: 'ready', data: true });
});

test('a memoized read advances at local midnight and when the tab resumes without a replica change', async (t) => {
  const now = new Date(2026, 9, 8, 23, 59).getTime();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const browser = browserWith();
  const { engine } = await gymAccount(t);
  const snapshot = engine.observe('self/gym').getSnapshot();
  let calls = 0;
  const view = renderHook(t, () => useDomainRead((read) => { calls += 1; return read.moment.today.text; }));
  view.redraw();
  assert.equal(calls, 1);
  assert.equal(view.tree.data, '2026-10-08');
  t.mock.timers.tick(60_000);
  assert.equal(view.tree.data, '2026-10-09');
  assert.equal(calls, 2);
  browser.hide();
  t.mock.timers.setTime(new Date(2026, 9, 10, 12).getTime());
  browser.show();
  assert.equal(view.tree.data, '2026-10-10');
  assert.equal(calls, 3);
  assert.equal(engine.observe('self/gym').getSnapshot(), snapshot);
});
