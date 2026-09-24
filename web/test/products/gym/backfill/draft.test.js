import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alreadySavedLine, collapses, discardedLine, draftFromRoutine, freeDraft, importOf, inTheLogLine, isOverLimit, isReady,
  movementLine, movementSkippedLine, savedLabel, saveLabel, SET_LIMIT_LINE, sourceCaption, steppedValue, targetLine,
  typedValue, valueLabel, withMovementAdded, withMovementAt, withMovementRemoved, withSetAdded, withSetRemoved,
  withValueSet,
} from '../../../../src/products/gym/backfill/draft.js';

const lifted = (sets, startedAt = 1_900_000_000_000) => ({
  exerciseId: 'x', session: { id: 'ses_old', startedAt }, sets: sets.map(([weightKg, reps]) => ({ weightKg, reps, kind: 'working' })),
});
const never = { exerciseId: 'x' };

const PUSH_A = {
  id: 'rt_push',
  name: 'Push A',
  entries: [
    { position: 0, exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }] },
    { position: 1, exerciseId: 'overhead-press', sets: [{ reps: 8 }, { reps: 8 }, { reps: 8 }] },
    { position: 2, exerciseId: 'chin-up', sets: [{ reps: 8, weightKg: 0 }, { reps: 7, weightKg: 0 }, { reps: 6, weightKg: 0 }] },
    { position: 3, exerciseId: 'back-squat', sets: [{ weightKg: 100 }, { weightKg: 100 }, { weightKg: 100 }] },
    { position: 4, exerciseId: 'face-pull' },
    { position: 5, exerciseId: 'barbell-row' },
    { position: 6, exerciseId: 'lunge', sets: [{ reps: 10 }] },
  ],
};

const PUSH_A_LAST = new Map([
  ['bench-press', lifted([[60, 8], [60, 8], [57.5, 8]])],
  ['overhead-press', lifted([[32.5, 8], [30, 7]])],
  ['chin-up', lifted([[0, 8], [0, 7]])],
  ['back-squat', lifted([[100, 5], [100, 4]])],
  ['face-pull', never],
  ['barbell-row', lifted([[70, 10], [70, 9]], 1_899_000_000_000)],
  ['lunge', never],
]);

const set = (key, weightKg, reps, touched = false) => ({ key, weightKg, reps, touched });

test('draftFromRoutine — each set takes its target, then last time’s Nth working set, then last time’s last', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  assert.deepEqual(draft, {
    routineId: 'rt_push',
    name: 'Push A',
    minted: 22,
    movements: [
      {
        key: 'm0',
        exerciseId: 'bench-press',
        target: PUSH_A.entries[0],
        lastTime: { at: 1_900_000_000_000, sets: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }, { weightKg: 57.5, reps: 8 }] },
        neverLifted: false,
        sets: [set('s1', 60, 8), set('s2', 60, 8), set('s3', 60, 8)],
      },
      {
        key: 'm4',
        exerciseId: 'overhead-press',
        target: PUSH_A.entries[1],
        lastTime: { at: 1_900_000_000_000, sets: [{ weightKg: 32.5, reps: 8 }, { weightKg: 30, reps: 7 }] },
        neverLifted: false,
        sets: [set('s5', 32.5, 8), set('s6', 30, 8), set('s7', 30, 8)],
      },
      {
        key: 'm8',
        exerciseId: 'chin-up',
        target: PUSH_A.entries[2],
        lastTime: { at: 1_900_000_000_000, sets: [{ weightKg: 0, reps: 8 }, { weightKg: 0, reps: 7 }] },
        neverLifted: false,
        sets: [set('s9', 0, 8), set('s10', 0, 7), set('s11', 0, 6)],
      },
      {
        key: 'm12',
        exerciseId: 'back-squat',
        target: PUSH_A.entries[3],
        lastTime: { at: 1_900_000_000_000, sets: [{ weightKg: 100, reps: 5 }, { weightKg: 100, reps: 4 }] },
        neverLifted: false,
        sets: [set('s13', 100, 5), set('s14', 100, 4), set('s15', 100, 4)],
      },
      { key: 'm16', exerciseId: 'face-pull', target: PUSH_A.entries[4], lastTime: null, neverLifted: true, sets: [] },
      {
        key: 'm17',
        exerciseId: 'barbell-row',
        target: PUSH_A.entries[5],
        lastTime: { at: 1_899_000_000_000, sets: [{ weightKg: 70, reps: 10 }, { weightKg: 70, reps: 9 }] },
        neverLifted: false,
        sets: [set('s18', 70, 10), set('s19', 70, 9)],
      },
      { key: 'm20', exerciseId: 'lunge', target: PUSH_A.entries[6], lastTime: null, neverLifted: true, sets: [set('s21', null, 10)] },
    ],
  });
  assert.equal(isReady(draft), false, 'the lunge’s load has nothing to come from, so Save waits for it');
  assert.equal(saveLabel(draft), 'Save · 15 sets');
});

test('a last time that did not answer claims no history: the movement keeps its target, or opens empty', () => {
  const draft = draftFromRoutine(PUSH_A, new Map([['bench-press', null]]));
  assert.deepEqual(draft.movements.map((movement) => [movement.exerciseId, movement.neverLifted, movementLine(movement)]), [
    ['bench-press', false, '3 × 8 · 60'],
    ['overhead-press', false, '3 × 8'],
    ['chin-up', false, '3 × 6–8'],
    ['back-squat', false, '3 × – · 100'],
    ['face-pull', false, 'open'],
    ['barbell-row', false, 'open'],
    ['lunge', false, '1 × 10'],
  ]);
});

test('withMovementAdded — last time’s working sets, or one empty row when it was never lifted or not read', () => {
  const one = withMovementAdded(freeDraft(), 'back-squat', lifted([[100, 5], [100, 5]], 7));
  const two = withMovementAdded(one, 'lunge', never);
  const three = withMovementAdded(two, 'curl', null);
  assert.deepEqual(three, {
    routineId: null,
    name: null,
    minted: 7,
    movements: [
      {
        key: 'm0', exerciseId: 'back-squat', target: null, lastTime: { at: 7, sets: [{ weightKg: 100, reps: 5 }, { weightKg: 100, reps: 5 }] },
        neverLifted: false, sets: [set('s1', 100, 5), set('s2', 100, 5)],
      },
      { key: 'm3', exerciseId: 'lunge', target: null, lastTime: null, neverLifted: true, sets: [set('s4', null, null)] },
      { key: 'm5', exerciseId: 'curl', target: null, lastTime: null, neverLifted: false, sets: [set('s6', null, null)] },
    ],
  });
});

// One movement, written through the draft the form holds.
const carryDown = (movement, setKey, field, value) => {
  const written = withValueSet({ movements: [movement] }, movement.key, setKey, field, value);
  return { movement: written.draft.movements[0], carried: written.carried };
};

test('carryDown — an edit writes into every later set not yet touched, and says which sets it landed in', () => {
  const movement = { key: 'm0', exerciseId: 'bench-press', target: null, lastTime: null, neverLifted: false, sets: [set('a', 60, 8), set('b', 60, 8), set('c', 60, 8)] };
  const heavier = carryDown(movement, 'a', 'weightKg', 62.5);
  assert.deepEqual(heavier, {
    movement: { ...movement, sets: [set('a', 62.5, 8, true), set('b', 62.5, 8), set('c', 62.5, 8)] },
    carried: ['b', 'c'],
  });
  const lastShort = carryDown(heavier.movement, 'c', 'reps', 6);
  assert.deepEqual(lastShort.carried, []);
  const fewer = carryDown(lastShort.movement, 'a', 'reps', 7);
  assert.deepEqual(fewer, {
    movement: { ...movement, sets: [set('a', 62.5, 7, true), set('b', 62.5, 7), set('c', 62.5, 6, true)] },
    carried: ['b'],
  });
  assert.deepEqual(carryDown(fewer.movement, 'b', 'weightKg', 60).movement.sets, [
    set('a', 62.5, 7, true), set('b', 60, 7, true), set('c', 62.5, 6, true),
  ], 'nothing above the edit moves');
});

test('carryDown — confirming the number a set already holds chooses it, and carries nothing', () => {
  const movement = { key: 'm0', sets: [set('a', 60, 8), set('b', 60, 8), set('c', 60, 8)] };
  const confirmed = carryDown(movement, 'c', 'weightKg', 60);
  assert.deepEqual(confirmed, { movement: { ...movement, sets: [set('a', 60, 8), set('b', 60, 8), set('c', 60, 8, true)] }, carried: [] });
  const chin = { key: 'm1', sets: [set('a', 0, 8), set('b', 0, 7), set('c', 0, 6)] };
  assert.deepEqual(carryDown(chin, 'a', 'reps', 8).movement.sets, [set('a', 0, 8, true), set('b', 0, 7), set('c', 0, 6)], 'tabbing through a number writes nothing below it');
  assert.deepEqual(carryDown(confirmed.movement, 'a', 'weightKg', 70).movement.sets, [set('a', 70, 8, true), set('b', 70, 8), set('c', 60, 8, true)]);
});

test('withValueSet — the carry reaches only the movement written into', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  const { draft: next, carried } = withValueSet(draft, 'm0', 's1', 'weightKg', 62.5);
  assert.deepEqual(carried, ['s2', 's3']);
  assert.deepEqual(next.movements[0].sets.map((each) => each.weightKg), [62.5, 62.5, 62.5]);
  assert.deepEqual(next.movements.slice(1), draft.movements.slice(1));
  assert.equal(draft.movements[0].sets[0].weightKg, 60, 'the draft it was handed is untouched');
});

test('collapses — agreeing sets fold into one line; disagreeing or unfilled sets stay open', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  assert.deepEqual(draft.movements.map(collapses), [true, false, false, false, false, false, false]);
  assert.equal(collapses({ sets: [set('a', 60, 8)] }), true, 'one set agrees with itself');
  assert.equal(collapses({ sets: [set('a', 60, 8), set('b', 60, null)] }), false);
  assert.equal(collapses({ sets: [set('a', 0, 8), set('b', 0, 8)] }), true);
});

test('movementLine — the log’s scheme in kilograms, bodyweight without a load, the open line, and a target emptied of its sets', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  assert.deepEqual(draft.movements.map(movementLine), [
    '3 × 8 · 60',
    '3 × 8 · 30–32.5',
    '3 × 6–8',
    '3 × 4–5 · 100',
    'open · no last time',
    '2 × 9–10 · 70',
    '1 × 10',
  ]);
  const emptied = ['s1', 's2', 's3'].reduce((held, key) => withSetRemoved(held, 'm0', key), draft);
  assert.equal(movementLine(emptied.movements[0]), '3 × 8 · 60', 'its target, not a claim that it is open');
  const openLifted = ['s18', 's19'].reduce((held, key) => withSetRemoved(held, 'm17', key), draft);
  assert.equal(movementLine(openLifted.movements[5]), 'open');
  assert.equal(movementLine({ neverLifted: false, sets: [set('a', null, null), set('b', null, null)] }), '2 × –');
});

test('targetLine — the routine’s own scheme, its nulls read as the target sheet reads them', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  assert.deepEqual(draft.movements.map(targetLine), ['3 × 8 · 60', '3 × 8', '3 × 6–8', '3 × max · 100', 'open', 'open', '1 × 10']);
});

test('sets come and go by key — Add set copies the row above, a set leaves by its own key, a movement leaves and comes back', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  const edited = withValueSet(draft, 'm8', 's11', 'reps', 5).draft;
  const added = withSetAdded(edited, 'm8');
  assert.deepEqual(added.movements[2].sets, [set('s9', 0, 8), set('s10', 0, 7), set('s11', 0, 5, true), set('s22', 0, 5)]);
  assert.equal(added.minted, 23);
  assert.deepEqual(withSetAdded(draft, 'm16').movements[4].sets, [set('s22', null, null)]);
  // Two removals in a row each take the set they name, whatever the first did to the positions.
  const twice = withSetRemoved(withSetRemoved(draft, 'm8', 's9'), 'm8', 's10');
  assert.deepEqual(twice.movements[2].sets, [set('s11', 0, 6)]);

  const skipped = withMovementRemoved(draft, 'm4');
  assert.deepEqual(skipped.movements.map((movement) => movement.key), ['m0', 'm8', 'm12', 'm16', 'm17', 'm20']);
  assert.deepEqual(withMovementAt(skipped, 1, draft.movements[1]), draft);
  assert.deepEqual(withMovementAt(skipped, 40, draft.movements[1]).movements.map((movement) => movement.key), ['m0', 'm8', 'm12', 'm16', 'm17', 'm20', 'm4']);
});

test('Save counts the sets that will land, is ready only when every value is filled and the store’s bound holds', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  assert.equal(saveLabel(freeDraft()), 'Save');
  assert.equal(isReady(freeDraft()), false);
  assert.equal(saveLabel(draft), 'Save · 15 sets');
  const typed = withValueSet(draft, 'm20', 's21', 'weightKg', 0).draft;
  assert.equal(isReady(typed), true);
  assert.equal(savedLabel(typed), 'Saved · 15 sets');
  const one = withMovementAdded(freeDraft(), 'back-squat', lifted([[100, 5]]));
  assert.equal(saveLabel(one), 'Save · 1 set');
  assert.equal(isReady(withMovementAdded(one, 'lunge', never)), false);

  const big = draftFromRoutine({
    id: 'rt_big', name: 'Big', entries: Array.from({ length: 41 }, (_, at) => ({ exerciseId: `e${at}`, sets: Array.from({ length: 5 }, () => ({ reps: 5, weightKg: 20 })) })),
  }, new Map());
  assert.deepEqual([saveLabel(big), isOverLimit(big), isReady(big)], ['Save · 205 sets', true, false]);
  const fits = ['m0', 'm6', 'm12', 'm18', 'm24'].reduce((held, key) => withMovementRemoved(held, key), big);
  assert.deepEqual([saveLabel(fits), isOverLimit(fits), isReady(fits)], ['Save · 180 sets', false, true]);
  assert.equal(SET_LIMIT_LINE, 'A workout holds up to 200 sets.');
});

test('the side column’s caption says where the numbers came from, and the transients say what happened', () => {
  const draft = draftFromRoutine(PUSH_A, PUSH_A_LAST);
  const added = withMovementAdded(freeDraft(), 'back-squat', never).movements[0];
  assert.deepEqual([sourceCaption(draft.movements[0], false), sourceCaption(added, false), sourceCaption(added, true)], [
    'Filled from the target. A blank load or rep count takes last time’s set.',
    'A movement you add arrives with last time’s sets.',
    'An edit carries down to the sets below it you have not touched.',
  ]);
  assert.equal(movementSkippedLine('Overhead Press'), 'Overhead Press is out of this workout.');
  assert.equal(inTheLogLine('Push A'), 'Push A is in the log.');
  assert.equal(alreadySavedLine('Push A'), 'Push A was already in the log — the changes made after that save were not written.');
  assert.equal(discardedLine(), 'This workout was saved and then discarded, so this form can’t save it again. Open Add past workout to log it afresh.');
});

test('a number as the row draws it, as it is typed, and as ↑ and ↓ step it', () => {
  assert.deepEqual([valueLabel(0, 'load'), valueLabel(62.5, 'load'), valueLabel(-20, 'load'), valueLabel(null, 'load'), valueLabel(8, 'reps')], [
    'bodyweight', '62.5', '−20', '', '8',
  ]);
  assert.deepEqual(['62,5', '62.5', '', 'abc', '501', '-20', '1e1', '0x10', ' 60 '].map((text) => typedValue(text, 'load')), [
    62.5, 62.5, null, undefined, undefined, -20, undefined, undefined, 60,
  ]);
  assert.deepEqual(['8', '0', '8.5', '100', '', '0x10'].map((text) => typedValue(text, 'reps')), [8, undefined, undefined, undefined, null, undefined]);
  assert.deepEqual([
    steppedValue(60, 'load', 1, 2.5), steppedValue(60, 'load', -1, 5), steppedValue(null, 'load', 1, 2.5),
    steppedValue(0, 'load', -1, null), steppedValue(499, 'load', 1, 2.5),
  ], [62.5, 55, 2.5, -2.5, 500]);
  assert.deepEqual([steppedValue(8, 'reps', 1), steppedValue(1, 'reps', -1), steppedValue(null, 'reps', 1), steppedValue(99, 'reps', 1)], [9, 1, 1, 99]);
});

test('importOf — one request built from the form alone: the span, the routine, and set ids that are the session’s own', () => {
  const draft = withValueSet(draftFromRoutine({
    id: 'rt_legs',
    name: 'Legs',
    entries: [
      { position: 0, exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }] },
      { position: 1, exerciseId: 'chin-up', sets: [{ reps: 8 }] },
      { position: 2, exerciseId: 'face-pull' },
    ],
  }, new Map([['chin-up', lifted([[0, 8]])]])), 'm0', 's2', 'reps', 4).draft;
  const startedAt = 1_900_000_000_000;
  const slot = { startedAt, finishedAt: startedAt + 3_600_000 };
  const request = importOf({ id: 'ses_9f3a1c22b0e1d4f7', slot, draft });
  assert.deepEqual(request, {
    id: 'ses_9f3a1c22b0e1d4f7',
    startedAt,
    finishedAt: startedAt + 3_600_000,
    routineId: 'rt_legs',
    sets: [
      { id: 'set_9f3a1c22b0e1d4f7_1', exerciseId: 'back-squat', weightKg: 100, reps: 5, completedAt: startedAt + 900_000, kind: 'working' },
      { id: 'set_9f3a1c22b0e1d4f7_2', exerciseId: 'back-squat', weightKg: 100, reps: 4, completedAt: startedAt + 1_800_000, kind: 'working' },
      { id: 'set_9f3a1c22b0e1d4f7_3', exerciseId: 'chin-up', weightKg: 0, reps: 8, completedAt: startedAt + 2_700_000, kind: 'working' },
    ],
  });
  assert.equal(JSON.stringify(importOf({ id: 'ses_9f3a1c22b0e1d4f7', slot, draft })), JSON.stringify(request), 'the same form sends the same bytes');
});

test('importOf — a free session names no routine, and uneven spreads round to whole milliseconds inside the span', () => {
  const draft = withMovementAdded(freeDraft(), 'back-squat', lifted([[100, 5], [100, 5]]));
  const startedAt = 1_900_000_000_000;
  assert.deepEqual(importOf({ id: 'ses_0000000000000002', slot: { startedAt, finishedAt: startedAt + 45 * 60_000 }, draft }), {
    id: 'ses_0000000000000002',
    startedAt,
    finishedAt: startedAt + 2_700_000,
    sets: [
      { id: 'set_0000000000000002_1', exerciseId: 'back-squat', weightKg: 100, reps: 5, completedAt: startedAt + 900_000, kind: 'working' },
      { id: 'set_0000000000000002_2', exerciseId: 'back-squat', weightKg: 100, reps: 5, completedAt: startedAt + 1_800_000, kind: 'working' },
    ],
  });
  const spread = importOf({ id: 'ses_3', slot: { startedAt, finishedAt: startedAt + 1000 }, draft })
    .sets.map((each) => each.completedAt - startedAt);
  assert.deepEqual(spread, [333, 667]);
});
