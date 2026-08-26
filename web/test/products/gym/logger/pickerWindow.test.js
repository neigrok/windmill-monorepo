import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mostTrained, movementOptions, PICKER_FEATURED, PICKER_OPENERS, TRAINED_WINDOW,
} from '../../../../src/products/gym/logger/movements.js';
import { API_BASE } from '../../../../src/shell/apiBase.js';
import React from 'react';

import { browserWith, elementsOf, loadScreen, renderHook, settle } from '../harness.mjs';

// Everything the openers name, plus one movement the log will bury them under.
const CATALOG = [
  { id: 'back-squat', name: 'Back Squat' },
  { id: 'bench-press', name: 'Bench Press' },
  { id: 'deadlift', name: 'Deadlift' },
  { id: 'overhead-press', name: 'Overhead Press' },
  { id: 'barbell-row', name: 'Barbell Row' },
  { id: 'chin-up', name: 'Chin-up' },
  { id: 'face-pull', name: 'Face Pull' },
];

// Newest first, the way `useTrainingLog` holds the log: fifty sessions of the openers, and then the
// older pages a lifter reaches by tapping Older on the Log tab, all naming one other movement.
const NEWEST_FIFTY = Array.from({ length: TRAINED_WINDOW }, () => ({
  exercises: ['Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Chin-up'],
}));
const OLDER_PAGES = Array.from({ length: 150 }, () => ({ exercises: ['Face Pull'] }));

test('the six do not move with how far the Log tab has been walked', () => {
  const shallow = mostTrained(CATALOG, NEWEST_FIFTY).map((each) => each.id);
  const walked = mostTrained(CATALOG, [...NEWEST_FIFTY, ...OLDER_PAGES]).map((each) => each.id);
  assert.deepEqual(shallow, PICKER_OPENERS);
  assert.deepEqual(walked, shallow, 'three Older taps deep, the same six');
  // And the movement those older pages are full of never reaches the section, however deep the walk:
  // 150 sessions of Face Pull outnumber every opener and are still outside the window.
  assert.equal(walked.includes('face-pull'), false);
});

test('a fresh account is offered the six too — nothing here is gated on a first session', () => {
  const fresh = movementOptions({ catalog: CATALOG, order: [], query: '', sessions: [] });
  assert.deepEqual(fresh.featured.map((each) => each.id), PICKER_OPENERS);
  assert.equal(fresh.featured.length, PICKER_FEATURED);
  // The catalogue follows the six uncapped, and nothing is in both lists.
  assert.deepEqual(fresh.matches.map((each) => each.id), ['face-pull']);
  assert.equal(fresh.empty, null);
});

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const sixOf = (tree) => elementsOf(tree)
  .filter((each) => each.props?.className === 'gym-picker-row')
  .slice(0, PICKER_FEATURED)
  .map((each) => elementsOf(each).find((child) => child.props?.className === 'gym-picker-named').props.children[0]);

// One open picker, whose `sessions` prop the test moves under it the way a poll or an Older tap does.
let MovementPicker = null;
async function picker(t, opening) {
  browserWith();
  global.fetch = async (url) => {
    assert.equal(url, `${API_BASE}/v1/gym/exercises/last`);
    return { ok: true, status: 200, json: async () => ({ movements: [] }) };
  };
  ({ MovementPicker } = await loadScreen('products/gym/logger/MovementPicker.jsx'));
  let sessions = opening;
  let redraw = () => {};
  const drawn = renderHook(t, () => {
    const [, tick] = React.useState(0);
    redraw = () => tick((count) => count + 1);
    return MovementPicker({
      catalog: CATALOG, sessions, query: '', onQuery: () => {}, onPick: () => {}, onClose: () => {},
    });
  });
  return { drawn, land: (landed) => { sessions = landed; redraw(); } };
}

test('the picker holds the window it opened on: the log moving under it moves nothing', async (t) => {
  const { drawn, land } = await picker(t, NEWEST_FIFTY);
  await settle();

  // Opened over a log that has answered: the section is the six that log names most.
  assert.deepEqual(sixOf(drawn.tree), [
    'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Chin-up',
  ]);

  // A poll lands a hundred sessions of one movement while the picker stands open. The six are the
  // ones the lifter is already reaching for, so they do not move.
  land([...OLDER_PAGES, ...NEWEST_FIFTY]);
  assert.deepEqual(sixOf(drawn.tree), [
    'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Chin-up',
  ]);

  // The next open is a new read, and that one counts what landed.
  const reopened = renderHook(t, () => MovementPicker({
    catalog: CATALOG, sessions: [...OLDER_PAGES, ...NEWEST_FIFTY], query: '', onQuery: () => {}, onPick: () => {}, onClose: () => {},
  }));
  assert.deepEqual(sixOf(reopened.tree), [
    'Face Pull', 'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row',
  ]);
});

test('a picker opened before the log answers freezes on the first read that ANSWERS, not on nothing', async (t) => {
  const { drawn, land } = await picker(t, []);
  await settle();

  // Opened over a log that has said nothing yet: the six are the openers every surface draws.
  assert.deepEqual(sixOf(drawn.tree), [
    'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row', 'Chin-up',
  ]);

  // The read lands under the open picker. An empty window is no window at all, so this one is taken
  // — a picker opened a beat early does not keep the generic six for the rest of its life.
  land(Array.from({ length: 60 }, () => ({ exercises: ['Face Pull'] })));
  assert.deepEqual(sixOf(drawn.tree), [
    'Face Pull', 'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row',
  ]);

  // And from that read on it is frozen: the next page landing moves nothing under the thumb.
  land([...Array.from({ length: 100 }, () => ({ exercises: ['Chin-up'] }))]);
  assert.deepEqual(sixOf(drawn.tree), [
    'Face Pull', 'Back Squat', 'Bench Press', 'Deadlift', 'Overhead Press', 'Barbell Row',
  ]);
});
