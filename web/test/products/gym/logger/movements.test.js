// The picker's four silences, pinned apart. One sentence used to cover all of them, so a lifter
// who typed a letter the catalog does not hold was told the catalog had not loaded — the app
// reporting a failure that never happened, and pointing them at their signal to fix it. The fourth
// is the one with a WRITE behind it: a movement the catalog holds and this session already has is
// not a movement to mint a second copy of.

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

// A ROW IS NOT THE CATALOG ENTRY IT CAME FROM: it carries the name, whether this account minted the
// movement, and — only when the query found it that way — the old name it matched on.
test('a row carries what the picker draws, and the alias only when the match came through one', () => {
  const catalog = [{ id: 'back-squat', name: 'High-bar squat', aliases: ['Back Squat', 'squats'] }];
  assert.deepEqual(movementOptions({ catalog, query: 'high' }).matches, [
    { id: 'back-squat', name: 'High-bar squat', custom: false, alias: null },
  ]);
  assert.deepEqual(movementOptions({ catalog, query: 'back sq' }).matches, [
    { id: 'back-squat', name: 'High-bar squat', custom: false, alias: 'Back Squat' },
  ]);
  // An empty query matches everything by name, so no row claims to have been found by an alias.
  assert.equal(movementOptions({ catalog, query: '' }).matches[0].alias, null);
  // A query the NAME answers is answered by the name, whatever the aliases also contain: `squat` is
  // in `High-bar squat`, so the row explains nothing. Only a query the name cannot answer names one.
  assert.equal(movementOptions({ catalog, query: 'squat' }).matches[0].alias, null);
  assert.equal(movementOptions({ catalog, query: 'squats' }).matches[0].alias, 'squats');
  // A movement minted by this account says so, and one that was not says nothing rather than false
  // arriving as undefined.
  const mine = [{ id: 'ex_31ab', name: 'Hammer row', custom: true }];
  assert.deepEqual(movementOptions({ catalog: mine, query: 'ham' }).matches, [
    { id: 'ex_31ab', name: 'Hammer row', custom: true, alias: null },
  ]);
});

// AN OLD NAME KEEPS FINDING THE MOVEMENT (§N). Renaming is a label moving over a stable id, so the
// name a lifter has typed into this box for a year has to keep working — and the create door must
// not open over a movement the catalog already holds under a name it used to have, which would mint
// a second copy of the very movement they renamed.
test('a query matches the old name as readily as the new one, and offers no second copy', () => {
  const catalog = [{ id: 'back-squat', name: 'High-bar squat', aliases: ['Back Squat'] }];
  const hit = movementOptions({ catalog, order: [], query: 'Back Squat' });
  assert.deepEqual(hit.matches.map((each) => each.id), ['back-squat']);
  assert.equal(hit.create, null);
  assert.equal(hit.empty, null);
  // And the "already in this session" silence reads the aliases too, for the same reason: the row
  // is missing from the available list because it is in the session, not because it does not exist.
  const held = movementOptions({
    catalog: [...catalog, { id: 'dip', name: 'Dip' }], order: ['back-squat'], query: 'back squat',
  });
  assert.deepEqual(held.matches, []);
  assert.equal(held.empty, 'That movement is already in this session.');
  assert.equal(held.create, null);
  // A movement with no aliases at all is exactly the search it always was.
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

// CREATING ONE ASKS EXACTLY TWO THINGS (§N screen 31), so the third field the wire requires is
// chosen to claim as little as it can: `isolation` is the catch-all bucket and not a statement about
// what the movement trains. Equipment is no longer one of those guesses — it is asked, because it is
// what the ladder and the plate readout read, and every movement a lifter minted before this screen
// was stored as a barbell whatever it was.
//
// FOUR OFFERED OVER A SCHEMA THAT HOLDS SIX. `cable` and `kettlebell` stay valid on every read and
// seeded movements use them; a creation screen is not a taxonomy, and these are the four the board
// draws. Barbell opens selected, which is the modal answer and was the silent assumption before.
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

// THE META UNDER A ROW (§B7), and the one thing it must never invent. The read behind it is sparse:
// it carries an entry for every movement this account has a LAST TIME for and NOTHING for the rest,
// so the absence sentence is drawn from a movement being missing and from no other fact. A
// sentinel, a null row or a zero would each be the server saying something it deliberately does not
// say — and a zero is a load in this product, not an absence of one.
const AT = new Date(2026, 7, 8, 18, 30).getTime();
const THREE_DAYS_LATER = new Date(2026, 7, 11, 9, 15).getTime();

test('a movement with history reads its last set and the day it was, never its heaviest', () => {
  const last = { exerciseId: 'bench-press', weightKg: 82.5, reps: 5, at: AT };
  assert.equal(lastSetLabel(last, THREE_DAYS_LATER), 'last 82.5 × 5 · 3 days ago');
  assert.equal(lastSetLabel(last, new Date(2026, 7, 8, 23, 59).getTime()), 'last 82.5 × 5 · today');
  assert.equal(lastSetLabel(last, new Date(2026, 7, 9, 6, 0).getTime()), 'last 82.5 × 5 · yesterday');
});

// AND THE ABSENCE CLAIMS NO HISTORY. The read is the last-time read: the workout running right now
// is not a last time, and a warmup is not one either — so a movement missing from it may well have
// been logged, and on day one every movement the lifter has ever touched is missing while their
// first session is still open. `never logged` over that is a false sentence on a surface whose own
// Today screen is drawing those sets; the row says the exact negation of the line it replaces, and
// the word `never` appears in neither reading.
test('a movement with no entry says it has no last time, and never that it was never logged', () => {
  assert.equal(NO_LAST_TIME_META, 'no last time');
  assert.equal(lastSetLabel(undefined, THREE_DAYS_LATER), NO_LAST_TIME_META);
  assert.equal(lastSetLabel(null, THREE_DAYS_LATER), NO_LAST_TIME_META);
  assert.equal(/never/i.test(NO_LAST_TIME_META), false);
  // A movement that WAS logged at no load is not that: zero is a load here — the chin-up done at
  // bodyweight — and a band-assisted set is a real point below it.
  assert.equal(
    lastSetLabel({ exerciseId: 'chin-up', weightKg: 0, reps: 8, at: AT }, THREE_DAYS_LATER),
    'last bodyweight × 8 · 3 days ago',
  );
  assert.equal(
    lastSetLabel({ exerciseId: 'chin-up', weightKg: -20, reps: 10, at: AT }, THREE_DAYS_LATER),
    'last −20 × 10 · 3 days ago',
  );
});

// The reply is ordered by exercise id, which is a JOIN key order and not a draw order: the rows are
// drawn in the catalog's order and each one asks this index for its own line. A movement the index
// has never heard of answers nothing at all, which is exactly what the picker draws `no last time`
// from — so the two halves are one rule and there is no third state to get wrong.
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

  // A lifter with no finished block behind them gets an empty list rather than a list of nothings,
  // and every row on their picker says so.
  const nothing = lastSetsById([]);
  assert.equal(nothing.size, 0);
  assert.equal(lastSetLabel(nothing.get('back-squat'), THREE_DAYS_LATER), NO_LAST_TIME_META);
});
