import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREATED_PATTERN, DEFAULT_EQUIPMENT, EQUIPMENT_CHOICES, FEATURED_HEAD, lastSetLabel, lastSetsById,
  mostTrained, movementOptions, NO_LAST_TIME_META, PICKER_FEATURED, PICKER_MATCHES, PICKER_OPENERS,
  trainedCounts, TRAINED_WINDOW,
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
  // An empty query opens on the six, so a lone opener is drawn there rather than in the browse.
  assert.equal(movementOptions({ catalog, query: '' }).featured[0].alias, null);
  assert.deepEqual(movementOptions({ catalog, query: '' }).matches, []);
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

test('an empty query offers the WHOLE catalogue — the cap is a typed query’s, never a browse’s', () => {
  assert.equal(PICKER_MATCHES, 7);
  // The six head the browse and the rest of the catalogue follows them: nothing is in both lists,
  // and between them they are the whole of what is available.
  const all = movementOptions({ catalog: CATALOG, order: [], query: '' });
  assert.deepEqual([...all.featured, ...all.matches].map((each) => each.id).sort(), CATALOG.map((each) => each.id).sort());
  assert.deepEqual(all.matches.map((each) => each.id), ['front-squat', 'romanian-deadlift', 'face-pull']);
  assert.equal(all.empty, null);

  const some = movementOptions({ catalog: CATALOG, order: ['back-squat', 'chin-up'], query: '' });
  assert.deepEqual([...some.featured, ...some.matches].map((each) => each.id), [
    'bench-press', 'overhead-press', 'barbell-row', 'front-squat', 'romanian-deadlift', 'face-pull',
  ]);
  assert.equal(some.matches.map((each) => each.id).includes('back-squat'), false, 'what is taken is not offered');
  assert.equal(some.empty, null);

  // A typed query is still seven rows and no more.
  const many = Array.from({ length: 10 }, (each, index) => ({ id: `row-${index}`, name: `Row ${index}` }));
  const typed = movementOptions({ catalog: many, order: [], query: 'row' });
  assert.equal(typed.matches.length, PICKER_MATCHES);
  assert.deepEqual(movementOptions({ catalog: many, order: [], query: '' }).matches.length, 10);
});

const SESSIONS = [
  { exercises: ['Back Squat', 'Bench Press', 'Chin-up'] },
  { exercises: ['Back Squat', 'Barbell Row'] },
  { exercises: ['Bench Press', 'Overhead Press'] },
  { exercises: ['Back Squat'] },
];

test('the six are counted off the log this page holds, and an untrained log is offered none', () => {
  assert.equal(PICKER_FEATURED, 6);
  // The bytes both phones draw over their own six. It names the shortcut and asserts no ranking.
  assert.equal(FEATURED_HEAD, 'The six');
  assert.deepEqual([...trainedCounts(SESSIONS).entries()], [
    ['Back Squat', 3], ['Bench Press', 2], ['Chin-up', 1], ['Barbell Row', 1], ['Overhead Press', 1],
  ]);
  // Ties fall back to the catalogue's own order, so the list is stable between reads.
  assert.deepEqual(mostTrained(CATALOG, SESSIONS).map((each) => each.id), [
    'back-squat', 'bench-press', 'chin-up', 'overhead-press', 'barbell-row',
  ]);
  // An account with no log yet is offered the same opener both phones offer, in their order — the
  // section is always six, so the head that names it is true.
  assert.deepEqual(mostTrained(CATALOG, []).map((each) => each.id), [
    'back-squat', 'bench-press', 'overhead-press', 'barbell-row', 'chin-up',
  ], 'every opener the catalogue holds — deadlift is not in this one');
  assert.deepEqual(PICKER_OPENERS, [
    'back-squat', 'bench-press', 'deadlift', 'overhead-press', 'barbell-row', 'chin-up',
  ]);
  // A log that names fewer than six is topped up from the openers, ranked first, never twice.
  const thin = mostTrained(CATALOG, [{ exercises: ['Face Pull'] }]).map((each) => each.id);
  assert.deepEqual(thin, ['face-pull', 'back-squat', 'bench-press', 'overhead-press', 'barbell-row', 'chin-up']);
  assert.equal(new Set(thin).size, thin.length);
  assert.deepEqual(mostTrained(CATALOG, SESSIONS, 2).map((each) => each.id), ['back-squat', 'bench-press']);

  const opened = movementOptions({ catalog: CATALOG, order: [], query: '', sessions: SESSIONS });
  assert.deepEqual(opened.featured.map((each) => each.id), [
    'back-squat', 'bench-press', 'chin-up', 'overhead-press', 'barbell-row',
  ]);
  // The six are a shortcut, not a replacement: everything else follows them, and nothing is twice.
  assert.deepEqual(opened.matches.map((each) => each.id), ['front-squat', 'romanian-deadlift', 'face-pull']);

  const typed = movementOptions({ catalog: CATALOG, order: [], query: 'squat', sessions: SESSIONS });
  assert.deepEqual(typed.featured, [], 'a typed query filters the whole catalogue and features nothing');
  assert.deepEqual(typed.matches.map((each) => each.id), ['back-squat', 'front-squat']);
});

test('the six are counted over a fixed depth, so walking the log deeper never reshuffles them', () => {
  assert.equal(TRAINED_WINDOW, 50);
  // What the room boots with: fifty sessions, all naming the same two movements.
  const page = Array.from({ length: TRAINED_WINDOW }, () => ({ exercises: ['Back Squat', 'Bench Press'] }));
  // What `loadOlder` appends when the lifter taps Older on the Log tab — deeper history, other movements.
  const older = Array.from({ length: TRAINED_WINDOW }, () => ({
    exercises: ['Chin-up', 'Overhead Press', 'Barbell Row', 'Front Squat', 'Face Pull'],
  }));
  const opening = mostTrained(CATALOG, page).map((each) => each.id);
  // The two the newest fifty name, then the openers — never what only the deeper pages hold.
  assert.deepEqual(opening, ['back-squat', 'bench-press', 'overhead-press', 'barbell-row', 'chin-up']);
  assert.deepEqual(mostTrained(CATALOG, [...page, ...older]).map((each) => each.id), opening,
    'the same account, the same visit: the six do not depend on where else the room has been');
  assert.equal(trainedCounts([...page, ...older]).get('Chin-up'), undefined);
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
    featured: [], matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.', create: null,
  });
  assert.deepEqual(movementOptions({ catalog: [], order: [], query: 'z' }), {
    featured: [], matches: [], empty: 'The catalog didn’t load. It comes back when you have signal.', create: null,
  });
  const loaded = movementOptions({ catalog: CATALOG, order: [], query: 'z' });
  assert.equal(loaded.empty, 'No movement by that name.');
});

test('a catalog entirely in the session says so, and never blames the network', () => {
  const order = CATALOG.map((each) => each.id);
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: '' }), {
    featured: [], matches: [], empty: 'Every movement in the catalog is already in this session.', create: null,
  });
  assert.deepEqual(movementOptions({ catalog: CATALOG, order, query: 'squat' }), {
    featured: [], matches: [], empty: 'Every movement in the catalog is already in this session.', create: null,
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
    featured: [], matches: [], empty: 'That movement is already in this session.', create: null,
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
