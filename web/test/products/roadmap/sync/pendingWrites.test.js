import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingGestures, pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

const key = (section, id, field) => JSON.stringify([section, id, field]);

test('pending references distinguish records sharing one stamp and contain no user content', () => {
  const writes = {
    nodes: [{ id: 'new', createdAt: '5:0:tab', label: 'Private label', labelAt: '5:0:tab' }],
    edges: [{ from: 'root', to: 'new', addedAt: '5:0:tab' }],
  };
  const refs = {
    [key('nodes', 'new', 'createdAt')]: '5:0:tab',
    [key('nodes', 'new', 'labelAt')]: '5:0:tab',
    [key('edges', ['root', 'new'], 'addedAt')]: '5:0:tab',
  };
  assert.deepEqual(writeStamps(writes), refs);
  assert.deepEqual(pendingGestures(writes, {}), { '5:0:tab': refs });
  assert.equal(pendingRecordCount(refs), 2);
  assert.deepEqual(pendingGestures(writes, { nodes: writes.nodes }), {
    '5:0:tab': { [key('edges', ['root', 'new'], 'addedAt')]: '5:0:tab' },
  });
  assert.deepEqual(pendingGestures(writes, writes), {});
});

test('a newer stamp covers only its exact register while superseded gestures remain until confirmation', () => {
  const before = { nodes: [{ id: 'root', labelAt: '3:0:tab' }] };
  const later = { nodes: [{ id: 'root', labelAt: '4:0:tab' }] };
  const gestures = pendingGestures(later, {}, pendingGestures(before, {}));
  assert.deepEqual(Object.keys(gestures), ['3:0:tab', '4:0:tab']);
  assert.deepEqual(pendingGestures({}, later, gestures), {});
  assert.deepEqual(unconfirmedStamps(writeStamps(before), writeStamps({ nodes: [{ id: 'other', labelAt: '9:0:tab' }] })), writeStamps(before));
});
