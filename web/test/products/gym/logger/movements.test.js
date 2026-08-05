// The picker's four silences, pinned apart. One sentence used to cover all of them, so a lifter
// who typed a letter the catalog does not hold was told the catalog had not loaded — the app
// reporting a failure that never happened, and pointing them at their signal to fix it. The fourth
// is the one with a WRITE behind it: a movement the catalog holds and this session already has is
// not a movement to mint a second copy of.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREATED_MOVEMENT, movementOptions, PICKER_MATCHES,
} from '../../../../src/products/gym/logger/movements.js';

const CATALOG = [
  { id: 'back-squat', name: 'Back Squat' },
  { id: 'bench-press', name: 'Bench Press' },
  { id: 'chin-up', name: 'Chin-up' },
  { id: 'front-squat', name: 'Front Squat' },
  { id: 'overhead-press', name: 'Overhead Press' },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift' },
  { id: 'barbell-row', name: 'Barbell Row' },
  { id: 'face-pull', name: 'Face Pull' },
];

test('no query offers the catalog, capped at seven, minus what is already in the session', () => {
  assert.equal(PICKER_MATCHES, 7);
  const all = movementOptions({ catalog: CATALOG, order: [], query: '' });
  assert.deepEqual(all.matches.map((each) => each.id), [
    'back-squat', 'bench-press', 'chin-up', 'front-squat', 'overhead-press', 'romanian-deadlift',
    'barbell-row',
  ]);
  assert.equal(all.empty, null);

  const some = movementOptions({ catalog: CATALOG, order: ['back-squat', 'chin-up'], query: '' });
  assert.deepEqual(some.matches.map((each) => each.id), [
    'bench-press', 'front-squat', 'overhead-press', 'romanian-deadlift', 'barbell-row', 'face-pull',
  ]);
  assert.equal(some.empty, null);
});

test('a query matches on name, case-folded, anywhere in it', () => {
  assert.deepEqual(
    movementOptions({ catalog: CATALOG, order: [], query: 'SQUAT' }).matches.map((each) => each.id),
    ['back-squat', 'front-squat'],
  );
  assert.deepEqual(
    movementOptions({ catalog: CATALOG, order: [], query: '  press ' }).matches.map((each) => each.id),
    ['bench-press', 'overhead-press'],
  );
});

// The sentence no longer echoes the query — the button beside it does, and saying it twice in one
// breath is what made the echo worth moving.
test('a query that matches nothing says only that, and offers the door out', () => {
  for (const query of ['z', 'j', '5', 'zqx', 'pendlay row']) {
    const options = movementOptions({ catalog: CATALOG, order: [], query });
    assert.deepEqual(options.matches, []);
    assert.equal(options.empty, 'No movement by that name.');
    assert.equal(options.create, `Create “${query.trim()}”`);
  }
  assert.equal(movementOptions({ catalog: CATALOG, order: [], query: '  zercher  ' }).create, 'Create “zercher”');
});

test('only an empty catalog may mention signal, and it offers no door it cannot open', () => {
  assert.deepEqual(movementOptions({ catalog: [], order: [], query: '' }), {
    matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.', create: null,
  });
  assert.deepEqual(movementOptions({ catalog: [], order: [], query: 'z' }), {
    matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.', create: null,
  });
  const loaded = movementOptions({ catalog: CATALOG, order: [], query: 'z' });
  assert.equal(loaded.empty, 'No movement by that name.');
});

test('a catalog entirely in the session says so, and never blames the network', () => {
  const order = CATALOG.map((each) => each.id);
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: '' }), {
    matches: [], empty: 'Every movement in the catalog is already in this session.', create: null,
  });
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: 'squat' }), {
    matches: [], empty: 'Every movement in the catalog is already in this session.', create: null,
  });
});

// The picker asks for a name and nothing else — there is no taxonomy screen — so the two fields the
// wire requires are chosen to claim as little as they can.
test('a created movement is stored under the least-claiming pair the wire will take', () => {
  assert.deepEqual(CREATED_MOVEMENT, { pattern: 'isolation', equipment: 'barbell' });
});

test('a match offers no create — the movement the lifter meant is already on the list', () => {
  const hit = movementOptions({ catalog: CATALOG, order: [], query: 'squat' });
  assert.equal(hit.create, null);
  assert.equal(hit.empty, null);
});

// THE CREATE DOOR OVER A MOVEMENT THAT ALREADY EXISTS. The list this function filters is the
// AVAILABLE one, so a movement already in the session is missing from it for a reason that has
// nothing to do with the catalog — and reading that silence as "no movement by that name" offered
// to mint a second Zercher Squat over a catalog holding one. Two rows with one name forever, and
// the movement's history split between two ids: the exact failure the picker exists to prevent,
// and before the create door landed the same sentence was merely misleading.
test('a movement the session already holds is named as such, and is never offered as a new one', () => {
  const catalog = [...CATALOG, { id: 'ex_31ab', name: 'Zercher Squat', custom: true }];
  const options = movementOptions({ catalog, order: ['ex_31ab'], query: 'Zercher Squat' });
  assert.deepEqual(options, {
    matches: [], empty: 'That movement is already in this session.', create: null,
  });
  // Case and whitespace change nothing: the catalog is matched exactly as the picker matches it.
  assert.equal(movementOptions({ catalog, order: ['ex_31ab'], query: '  zercher ' }).create, null);
  // A movement in the session does not shield an unrelated query from the door it deserves.
  assert.equal(
    movementOptions({ catalog, order: ['ex_31ab'], query: 'Pendlay Row' }).create,
    'Create “Pendlay Row”',
  );
  assert.equal(movementOptions({ catalog, order: ['ex_31ab'], query: 'Pendlay Row' }).empty, 'No movement by that name.');
});
