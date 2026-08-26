import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blankRoutine, builtLabel, CLEAR_REPS_AND_WEIGHT, DECIMAL_NOTE, draftFrom, duplicateRoutine,
  ENTRY_REPS_MAX, ENTRY_REPS_MIN, ENTRY_SETS_MAX, ENTRY_SETS_MIN, entryPlaceLabel, historyRows,
  isOpenEntry, LAST_TIME_PLACEHOLDER, MAX_PLACEHOLDER, NAME_SETS_FIRST, ONE_DECIMAL,
  OPEN_LINE, OPEN_PLACEHOLDER, NOT_A_NUMBER, OVER_MAX_LOAD, refusalOf, reorderEntries, REPS_BAND,
  routineFromSession, routineWrite, saysNeverLogged, SETS_BAND, targetEntryOf,
  targetFieldsOf, targetRefusal, withEntryAdded, withEntryRemoved, withEntrySet, withField,
  ZERO_TARGET,
} from '../../../src/products/gym/routines.js';
import { entryLabel, NAME_MAX } from '../../../src/products/gym/log.js';

const AT = 1_900_000_000_000;

function set(exerciseId, weightKg, reps, minute, kind = 'working') {
  return {
    id: `set_${exerciseId}_${minute}`,
    exerciseId,
    weightKg,
    reps,
    kind,
    setNumber: null,
    completedAt: AT + minute * 60_000,
  };
}

test('routineFromSession — the session becomes the routine, in the order it was performed', () => {
  const sets = [
    set('back-squat', 60, 5, 1, 'warmup'),
    set('back-squat', 100, 5, 5),
    set('back-squat', 100, 5, 9),
    set('back-squat', 100, 5, 13),
    set('romanian-deadlift', 80, 8, 20),
    set('romanian-deadlift', 80, 8, 24),
    set('romanian-deadlift', 80, 7, 28),
  ];
  assert.deepEqual(routineFromSession({ id: 'rt_1', name: 'Legs', sets }), {
    id: 'rt_1',
    name: 'Legs',
    position: 0,
    entries: [
      { exerciseId: 'back-squat', targetSets: 3, targetReps: 5, targetWeightKg: 100 },
      { exerciseId: 'romanian-deadlift', targetSets: 3, targetReps: 8, targetWeightKg: 80 },
    ],
  });
});

test('routineFromSession — the three other kinds count toward nothing, and can cost a movement', () => {
  const sets = [
    set('bench-press', 82.5, 5, 3),
    set('bench-press', 82.5, 5, 7),
    set('bench-press', 60, 12, 11, 'drop'),
    set('bench-press', 82.5, 2, 15, 'failure'),
    set('cable-fly', 20, 12, 20, 'warmup'),
  ];
  assert.deepEqual(routineFromSession({ id: 'rt_2', name: 'Push A', position: 2, sets }), {
    id: 'rt_2',
    name: 'Push A',
    position: 2,
    entries: [{ exerciseId: 'bench-press', targetSets: 2, targetReps: 5, targetWeightKg: 82.5 }],
  });
});

test('routineFromSession — modal reps, ties to the earliest, and the heaviest load of the day', () => {
  const sets = [
    set('overhead-press', 45, 8, 2),
    set('overhead-press', 47.5, 8, 6),
    set('overhead-press', 45, 6, 10),
    set('overhead-press', 40, 6, 14),
  ];
  assert.deepEqual(routineFromSession({ id: 'rt_3', name: 'Push B', sets }).entries, [
    { exerciseId: 'overhead-press', targetSets: 4, targetReps: 8, targetWeightKg: 47.5 },
  ]);

  const clear = [set('chin-up', 0, 9, 2), set('chin-up', 0, 7, 6), set('chin-up', 0, 7, 10)];
  assert.deepEqual(routineFromSession({ id: 'rt_4', name: 'Pull A', sets: clear }).entries, [
    { exerciseId: 'chin-up', targetSets: 3, targetReps: 7, targetWeightKg: 0 },
  ]);
});

test('routineWrite — carries the read revision only when the caller names it', () => {
  const stored = { id: 'rt_push_a', name: 'Push A', position: 0, revision: 4, entries: [] };
  assert.deepEqual(routineWrite(stored, 4), { id: 'rt_push_a', name: 'Push A', position: 0, entries: [], revision: 4 });
  assert.deepEqual(routineWrite(stored), { id: 'rt_push_a', name: 'Push A', position: 0, entries: [] });
});

test('routineWrite — entry positions and lastTrainedAt do not travel back', () => {
  const stored = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    lastTrainedAt: 1_754_300_000_000,
    entries: [
      { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 },
      { position: 2, exerciseId: 'chin-up', targetSets: 3 },
    ],
  };
  assert.deepEqual(routineWrite(stored), {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 },
      { exerciseId: 'chin-up', targetSets: 3 },
    ],
  });
});

test('routineWrite — an absent target is omitted, never sent as null and never as zero', () => {
  const write = routineWrite({
    id: 'rt_1',
    name: 'Pull A',
    position: 1,
    entries: [{ position: 1, exerciseId: 'chin-up', targetSets: 3, targetReps: null, targetWeightKg: null, restSeconds: null }],
  });
  assert.deepEqual(Object.keys(write.entries[0]), ['exerciseId', 'targetSets']);
});

test('duplicateRoutine — a new id over the same entries, and a copy has never been trained', () => {
  const stored = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    lastTrainedAt: 1_754_300_000_000,
    entries: [{ position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }],
  };
  assert.deepEqual(duplicateRoutine(stored, { id: 'rt_push_b', position: 3 }), {
    id: 'rt_push_b',
    name: 'Push A copy',
    position: 3,
    entries: [{ exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }],
  });
  assert.deepEqual(duplicateRoutine(stored, { id: 'rt_push_b', name: 'Push B' }), {
    id: 'rt_push_b',
    name: 'Push B',
    position: 0,
    entries: [{ exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }],
  });
});

test('duplicateRoutine — the default name fits the store, and the suffix is what survives', () => {
  const long = 'P'.repeat(NAME_MAX);
  const copy = duplicateRoutine({ id: 'rt_1', name: long, position: 0, entries: [] }, { id: 'rt_2' });
  assert.equal(copy.name, `${'P'.repeat(NAME_MAX - 5)} copy`);
  assert.equal(copy.name.length, NAME_MAX);

  const typed = duplicateRoutine({ id: 'rt_1', name: 'Push A', position: 0, entries: [] }, { id: 'rt_2', name: 'Q'.repeat(NAME_MAX + 20) });
  assert.equal(typed.name.length, NAME_MAX);
});

test('reorderEntries — the order moves and the numbering is rewritten from it', () => {
  const entries = [
    { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5 },
    { position: 2, exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
    { position: 3, exerciseId: 'overhead-press', targetSets: 3, targetReps: 8 },
  ];
  assert.deepEqual(reorderEntries(entries, 2, 0), [
    { position: 1, exerciseId: 'overhead-press', targetSets: 3, targetReps: 8 },
    { position: 2, exerciseId: 'bench-press', targetSets: 5, targetReps: 5 },
    { position: 3, exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
  ]);
  assert.deepEqual(reorderEntries(entries, 0, 1).map((entry) => [entry.position, entry.exerciseId]), [
    [1, 'chin-up'],
    [2, 'bench-press'],
    [3, 'overhead-press'],
  ]);
  assert.deepEqual(entries.map((entry) => entry.exerciseId), ['bench-press', 'chin-up', 'overhead-press']);
});

test('reorderEntries — a drag that lands past the end still lands, and an empty list survives it', () => {
  const entries = [
    { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5 },
    { position: 2, exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
  ];
  assert.deepEqual(reorderEntries(entries, 0, 9).map((entry) => [entry.position, entry.exerciseId]), [
    [1, 'chin-up'],
    [2, 'bench-press'],
  ]);
  assert.deepEqual(reorderEntries(entries, -3, 1).map((entry) => [entry.position, entry.exerciseId]), [
    [1, 'chin-up'],
    [2, 'bench-press'],
  ]);
  assert.deepEqual(reorderEntries([], 0, 1), []);
});

test('draftFrom — the draft is a whole routine, and editing it leaves the original alone', () => {
  const routine = {
    id: 'rt_9f2c', name: 'Push A', position: 0, lastTrainedAt: AT,
    entries: [
      { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 },
      { position: 2, exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
    ],
  };
  const draft = draftFrom(routine);
  assert.deepEqual(draft, routine);
  assert.notEqual(draft.entries[0], routine.entries[0]);

  draft.name = 'Push A (heavy)';
  draft.entries = withEntryAdded(draft.entries, 'barbell-row');
  draft.entries[0].targetWeightKg = 90;
  assert.deepEqual(draft.entries[2], { exerciseId: 'barbell-row' });
  assert.equal(routine.name, 'Push A');
  assert.equal(routine.entries.length, 2);
  assert.equal(routine.entries[0].targetWeightKg, 82.5);

  assert.deepEqual(routineWrite(draft), {
    id: 'rt_9f2c',
    name: 'Push A (heavy)',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 90 },
      { exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
      { exerciseId: 'barbell-row' },
    ],
  });
});

test('withEntrySet — the sheet hands back a whole row, and the row it replaces keeps nothing', () => {
  const entries = [
    { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 },
    { exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
  ];
  const changed = withEntrySet(entries, 0, { exerciseId: 'bench-press', targetSets: 6, targetReps: 5 });
  assert.deepEqual(changed[0], { exerciseId: 'bench-press', targetSets: 6, targetReps: 5 });
  assert.equal(changed[0].targetWeightKg, undefined, 'a weight the new row does not name is gone');
  assert.equal(changed[1], entries[1]);
  assert.equal(entries[0].targetSets, 5);

  // The open row: every target goes together, because the store refuses a line asking for reps of nothing.
  const opened = withEntrySet(entries, 1, { exerciseId: 'chin-up', restSeconds: 120 });
  assert.deepEqual(opened[1], { exerciseId: 'chin-up', restSeconds: 120 });
  const write = routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: opened });
  assert.deepEqual(write.entries[1], { exerciseId: 'chin-up', restSeconds: 120 });
  assert.deepEqual(Object.keys(write.entries[1]), ['exerciseId', 'restSeconds']);
  assert.deepEqual(withEntrySet(entries, 9, { exerciseId: 'nothing' }), entries);
});

test('the three typed fields open on the row, and an empty one is the null it stands for', () => {
  // An open row opens EMPTY: the sheet asserts no target the row does not hold, and the placeholders
  // are read on the row that is open rather than behind numbers nobody typed.
  assert.deepEqual(targetFieldsOf({ exerciseId: 'deadlift', restSeconds: 120 }), {
    sets: '', reps: '', weight: '', clearRefused: false,
  });
  assert.deepEqual(targetFieldsOf({ exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 }), {
    sets: '5', reps: '3', weight: '110', clearRefused: false,
  });
  assert.deepEqual(targetFieldsOf({ exerciseId: 'chin-up', targetSets: 3, targetReps: null, targetWeightKg: -20 }), {
    sets: '3', reps: '', weight: '-20', clearRefused: false,
  });
  assert.deepEqual([OPEN_PLACEHOLDER, MAX_PLACEHOLDER, LAST_TIME_PLACEHOLDER], ['open', 'max', 'last time']);
  assert.equal(DECIMAL_NOTE, 'comma or point, both read as a decimal');
});

test('the six refusals are the pinned strings, and the reps band is the routine target’s 1–100', () => {
  assert.equal(refusalOf('weight', '72,5'), null, 'a comma reads as a decimal');
  assert.equal(refusalOf('weight', '72.5'), null);
  assert.equal(refusalOf('weight', '72,5.5'), ONE_DECIMAL);
  assert.equal(refusalOf('weight', '7,2,5'), ONE_DECIMAL);
  assert.equal(refusalOf('weight', 'ninety'), NOT_A_NUMBER);
  assert.equal(refusalOf('weight', '-'), NOT_A_NUMBER);
  assert.equal(refusalOf('weight', '501'), OVER_MAX_LOAD);
  assert.equal(refusalOf('weight', '-501'), OVER_MAX_LOAD, 'band-assisted is a load like any other');
  assert.equal(refusalOf('weight', '-20'), null);
  assert.equal(refusalOf('weight', '500'), null);
  assert.equal(refusalOf('weight', '0'), ZERO_TARGET);

  assert.equal(refusalOf('reps', '1'), null);
  assert.equal(refusalOf('reps', '100'), null);
  assert.equal(refusalOf('reps', '101'), REPS_BAND);
  assert.equal(refusalOf('reps', '5.5'), REPS_BAND);
  assert.equal(refusalOf('reps', '0'), ZERO_TARGET);
  assert.equal(refusalOf('sets', '20'), null);
  assert.equal(refusalOf('sets', '21'), SETS_BAND);
  assert.equal(refusalOf('sets', '0'), ZERO_TARGET);
  for (const field of ['sets', 'reps', 'weight']) assert.equal(refusalOf(field, '  '), null);

  assert.deepEqual(
    [ONE_DECIMAL, NOT_A_NUMBER, OVER_MAX_LOAD, REPS_BAND, SETS_BAND, ZERO_TARGET],
    ['One decimal point only.', 'That is not a number yet.', 'Over 500 kg — check the number.',
      'Whole reps, 1 to 100.', 'Sets, 1 to 20.', 'A zero target is no target — clear the field instead.'],
  );
});

test('one refusal at a time, topmost first, and the clear of sets is refused rather than cascaded', () => {
  const full = { sets: '3', reps: '5', weight: '82.5', clearRefused: false };
  assert.equal(targetRefusal(full), null);
  assert.deepEqual(targetRefusal({ ...full, reps: '101', weight: '600' }), { field: 'reps', message: REPS_BAND });
  assert.deepEqual(targetRefusal({ ...full, weight: '600' }), { field: 'weight', message: OVER_MAX_LOAD });

  // The keystroke never lands: the field keeps its value and the sentence says what to clear first.
  const refused = withField(full, 'sets', '');
  assert.equal(refused.sets, '3');
  assert.equal(refused.clearRefused, true);
  assert.deepEqual(targetRefusal(refused), { field: 'sets', message: CLEAR_REPS_AND_WEIGHT });
  assert.equal(CLEAR_REPS_AND_WEIGHT, 'Clear reps and weight first — an open line names neither.');

  // The other way into the same illegal shape is the OPPOSITE act — a number typed onto a line whose
  // sets are already empty — so it takes the opposite sentence. The keystroke lands, the commit is
  // refused, and the way out named is the one the lifter wants: name the sets they just asked to fill.
  const openThenTyped = withField({ sets: '', reps: '', weight: '', clearRefused: false }, 'reps', '5');
  assert.equal(openThenTyped.reps, '5');
  assert.deepEqual(targetRefusal(openThenTyped), { field: 'sets', message: NAME_SETS_FIRST });
  assert.deepEqual(
    targetRefusal(withField({ sets: '', reps: '', weight: '', clearRefused: false }, 'weight', '82.5')),
    { field: 'sets', message: NAME_SETS_FIRST },
  );
  assert.equal(NAME_SETS_FIRST, 'Name the sets first — an open line names neither.');
  assert.notEqual(NAME_SETS_FIRST, CLEAR_REPS_AND_WEIGHT);
  // Naming the sets is the way out, and taking it clears the refusal.
  assert.equal(targetRefusal(withField(openThenTyped, 'sets', '3')), null);

  // Any other keystroke settles it, and once the other two are empty the clear lands.
  assert.equal(withField(refused, 'sets', '4').clearRefused, false);
  const emptied = withField(withField(refused, 'reps', ''), 'weight', '');
  assert.equal(emptied.clearRefused, false);
  const open = withField(emptied, 'sets', '');
  assert.equal(open.sets, '');
  assert.equal(targetRefusal(open), null);
});

test('the row the sheet hands back: the open line when sets is empty, the clamps as the last guard', () => {
  const entry = { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 };
  assert.deepEqual(targetEntryOf(entry, { sets: '4', reps: '6', weight: '85,5', clearRefused: false }), {
    exerciseId: 'bench-press', targetSets: 4, targetReps: 6, targetWeightKg: 85.5, restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf(entry, { sets: '4', reps: '', weight: '', clearRefused: false }), {
    exerciseId: 'bench-press', targetSets: 4, targetReps: null, targetWeightKg: null, restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf(entry, { sets: '', reps: '', weight: '', clearRefused: false }), {
    exerciseId: 'bench-press', restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf({ exerciseId: 'chin-up' }, { sets: '', reps: '', weight: '', clearRefused: false }), {
    exerciseId: 'chin-up',
  });
  assert.equal(targetEntryOf(entry, { sets: '99', reps: '5', weight: '', clearRefused: false }).targetSets, ENTRY_SETS_MAX);
  assert.equal(targetEntryOf(entry, { sets: '1', reps: '900', weight: '', clearRefused: false }).targetReps, ENTRY_REPS_MAX);
  assert.equal(ENTRY_SETS_MIN, 1);
  assert.equal(ENTRY_REPS_MIN, 1);
});

test('routineFromSession — a session too big to ask for is clamped to what a routine may ask for', () => {
  const many = Array.from({ length: 25 }, (each, index) => set('chin-up', 0, 8, index));
  const composed = routineFromSession({ id: 'rt_1', name: 'Wednesday', sets: many });
  assert.deepEqual(composed.entries, [
    { exerciseId: 'chin-up', targetSets: ENTRY_SETS_MAX, targetReps: 8, targetWeightKg: 0 },
  ]);
  assert.equal(ENTRY_SETS_MAX, 20);
  assert.equal(ENTRY_REPS_MAX, 100);

  const marathon = routineFromSession({ id: 'rt_2', name: 'Thursday', sets: [set('chin-up', 0, 400, 1), set('chin-up', 0, 400, 2)] });
  assert.equal(marathon.entries[0].targetReps, ENTRY_REPS_MAX);
  assert.equal(marathon.entries[0].targetSets, 2);
});

test('blankRoutine, withEntryAdded and withEntryRemoved — the editor’s three membership changes', () => {
  assert.deepEqual(blankRoutine({ id: 'rt_new' }), { id: 'rt_new', name: '', position: 0, entries: [] });
  assert.deepEqual(blankRoutine({ id: 'rt_new', position: 3 }).position, 3);

  const one = withEntryAdded([], 'bench-press');
  assert.deepEqual(one, [{ exerciseId: 'bench-press' }]);
  // A movement joins open and nothing is invented for it: no target key at all, not a zero.
  assert.deepEqual(Object.keys(one[0]), ['exerciseId']);

  const two = withEntryAdded(one, 'chin-up');
  assert.deepEqual(two.map((entry) => entry.exerciseId), ['bench-press', 'chin-up']);
  assert.equal(one.length, 1);

  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Heavy Thursday', position: 0, entries: two }).entries, [
    { exerciseId: 'bench-press' },
    { exerciseId: 'chin-up' },
  ]);
  assert.equal(entryLabel(two[0]), 'open');

  assert.deepEqual(withEntryRemoved(two, 0).map((entry) => entry.exerciseId), ['chin-up']);
  assert.deepEqual(withEntryRemoved(two, 1).map((entry) => entry.exerciseId), ['bench-press']);
  assert.deepEqual(withEntryRemoved(two, 7), two);
  assert.equal(two.length, 2);

  const maxed = withEntrySet(two, 1, targetEntryOf(two[1], { sets: '3', reps: '', weight: '', clearRefused: false }));
  assert.deepEqual(maxed[1], { exerciseId: 'chin-up', targetSets: 3, targetReps: null, targetWeightKg: null });
  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: maxed }).entries[1], {
    exerciseId: 'chin-up', targetSets: 3,
  });
});

test('saysNeverLogged — an untested routine, and a row that has not been filled in', () => {
  const built = { id: 'rt_1', name: 'Heavy Thursday', lastTrainedAt: null };
  const kept = { id: 'rt_2', name: 'Push A', lastTrainedAt: null };
  const trained = { id: 'rt_3', name: 'Legs', lastTrainedAt: AT };

  assert.equal(saysNeverLogged(built, { exerciseId: 'deadlift' }), true);
  assert.equal(saysNeverLogged(kept, { exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 }), false);
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift' }), false);
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift', targetSets: 3, targetReps: 5 }), false);
  assert.equal(saysNeverLogged(blankRoutine({ id: 'rt_new' }), { exerciseId: 'deadlift' }), true);
});

test('the open row carries the one pinned sentence, and a row with a target carries none', () => {
  assert.equal(OPEN_LINE, 'You decide the numbers at the rack.');
  assert.equal(isOpenEntry({ exerciseId: 'barbell-row' }), true);
  assert.equal(isOpenEntry({ exerciseId: 'barbell-row', restSeconds: 120 }), true);
  assert.equal(isOpenEntry({ exerciseId: 'back-squat', targetSets: 5, targetReps: 3 }), false);
  assert.equal(isOpenEntry({ exerciseId: 'back-squat', targetSets: 5, targetReps: null }), false);
});

test('entryPlaceLabel — the position in the run, and the routine when it has a name', () => {
  assert.equal(entryPlaceLabel(1, 4, 'Heavy Thursday'), '2 of 4 · Heavy Thursday');
  assert.equal(entryPlaceLabel(0, 1, 'Legs'), '1 of 1 · Legs');
  assert.equal(entryPlaceLabel(1, 4, '   '), '2 of 4');
  assert.equal(entryPlaceLabel(1, 4, ''), '2 of 4');
});

test('builtLabel — the day the routine was written, and only a count the store sent', () => {
  const now = new Date(2026, 7, 12, 20, 0).getTime();          // Wed 12 Aug 2026
  const sunday = new Date(2026, 7, 9, 11, 0).getTime();        // Sun 9 Aug 2026
  const fortnight = new Date(2026, 6, 29, 11, 0).getTime();    // Wed 29 Jul 2026
  const built = (at, movements) => ({
    history: [{ kind: 'created', at, ...(movements == null ? {} : { movements }) }],
  });

  assert.equal(builtLabel(built(sunday, 4), now), 'built Sunday · 4 movements');
  assert.equal(builtLabel(built(sunday, 1), now), 'built Sunday · 1 movement');
  assert.equal(builtLabel(built(sunday), now), 'built Sunday');
  assert.equal(builtLabel(built(fortnight, 4), now), 'built 29 Jul · 4 movements');
  assert.equal(builtLabel({ history: [] }, now), null);
  assert.equal(builtLabel({}, now), null);
  assert.equal(builtLabel(null, now), null);
});

test('historyRows — the day it was written and every proposal since, each spelled once', () => {
  const proposal = {
    id: 'prop_1',
    routineId: 'rt_1',
    intent: 'update',
    state: 'pending',
    summary: '',
    changeCount: 3,
    createdAt: new Date(2026, 7, 10, 21, 14).getTime(),
    source: { door: 'mcp' },
  };
  const rows = historyRows({
    history: [
      { kind: 'proposal', at: proposal.createdAt, proposal },
      { kind: 'created', at: new Date(2026, 7, 9, 11, 0).getTime(), movements: 4 },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    key: 'prop_1',
    pending: true,
    href: '#/gym/proposals/prop_1',
    thread: null,
    line: '10 Aug · 3 changes from your connected agent · waiting for you',
  });
  assert.deepEqual(rows[1], {
    key: 'created-1',
    pending: false,
    href: null,
    line: '9 Aug · created by you · 4 movements',
  });

  const asked = historyRows({
    history: [{
      kind: 'proposal',
      at: proposal.createdAt,
      proposal: { ...proposal, source: { door: 'ask', thread: 'thr_0a1b2c3d4e5f6071' } },
    }],
  });
  assert.equal(asked[0].thread, 'thr_0a1b2c3d4e5f6071');
  const deleted = historyRows({
    history: [{ kind: 'proposal', at: proposal.createdAt, proposal: { ...proposal, source: { door: 'ask' } } }],
  });
  assert.equal(deleted[0].thread, null);
  assert.equal(deleted[0].line, '10 Aug · 3 changes from Coach · waiting for you');

  const byAgent = historyRows({
    history: [{ kind: 'created', at: new Date(2026, 7, 9, 11, 0).getTime(), by: 'ask', movements: 2 }],
  });
  assert.equal(byAgent[0].line, '9 Aug · created by Coach · 2 movements');
  assert.equal(byAgent[0].line.includes('by you'), false);
  assert.equal(
    historyRows({ history: [{ kind: 'created', at: new Date(2026, 7, 9, 11, 0).getTime(), by: 'mcp' }] })[0].line,
    '9 Aug · created by your connected agent',
  );

  assert.deepEqual(historyRows({ history: [] }), []);
  assert.deepEqual(historyRows({}), []);
  assert.deepEqual(historyRows(null), []);
});
