// The picker's three silences, pinned apart. One sentence used to cover all of them, so a lifter
// who typed a letter the catalog does not hold was told the catalog had not loaded — the app
// reporting a failure that never happened, and pointing them at their signal to fix it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { movementOptions, PICKER_MATCHES } from '../../../../src/products/gym/logger/movements.js';

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

test('a query that matches nothing says only that — one letter or twenty, and no door it does not have', () => {
  for (const query of ['z', 'j', '5', 'zqx', 'pendlay row']) {
    const options = movementOptions({ catalog: CATALOG, order: [], query });
    assert.deepEqual(options.matches, []);
    assert.equal(options.empty, `Nothing in the catalog matches “${query.trim()}”.`);
  }
});

test('only an empty catalog may mention signal', () => {
  assert.deepEqual(movementOptions({ catalog: [], order: [], query: '' }), {
    matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.',
  });
  assert.deepEqual(movementOptions({ catalog: [], order: [], query: 'z' }), {
    matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.',
  });
  const loaded = movementOptions({ catalog: CATALOG, order: [], query: 'z' });
  assert.equal(loaded.empty, 'Nothing in the catalog matches “z”.');
});

test('a catalog entirely in the session says so, and never blames the network', () => {
  const order = CATALOG.map((each) => each.id);
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: '' }), {
    matches: [], empty: 'Every movement in the catalog is already in this session.',
  });
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: 'squat' }), {
    matches: [], empty: 'Every movement in the catalog is already in this session.',
  });
});
