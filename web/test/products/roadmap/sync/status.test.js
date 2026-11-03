import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncStatus, OFFLINE_GRACE_MS, SAVING_DELAY_MS, SAVED_HOLD_MS } from '../../../../src/products/roadmap/sync/status.js';

const live = Object.freeze({ phase: 'live', online: true, structurePending: 0, progressPending: 0, structureInFlight: 0, progressInFlight: 0, refused: null });
const facts = Object.freeze({ lastLiveAt: 10000, pendingSince: null, drainedAt: null });

test('offline grace includes load and reconnect and ends at the named boundary', () => {
  for (const phase of ['offline', 'syncing']) {
    const snapshot = { ...live, phase };
    assert.equal(deriveSyncStatus(snapshot, 10000, facts), null);
    assert.equal(deriveSyncStatus(snapshot, 10000 + OFFLINE_GRACE_MS - 1, facts), null);
    assert.equal(deriveSyncStatus(snapshot, 10000 + OFFLINE_GRACE_MS, facts), 'offline');
    assert.equal(deriveSyncStatus(snapshot, 10000 + OFFLINE_GRACE_MS + 1, facts), 'offline');
  }
  assert.equal(deriveSyncStatus(live, 10000 + OFFLINE_GRACE_MS + 1, facts), null);
});

test('browser offline is immediate, including at initial load and with a refusal', () => {
  assert.equal(deriveSyncStatus({ ...live, online: false }, 10000, facts), 'offline');
  assert.equal(deriveSyncStatus({ ...live, online: false, refused: { lane: 'structure', code: 'bad-frame' } }, 10000, facts), 'offline');
});

test('each pending and in-flight lane waits until the saving delay', () => {
  for (const field of ['structurePending', 'progressPending', 'structureInFlight', 'progressInFlight']) {
    const snapshot = { ...live, [field]: 1 };
    const pending = { ...facts, pendingSince: 10000 };
    assert.equal(deriveSyncStatus(snapshot, 10000, pending), null);
    assert.equal(deriveSyncStatus(snapshot, 10000 + SAVING_DELAY_MS - 1, pending), null);
    assert.equal(deriveSyncStatus(snapshot, 10000 + SAVING_DELAY_MS, pending), 'saving');
    assert.equal(deriveSyncStatus(snapshot, 10000 + SAVING_DELAY_MS + 1, pending), 'saving');
    assert.equal(deriveSyncStatus(snapshot, 11000, facts), null);
  }
});

test('saved holds only after live drain and clears at the hold boundary', () => {
  const drained = { ...facts, drainedAt: 10000 };
  assert.equal(deriveSyncStatus(live, 10000, drained), 'saved');
  assert.equal(deriveSyncStatus(live, 10000 + SAVED_HOLD_MS - 1, drained), 'saved');
  assert.equal(deriveSyncStatus(live, 10000 + SAVED_HOLD_MS, drained), null);
  assert.equal(deriveSyncStatus(live, 10000 + SAVED_HOLD_MS + 1, drained), null);
  assert.equal(deriveSyncStatus({ ...live, phase: 'syncing' }, 10001, drained), null);
  assert.equal(deriveSyncStatus({ ...live, structurePending: 1 }, 10001, drained), null);
});

test('refusal suppresses saving and saved but keeps offline honest', () => {
  const refused = { ...live, refused: { lane: 'progress', code: 'server-error' } };
  assert.equal(deriveSyncStatus({ ...refused, progressPending: 1 }, 11000, { ...facts, pendingSince: 10000 }), null);
  assert.equal(deriveSyncStatus(refused, 11000, { ...facts, drainedAt: 10000 }), null);
  assert.equal(deriveSyncStatus({ ...refused, phase: 'offline' }, 10000 + OFFLINE_GRACE_MS, facts), 'offline');
});
