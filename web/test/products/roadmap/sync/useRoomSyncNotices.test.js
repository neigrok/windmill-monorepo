import test from 'node:test';
import assert from 'node:assert/strict';
import { useRoadmapSyncStatus as syncHook } from '../../../../src/products/roadmap/sync/useRoomSyncNotices.js';
import { OFFLINE_GRACE_MS, SAVING_DELAY_MS, SAVED_HOLD_MS } from '../../../../src/products/roadmap/sync/status.js';
import { renderHook } from '../../gym/harness.mjs';
import { closuresIn } from '../sourceClosures.js';

const notices = await closuresIn('sync/useRoomSyncNotices.js');

function syncClock() {
  let now = 1000;
  let key = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (run, delay) => { timers.set(++key, { run, at: now + delay }); return key; },
    clearTimeout: (id) => timers.delete(id),
    advance: (ms) => {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].run();
      }
      now = end;
    },
    count: () => timers.size,
  };
}

function statusSession(overrides = {}) {
  let snapshot = Object.freeze({ phase: 'live', online: true, structurePending: 0, progressPending: 0,
    structureInFlight: 0, progressInFlight: 0, refused: null, receiptVersion: 0, ...overrides });
  const listeners = new Set();
  return {
    statusSnapshot: () => snapshot,
    subscribeStatus: (handler) => { listeners.add(handler); handler(snapshot); return () => listeners.delete(handler); },
    change: (next) => { snapshot = Object.freeze({ ...snapshot, ...next }); for (const listener of listeners) listener(snapshot); },
    count: () => listeners.size,
  };
}

test('host sync timing delays Saving, holds Saved, and cleans up every clock and subscription', (t) => {
  const clock = syncClock();
  const session = statusSession();
  const hook = renderHook(t, () => syncHook(session, clock));
  assert.equal(hook.tree.state, null);
  session.change({ structurePending: 1 });
  clock.advance(SAVING_DELAY_MS - 1);
  assert.equal(hook.tree.state, null);
  clock.advance(1);
  assert.equal(hook.tree.state, 'saving');
  session.change({ structurePending: 0 });
  assert.equal(hook.tree.state, 'saved');
  clock.advance(SAVED_HOLD_MS - 1);
  assert.equal(hook.tree.state, 'saved');
  clock.advance(1);
  assert.equal(hook.tree.state, null);
  session.change({ phase: 'offline' });
  clock.advance(OFFLINE_GRACE_MS - 1);
  assert.equal(hook.tree.state, null);
  clock.advance(1);
  assert.equal(hook.tree.state, 'offline');
  hook.unmount();
  assert.deepEqual([session.count(), clock.count()], [0, 0]);
});

test('host sync refuses stale session readings, fast acks never flash Saving, and no session subscribes to nothing', (t) => {
  const clock = syncClock();
  const first = statusSession();
  const second = statusSession({ online: false });
  let session = first;
  const hook = renderHook(t, () => syncHook(session, clock));
  first.change({ progressPending: 1 });
  clock.advance(SAVING_DELAY_MS - 1);
  first.change({ progressPending: 0 });
  assert.equal(hook.tree.state, 'saved');
  session = second;
  hook.redraw();
  assert.equal(hook.tree.snapshot, second.statusSnapshot());
  assert.equal(hook.tree.state, 'offline');
  assert.deepEqual([first.count(), second.count()], [0, 1]);
  session = null;
  hook.redraw();
  assert.deepEqual({ ...hook.tree }, { snapshot: null, state: null });
  assert.deepEqual([first.count(), second.count(), clock.count()], [0, 0, 0]);
});

test('host reports discard only after the session confirms success', async () => {
  for (const result of [false, true]) {
    const events = [];
    const quiet = [];
    let finish;
    const discard = notices.callback('discardSync', {
      refused: { lane: 'structure' }, refusalCode: 'server-error',
      syncSession: { discardPending: true, discard: () => new Promise((resolve) => { finish = resolve; }) },
      setBoardQuiet: (update) => quiet.push(update(0)),
      track: (name, props) => events.push([name, { ...props }]),
    });
    const pending = discard();
    assert.deepEqual(quiet, [1]);
    assert.deepEqual(events, []);
    finish(result);
    await pending;
    assert.deepEqual(events, result ? [['roadmap_sync_refused', { step: 'discard', lane: 'structure', code: 'server-error' }]] : []);
  }
});

test('discard rebaselines never announce Saving or Saved, including a slow online resubscribe', (t) => {
  const clock = syncClock();
  const session = statusSession({ structurePending: 2, refused: { lane: 'structure', code: 'bad-frame' } });
  const hook = renderHook(t, () => syncHook(session, clock));
  clock.advance(SAVING_DELAY_MS);
  session.change({ rebaselining: true, structurePending: 0, refused: null, phase: 'syncing' });
  assert.equal(hook.tree.state, null);
  clock.advance(OFFLINE_GRACE_MS * 2);
  assert.equal(hook.tree.state, null);
  session.change({ rebaselining: false, phase: 'live' });
  assert.equal(hook.tree.state, null);
  clock.advance(SAVED_HOLD_MS);
  assert.equal(hook.tree.state, null);
  session.change({ structurePending: 1 });
  clock.advance(SAVING_DELAY_MS);
  assert.equal(hook.tree.state, 'saving');
  session.change({ structurePending: 0 });
  assert.equal(hook.tree.state, 'saved');
});

test('a real pending progress gesture still shows Saving during a structure rebaseline', (t) => {
  const clock = syncClock();
  const session = statusSession({ structurePending: 2, progressPending: 1, refused: { lane: 'structure', code: 'bad-frame' } });
  const hook = renderHook(t, () => syncHook(session, clock));
  session.change({ rebaselining: true, structurePending: 0, refused: null, phase: 'syncing' });
  clock.advance(SAVING_DELAY_MS);
  assert.equal(hook.tree.state, 'saving');
  clock.advance(OFFLINE_GRACE_MS * 2);
  assert.equal(hook.tree.state, 'saving');
  session.change({ progressPending: 0 });
  assert.equal(hook.tree.state, null);
  session.change({ rebaselining: false, phase: 'live' });
  assert.equal(hook.tree.state, null);
});
