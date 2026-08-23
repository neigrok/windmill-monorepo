import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREATED_PATTERN, DEFAULT_EQUIPMENT, EQUIPMENT_CHOICES, lastSetLabel, lastSetsById, movementOptions,
  NO_LAST_TIME_META, PICKER_MATCHES,
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

test('a row carries what the picker draws, and the alias only when the match came through one', () => {
  const catalog = [{ id: 'back-squat', name: 'High-bar squat', aliases: ['Back Squat', 'squats'] }];
  assert.deepEqual(movementOptions({ catalog, query: 'high' }).matches, [
    { id: 'back-squat', name: 'High-bar squat', custom: false, alias: null },
  ]);
  assert.deepEqual(movementOptions({ catalog, query: 'back sq' }).matches, [
    { id: 'back-squat', name: 'High-bar squat', custom: false, alias: 'Back Squat' },
  ]);
  assert.equal(movementOptions({ catalog, query: '' }).matches[0].alias, null);
  assert.equal(movementOptions({ catalog, query: 'squat' }).matches[0].alias, null);
  assert.equal(movementOptions({ catalog, query: 'squats' }).matches[0].alias, 'squats');
  const mine = [{ id: 'ex_31ab', name: 'Hammer row', custom: true }];
  assert.deepEqual(movementOptions({ catalog: mine, query: 'ham' }).matches, [
    { id: 'ex_31ab', name: 'Hammer row', custom: true, alias: null },
  ]);
});

test('a query matches the old name as readily as the new one, and offers no second copy', () => {
  const catalog = [{ id: 'back-squat', name: 'High-bar squat', aliases: ['Back Squat'] }];
  const hit = movementOptions({ catalog, order: [], query: 'Back Squat' });
  assert.deepEqual(hit.matches.map((each) => each.id), ['back-squat']);
  assert.equal(hit.create, null);
  assert.equal(hit.empty, null);
  const held = movementOptions({
    catalog: [...catalog, { id: 'dip', name: 'Dip' }], order: ['back-squat'], query: 'back squat',
  });
  assert.deepEqual(held.matches, []);
  assert.equal(held.empty, 'That movement is already in this session.');
  assert.equal(held.create, null);
  assert.equal(movementOptions({ catalog: [{ id: 'dip', name: 'Dip' }], query: 'dip' }).matches.length, 1);
  assert.equal(movementOptions({ catalog: [{ id: 'dip', name: 'Dip' }], query: 'squat' }).create, 'Create “squat”');
});

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

test('creating a movement asks two questions and guesses at exactly one field', () => {
  assert.equal(CREATED_PATTERN, 'isolation');
  assert.deepEqual(EQUIPMENT_CHOICES, ['barbell', 'dumbbell', 'machine', 'bodyweight']);
  assert.equal(DEFAULT_EQUIPMENT, 'barbell');
  assert.equal(EQUIPMENT_CHOICES.includes(DEFAULT_EQUIPMENT), true);
});

test('a match offers no create — the movement the lifter meant is already on the list', () => {
  const hit = movementOptions({ catalog: CATALOG, order: [], query: 'squat' });
  assert.equal(hit.create, null);
  assert.equal(hit.empty, null);
});

test('a movement the session already holds is named as such, and is never offered as a new one', () => {
  const catalog = [...CATALOG, { id: 'ex_31ab', name: 'Zercher Squat', custom: true }];
  const options = movementOptions({ catalog, order: ['ex_31ab'], query: 'Zercher Squat' });
  assert.deepEqual(options, {
    matches: [], empty: 'That movement is already in this session.', create: null,
  });
  assert.equal(movementOptions({ catalog, order: ['ex_31ab'], query: '  zercher ' }).create, null);
  assert.equal(
    movementOptions({ catalog, order: ['ex_31ab'], query: 'Pendlay Row' }).create,
    'Create “Pendlay Row”',
  );
  assert.equal(movementOptions({ catalog, order: ['ex_31ab'], query: 'Pendlay Row' }).empty, 'No movement by that name.');
});

const AT = new Date(2026, 7, 8, 18, 30).getTime();
const THREE_DAYS_LATER = new Date(2026, 7, 11, 9, 15).getTime();

test('a movement with history reads its last set and the day it was, never its heaviest', () => {
  const last = { exerciseId: 'bench-press', weightKg: 82.5, reps: 5, at: AT };
  assert.equal(lastSetLabel(last, THREE_DAYS_LATER), 'last 82.5 × 5 · 3 days ago');
  assert.equal(lastSetLabel(last, new Date(2026, 7, 8, 23, 59).getTime()), 'last 82.5 × 5 · today');
  assert.equal(lastSetLabel(last, new Date(2026, 7, 9, 6, 0).getTime()), 'last 82.5 × 5 · yesterday');
});

test('a movement with no entry says it has no last time, and never that it was never logged', () => {
  assert.equal(NO_LAST_TIME_META, 'no last time');
  assert.equal(lastSetLabel(undefined, THREE_DAYS_LATER), NO_LAST_TIME_META);
  assert.equal(lastSetLabel(null, THREE_DAYS_LATER), NO_LAST_TIME_META);
  assert.equal(/never/i.test(NO_LAST_TIME_META), false);
  assert.equal(
    lastSetLabel({ exerciseId: 'chin-up', weightKg: 0, reps: 8, at: AT }, THREE_DAYS_LATER),
    'last bodyweight × 8 · 3 days ago',
  );
  assert.equal(
    lastSetLabel({ exerciseId: 'chin-up', weightKg: -20, reps: 10, at: AT }, THREE_DAYS_LATER),
    'last −20 × 10 · 3 days ago',
  );
});

test('the last sets are an index by movement, and a movement outside it has no line', () => {
  const index = lastSetsById([
    { exerciseId: 'back-squat', weightKg: 100, reps: 5, at: AT },
    { exerciseId: 'bench-press', weightKg: 82.5, reps: 5, at: AT },
  ]);
  assert.equal(index.size, 2);
  assert.deepEqual(index.get('back-squat'), { exerciseId: 'back-squat', weightKg: 100, reps: 5, at: AT });
  assert.equal(index.get('deadlift'), undefined);
  assert.equal(lastSetLabel(index.get('deadlift'), THREE_DAYS_LATER), NO_LAST_TIME_META);
  assert.equal(lastSetLabel(index.get('back-squat'), THREE_DAYS_LATER), 'last 100 × 5 · 3 days ago');

  const nothing = lastSetsById([]);
  assert.equal(nothing.size, 0);
  assert.equal(lastSetLabel(nothing.get('back-squat'), THREE_DAYS_LATER), NO_LAST_TIME_META);
});
