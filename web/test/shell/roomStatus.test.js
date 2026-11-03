import { SYNC_STATUS, SYNC_OFFLINE_SHORT } from '../../src/products/roadmap/board/copy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getRoomStatus, registerRoomStatus, subscribeRoomStatus, useRoomStatus } from '../../src/shell/roomStatus.js';
import { renderHook } from '../products/gym/harness.mjs';

const offline = { line: SYNC_STATUS.offline, short: SYNC_OFFLINE_SHORT, icon: 'offline', narrow: 'icon', connectivity: 'offline' };

test('registration keeps an idle publication until released, independently of the current status', (t) => {
  const view = renderHook(t, useRoomStatus, { live: true });
  assert.equal(view.tree, null);
  const room = registerRoomStatus();
  assert.deepEqual(view.tree, { status: null });
  assert.equal(getRoomStatus(), null);
  room.publish({ line: SYNC_STATUS.saving, narrow: 'announce' });
  assert.deepEqual(view.tree, { status: { line: SYNC_STATUS.saving, narrow: 'announce' } });
  room.publish(null);
  assert.deepEqual(view.tree, { status: null });
  room.release();
  assert.equal(view.tree, null);
});

test('room status freezes the publication and notifies only when its meaning changes', () => {
  const seen = [];
  const unsubscribe = subscribeRoomStatus(() => seen.push(getRoomStatus()));
  const room = registerRoomStatus();
  const status = { ...offline };
  room.publish(status);
  assert.deepEqual(getRoomStatus(), status);
  assert.equal(Object.isFrozen(getRoomStatus()), true);
  const snapshot = getRoomStatus();
  status.line = 'Changed elsewhere';
  assert.equal(getRoomStatus().line, offline.line);
  room.publish({ ...snapshot });
  assert.equal(getRoomStatus(), snapshot);
  room.release();
  room.release();
  assert.equal(getRoomStatus(), null);
  assert.deepEqual(seen, [null, snapshot, null]);
  unsubscribe();
});

test('a stale room cannot update or release the next room publication', () => {
  const first = registerRoomStatus();
  first.publish({ line: SYNC_STATUS.saving, narrow: 'announce' });
  const second = registerRoomStatus();
  second.publish({ line: SYNC_STATUS.saved, narrow: 'announce' });
  first.publish(offline);
  first.release();
  assert.deepEqual(getRoomStatus(), { line: SYNC_STATUS.saved, narrow: 'announce' });
  second.release();
  assert.equal(getRoomStatus(), null);
});

test('connectivity is an explicit publication fact and its changes notify without changing the text', () => {
  const room = registerRoomStatus();
  const seen = [];
  const unsubscribe = subscribeRoomStatus(() => seen.push(getRoomStatus()));
  room.publish({ line: 'Room status' });
  room.publish({ line: 'Room status', connectivity: 'offline' });
  room.publish({ line: 'Room status' });
  assert.deepEqual(seen, [
    { line: 'Room status' },
    { line: 'Room status', connectivity: 'offline' },
    { line: 'Room status' },
  ]);
  unsubscribe();
  room.release();
});
