import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoomStatus, publishRoomStatus, subscribeRoomStatus } from '../../src/shell/roomStatus.js';

test('room status freezes the publication and notifies only when its meaning changes', () => {
  const seen = [];
  const unsubscribe = subscribeRoomStatus(() => seen.push(getRoomStatus()));
  const status = { line: 'Offline · changes will sync', short: 'Offline', icon: 'offline', narrow: 'icon' };
  const release = publishRoomStatus(status);
  assert.deepEqual(getRoomStatus(), status);
  assert.equal(Object.isFrozen(getRoomStatus()), true);
  const snapshot = getRoomStatus();
  status.line = 'Changed elsewhere';
  assert.equal(getRoomStatus().line, 'Offline · changes will sync');
  const newer = publishRoomStatus({ ...snapshot });
  assert.equal(getRoomStatus(), snapshot);
  release();
  assert.equal(getRoomStatus(), snapshot);
  newer();
  newer();
  assert.equal(getRoomStatus(), null);
  assert.deepEqual(seen, [snapshot, null]);
  unsubscribe();
});

test('a new room replaces the previous room without reviving its status on cleanup', () => {
  const first = publishRoomStatus({ line: 'Saving…', narrow: 'announce' });
  const second = publishRoomStatus({ line: 'Saved', narrow: 'announce' });
  first();
  assert.deepEqual(getRoomStatus(), { line: 'Saved', narrow: 'announce' });
  second();
  assert.equal(getRoomStatus(), null);
});

test('a room that publishes nothing leaves the global notice eligible', () => {
  const release = publishRoomStatus({ line: 'Offline' });
  const empty = publishRoomStatus(null);
  assert.equal(getRoomStatus(), null);
  release();
  empty();
  assert.equal(getRoomStatus(), null);
});
