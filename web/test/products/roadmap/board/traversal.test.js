import test from 'node:test';
import assert from 'node:assert/strict';

import { SHOW_ALL, RAIL, columnStops, entryStop, moveStop, nearestStop, pendingStop } from '../../../../src/products/roadmap/board/traversal.js';

const name = (stop) => (stop === null ? 'nowhere' : `${stop.column} ${typeof stop.id === 'symbol' ? stop.id.description : stop.id}`);

test('columnStops — a column offers its cards in order, then Show all while Done is folded', () => {
  const cards = [{ id: 'rig' }, { id: 'parts' }];
  assert.deepEqual(columnStops({ cards, folded: false }), ['rig', 'parts']);
  assert.deepEqual(columnStops({ cards, folded: true }), ['rig', 'parts', SHOW_ALL]);
});

test('entryStop — Tab enters on the last focused stop, else a column’s remembered stop, else the first Up next card', () => {
  const layout = [
    { name: 'locked', stops: ['dock', 'triangle', 'solo'] },
    { name: 'upNext', stops: ['wind', 'bowline'] },
    { name: 'done', stops: ['rig', 'parts', 'course'] },
  ];
  const memory = (last, byColumn = {}) => ({ last, byColumn });
  assert.deepEqual([
    entryStop(layout, memory(null)),
    entryStop(layout, memory('done', { done: 'parts', locked: 'solo' })),
    entryStop(layout, memory('done', { done: 'gone', locked: 'solo', upNext: 'bowline' })),
    entryStop(layout, memory('done', { done: 'gone', locked: 'solo' })),
    entryStop(layout, memory('done', { done: 'gone' })),
  ].map(name), ['upNext wind', 'done parts', 'upNext bowline', 'locked solo', 'upNext wind']);
});

test('entryStop — an empty Up next hands entry to the first column with a stop; a rail’s Show is remembered like a card', () => {
  assert.equal(name(entryStop([{ name: 'locked', stops: ['dock'] }, { name: 'upNext', stops: [] }, { name: 'done', stops: [RAIL] }], { last: null, byColumn: {} })), 'locked dock');
  assert.equal(name(entryStop([{ name: 'locked', stops: [] }, { name: 'upNext', stops: [] }, { name: 'done', stops: [RAIL] }], { last: null, byColumn: {} })), 'done rail Show');
  assert.equal(name(entryStop([{ name: 'locked', stops: ['dock'] }, { name: 'upNext', stops: ['wind'] }, { name: 'done', stops: [RAIL] }], { last: 'done', byColumn: { done: RAIL } })), 'done rail Show');
  assert.equal(entryStop([{ name: 'upNext', stops: [] }], { last: null, byColumn: {} }), null);
});

test('moveStop — Up and Down step within a column, Home and End jump to its ends, and a move past an end goes nowhere', () => {
  const layout = [{ name: 'done', stops: ['rig', 'parts', 'course', SHOW_ALL] }];
  const from = (id) => ({ column: 'done', id });
  assert.deepEqual([
    moveStop(layout, from('parts'), 'ArrowDown'),
    moveStop(layout, from('parts'), 'ArrowUp'),
    moveStop(layout, from('rig'), 'ArrowUp'),
    moveStop(layout, from('course'), 'End'),
    moveStop(layout, from(SHOW_ALL), 'ArrowDown'),
    moveStop(layout, from(SHOW_ALL), 'Home'),
    moveStop(layout, from('rig'), 'Home'),
    moveStop(layout, from('parts'), 'Enter'),
  ].map(name), ['done course', 'done rig', 'nowhere', 'done Show all', 'nowhere', 'done rig', 'nowhere', 'nowhere']);
});

test('moveStop — Left and Right cross to the neighbouring column, skip an empty one and land where nearest says; a rail lands on its Show', () => {
  const layout = [
    { name: 'locked', stops: ['dock', 'triangle'] },
    { name: 'upNext', stops: [] },
    { name: 'done', stops: [RAIL] },
  ];
  const nearest = (column) => column.stops.at(-1);
  assert.deepEqual([
    moveStop(layout, { column: 'locked', id: 'dock' }, 'ArrowRight', nearest),
    moveStop(layout, { column: 'done', id: RAIL }, 'ArrowLeft', nearest),
    moveStop(layout, { column: 'done', id: RAIL }, 'ArrowLeft'),
    moveStop(layout, { column: 'locked', id: 'dock' }, 'ArrowLeft', nearest),
    moveStop(layout, { column: 'done', id: RAIL }, 'ArrowRight', nearest),
    moveStop(layout, { column: 'gone', id: 'dock' }, 'ArrowRight', nearest),
  ].map(name), ['done rail Show', 'locked triangle', 'locked dock', 'nowhere', 'nowhere', 'nowhere']);
});

test('nearestStop — the stop whose middle sits closest to the height, the earlier one on a tie', () => {
  const candidates = [{ id: 'a', top: 0, bottom: 100 }, { id: 'b', top: 108, bottom: 160 }, { id: 'c', top: 168, bottom: 268 }];
  assert.deepEqual([nearestStop(10, candidates), nearestStop(130, candidates), nearestStop(500, candidates), nearestStop(92, candidates), nearestStop(10, [])],
    ['a', 'b', 'c', 'a', null]);
});


test('pendingStop — a completion waits for its column move, but a filtered or removed target releases focus recovery', () => {
  const pending = { column: 'done', id: 'wind' };
  assert.deepEqual(pendingStop([{ name: 'upNext', stops: ['wind'] }, { name: 'done', stops: ['rig'] }], pending), pending);
  assert.deepEqual(pendingStop([{ name: 'upNext', stops: [] }, { name: 'done', stops: ['wind', 'rig'] }], pending), pending);
  assert.equal(pendingStop([{ name: 'upNext', stops: ['bowline'] }, { name: 'done', stops: ['rig'] }], pending), null);
  assert.equal(pendingStop([], null), null);
});

test('pendingStop — a phone follows into a hidden destination while the source card remains in another filtered column', () => {
  const layout = [{ name: 'done', stops: ['rig'] }];
  const pending = { column: 'done', id: 'wind' };
  assert.deepEqual(pendingStop(layout, pending, new Set(['wind', 'rig'])), pending);
  assert.equal(pendingStop(layout, pending, new Set(['rig'])), null);
});


test('pendingStop — an accepted completion survives its phone tab switch, then a superseding Reset releases it', () => {
  const before = {};
  const reset = {};
  const pending = { column: 'done', id: 'wind', revision: before };
  const doneShown = [{ name: 'done', stops: ['rig'] }];
  const existingIds = new Set(['wind', 'rig']);
  assert.deepEqual(pendingStop(doneShown, pending, existingIds, before), pending);
  assert.equal(pendingStop(doneShown, pending, existingIds, reset), null);
});

test('pendingStop — a newer displayed Board preserves an accepted completion once its destination arrives', () => {
  const before = {};
  const arrived = {};
  const pending = { column: 'done', id: 'wind', revision: before };
  const layout = [{ name: 'upNext', stops: ['dock'] }, { name: 'done', stops: ['wind', 'rig'] }];
  assert.deepEqual(pendingStop(layout, pending, new Set(['dock', 'wind', 'rig']), arrived), pending);
  assert.equal(pendingStop(layout, { ...pending, id: 'gone' }, new Set(['dock', 'wind', 'rig']), arrived), null);
});
