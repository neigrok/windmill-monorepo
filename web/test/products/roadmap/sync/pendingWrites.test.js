import test from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_STAMP } from '../../../../src/products/roadmap/model/Legend.js';
import { outboxStamps, outboxWrites, pendingGestures, pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

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


test('precomputed outbox stamps preserve their inputs and agree with frame delivery', () => {
  const frame = { nodes: [
    { id: 'a', label: 'Confirmed', labelAt: '5:0:r' },
    { id: 'b', label: 'In flight', labelAt: '6:0:r' },
    { id: 'c', label: 'Superseded in flight', labelAt: '8:0:r' },
  ] };
  const baseline = { nodes: [frame.nodes[0]] };
  const inFlight = [{ nodes: [frame.nodes[1], { id: 'c', label: 'Older', labelAt: '7:0:r' }] }];
  const stamps = Object.freeze(writeStamps(frame));
  const confirmed = Object.freeze(writeStamps(baseline));
  const carried = inFlight.map((writes) => Object.freeze(writeStamps(writes)));
  const expected = { [key('nodes', 'c', 'labelAt')]: '8:0:r' };
  assert.deepEqual(outboxStamps(stamps, confirmed, carried), expected);
  assert.deepEqual(writeStamps(outboxWrites(frame, baseline, inFlight)), expected);
  assert.deepEqual(stamps, writeStamps(frame));
  assert.deepEqual(confirmed, writeStamps(baseline));
  assert.deepEqual(carried, inFlight.map(writeStamps));
});

test('the guide is its own register: it pends, confirms and discards apart from a title written at the same stamp', () => {
  const frame = { title: { v: 'Sail', at: '7:0:r' }, guide: { v: 'One step a week.', at: '7:0:r' }, nodes: [] };
  assert.deepEqual(writeStamps(frame), { [key('title', '', 'at')]: '7:0:r', [key('guide', '', 'at')]: '7:0:r' });
  assert.equal(pendingRecordCount(writeStamps(frame)), 2);
  assert.deepEqual(outboxWrites(frame, { title: frame.title }), { guide: frame.guide, nodes: [] });
  assert.deepEqual(outboxWrites(frame, {}, [{ guide: frame.guide }]), { title: frame.title, nodes: [] });
  assert.deepEqual(pendingGestures(frame, { guide: frame.guide }), { '7:0:r': { [key('title', '', 'at')]: '7:0:r' } });
});
