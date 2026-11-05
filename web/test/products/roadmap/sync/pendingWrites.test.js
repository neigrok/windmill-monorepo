import test from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_STAMP } from '../../../../src/products/roadmap/model/Legend.js';
import { outboxWrites, pendingGestures, pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

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

for (const [name, confirmed, carried, expected] of [
  ['unconfirmed', {}, [], { nodes: [{ id: 'a', labelAt: '5:0:r', label: 'A' }] }],
  ['equal confirmation', { nodes: [{ id: 'a', labelAt: '5:0:r' }] }, [], { nodes: [] }],
  ['newer confirmation', { nodes: [{ id: 'a', labelAt: '6:0:r' }] }, [], { nodes: [] }],
  ['same carried stamp', {}, [{ nodes: [{ id: 'a', labelAt: '5:0:r' }] }], { nodes: [] }],
  ['older carried stamp', {}, [{ nodes: [{ id: 'a', labelAt: '4:0:r' }] }], { nodes: [{ id: 'a', labelAt: '5:0:r', label: 'A' }] }],
]) {
  test(`outbox keeps exactly the current register: ${name}`, () => {
    assert.deepEqual(outboxWrites({ nodes: [{ id: 'a', label: 'A', labelAt: '5:0:r' }] }, confirmed, carried), expected);
  });
}

test('outbox keys title, directed edges and marks independently even at the same stamp', () => {
  const frame = {
    title: { v: 'Tree', at: '7:0:r' },
    edges: [{ from: 'a', to: 'b', addedAt: '7:0:r' }, { from: 'b', to: 'a', addedAt: '7:0:r' }],
    marks: [{ node: 'a', status: 'complete', at: '7:0:r', markedAt: 7 }],
  };
  assert.deepEqual(outboxWrites(frame, { edges: [frame.edges[0]] }), {
    title: frame.title, edges: [frame.edges[1]], marks: frame.marks,
  });
  assert.deepEqual(outboxWrites(frame, {}, [frame]), { edges: [], marks: [] });
});

test('outbox and pending status both retain unconfirmed genesis registers', () => {
  const frame = { nodes: [{ id: 'root', createdAt: GENESIS_STAMP }] };
  const unconfirmed = unconfirmedStamps(writeStamps(frame), {});
  assert.equal(pendingRecordCount(unconfirmed), 1);
  assert.deepEqual(outboxWrites(frame, {}), frame);
  assert.deepEqual(writeStamps(outboxWrites(frame, {})), unconfirmed);
});
