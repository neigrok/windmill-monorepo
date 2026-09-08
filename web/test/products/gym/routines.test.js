import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADD_SET, blankRoutine, builtLabel, commitLabel, draftFrom,
  ENTRY_REPS_MAX, ENTRY_REPS_MIN, ENTRY_SETS_MAX, ENTRY_SETS_MIN, entryPlaceLabel, EVERY_SET, FILL, headOf,
  historyRows, isOpenEntry, LAST_TIME_PLACEHOLDER, MATCH_SET_ONE, MAX_PLACEHOLDER, ONE_DECIMAL,
  OPEN_LINE, OPEN_PLACEHOLDER, NOT_A_NUMBER, OVER_MAX_LOAD, RAMP_UP, rampDisabled, refusalOf, reorderEntries,
  REPS_BAND, routineFromSession, routineWrite, saysNeverLogged, SET_BY_SET, SETS_BAND, SHEET_CHROME,
  targetEntryOf, targetFieldsOf, targetRefusal, VARIES_PLACEHOLDER, withEntryAdded, withEntryRemoved,
  withEntrySet, withHead, withMatchedToFirst, withRampUp, withRow, withRowAdded, withRowRemoved, withSets,
  ladderOf,
  ZERO_TARGET,
} from '../../../src/products/gym/routines.js';
import { entryLabel, NAME_MAX } from '../../../src/products/gym/log.js';

// The fixtures every surface shares (briefs/17-set-targets.md).
const RAMP = [
  { reps: 5, weightKg: 60 }, { reps: 5, weightKg: 80 }, { reps: 3, weightKg: 90 },
  { reps: 1, weightKg: 100 }, { reps: 5, weightKg: 80 },
];
const RAMP_WIRE = '{"exerciseId":"back-squat","sets":[{"reps":5,"weightKg":60},{"reps":5,"weightKg":80},{"reps":3,"weightKg":90},{"reps":1,"weightKg":100},{"reps":5,"weightKg":80}],"restSeconds":180}';
const STRAIGHT = [{ reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }, { reps: 8, weightKg: 60 }];
const fields = (over = {}) => ({ sets: '', rows: [], addRefused: false, ...over });
const row = (reps, weight) => ({ reps, weight });

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
      { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }] },
      { exerciseId: 'romanian-deadlift', sets: [{ reps: 8, weightKg: 80 }, { reps: 8, weightKg: 80 }, { reps: 7, weightKg: 80 }] },
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
    entries: [{ exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }, { reps: 5, weightKg: 82.5 }] }],
  });
});

test('routineFromSession — every working set is its own slot, as lifted: no modal reps, no heaviest load', () => {
  const sets = [
    set('overhead-press', 45, 8, 2),
    set('overhead-press', 47.5, 8, 6),
    set('overhead-press', 45, 6, 10),
    set('overhead-press', 40, 6, 14),
  ];
  const composed = routineFromSession({ id: 'rt_3', name: 'Push B', sets }).entries;
  assert.deepEqual(composed, [{
    exerciseId: 'overhead-press',
    sets: [{ reps: 8, weightKg: 45 }, { reps: 8, weightKg: 47.5 }, { reps: 6, weightKg: 45 }, { reps: 6, weightKg: 40 }],
  }]);
  assert.equal(entryLabel(composed[0]), '4 × 6–8 · 40–47.5');

  // A bodyweight day keeps its zero: the load as lifted, never `last time`.
  const clear = [set('chin-up', 0, 9, 2), set('chin-up', 0, 7, 6), set('chin-up', 0, 7, 10)];
  const pull = routineFromSession({ id: 'rt_4', name: 'Pull A', sets: clear }).entries;
  assert.deepEqual(pull, [{ exerciseId: 'chin-up', sets: [{ reps: 9, weightKg: 0 }, { reps: 7, weightKg: 0 }, { reps: 7, weightKg: 0 }] }]);
  assert.equal(entryLabel(pull[0]), '3 × 7–9');

  // The ramp lifted as planned comes back as the ramp, key for key.
  const ramp = RAMP.map((slot, index) => set('back-squat', slot.weightKg, slot.reps, index + 1));
  const kept = routineFromSession({ id: 'rt_5', name: 'Lower A', sets: ramp });
  assert.deepEqual(kept.entries, [{ exerciseId: 'back-squat', sets: RAMP }]);
  assert.equal(JSON.stringify(routineWrite(kept).entries[0]), RAMP_WIRE.replace(',"restSeconds":180', ''));
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
      { position: 1, exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }], restSeconds: 180 },
      { position: 2, exerciseId: 'chin-up', sets: [{}, {}, {}] },
    ],
  };
  assert.deepEqual(routineWrite(stored), {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }], restSeconds: 180 },
      { exerciseId: 'chin-up', sets: [{}, {}, {}] },
    ],
  });
});

test('routineWrite — an absent target is omitted, never sent as null and never as zero', () => {
  const write = routineWrite({
    id: 'rt_1',
    name: 'Pull A',
    position: 1,
    entries: [{ position: 1, exerciseId: 'chin-up', sets: [{ reps: null, weightKg: null }, { reps: 8, weightKg: null }], restSeconds: null }],
  });
  assert.deepEqual(Object.keys(write.entries[0]), ['exerciseId', 'sets']);
  assert.deepEqual(write.entries[0].sets, [{}, { reps: 8 }]);
  assert.deepEqual(Object.keys(write.entries[0].sets[1]), ['reps']);
});

test('the ramp round-trips the sheet byte-exact, in the pinned key order', () => {
  const stored = { position: 1, exerciseId: 'back-squat', sets: RAMP, restSeconds: 180 };
  const held = targetEntryOf(stored, targetFieldsOf(stored));
  const write = routineWrite({ id: 'rt_lower_a', name: 'Lower A', position: 0, entries: [held] });
  assert.equal(JSON.stringify(write.entries[0]), RAMP_WIRE);
  assert.deepEqual(Object.keys(write.entries[0]), ['exerciseId', 'sets', 'restSeconds']);
  for (const each of write.entries[0].sets) assert.deepEqual(Object.keys(each), ['reps', 'weightKg']);
  // A set that names one side keeps that order too: reps before weightKg, absent keys gone.
  const partial = targetEntryOf({ exerciseId: 'dip' }, fields({ sets: '2', rows: [row('', '20'), row('8', '')] }));
  assert.equal(JSON.stringify(routineWrite({ id: 'rt_1', name: 'x', position: 0, entries: [partial] }).entries[0]),
    '{"exerciseId":"dip","sets":[{"weightKg":20},{"reps":8}]}');
});

test('reorderEntries — the order moves and the numbering is rewritten from it', () => {
  const entries = [
    { position: 1, exerciseId: 'bench-press', sets: [{ reps: 5 }] },
    { position: 2, exerciseId: 'chin-up', sets: [{ reps: 8 }] },
    { position: 3, exerciseId: 'overhead-press', sets: [{ reps: 8 }] },
  ];
  assert.deepEqual(reorderEntries(entries, 2, 0), [
    { position: 1, exerciseId: 'overhead-press', sets: [{ reps: 8 }] },
    { position: 2, exerciseId: 'bench-press', sets: [{ reps: 5 }] },
    { position: 3, exerciseId: 'chin-up', sets: [{ reps: 8 }] },
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
    { position: 1, exerciseId: 'bench-press', sets: [{ reps: 5 }] },
    { position: 2, exerciseId: 'chin-up', sets: [{ reps: 8 }] },
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
      { position: 1, exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }] },
      { position: 2, exerciseId: 'chin-up', sets: [{ reps: 8 }] },
    ],
  };
  const draft = draftFrom(routine);
  assert.deepEqual(draft, routine);
  assert.notEqual(draft.entries[0], routine.entries[0]);

  draft.name = 'Push A (heavy)';
  draft.entries = withEntryAdded(draft.entries, 'barbell-row');
  draft.entries[0].sets = [{ reps: 5, weightKg: 90 }];
  assert.deepEqual(draft.entries[2], { exerciseId: 'barbell-row' });
  assert.equal(routine.name, 'Push A');
  assert.equal(routine.entries.length, 2);
  assert.equal(routine.entries[0].sets[0].weightKg, 82.5);

  assert.deepEqual(routineWrite(draft), {
    id: 'rt_9f2c',
    name: 'Push A (heavy)',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 90 }] },
      { exerciseId: 'chin-up', sets: [{ reps: 8 }] },
      { exerciseId: 'barbell-row' },
    ],
  });
});

test('withEntrySet — the sheet hands back a whole row, and the row it replaces keeps nothing', () => {
  const entries = [
    { exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }] },
    { exerciseId: 'chin-up', sets: [{ reps: 8 }] },
  ];
  const changed = withEntrySet(entries, 0, { exerciseId: 'bench-press', sets: [{ reps: 5 }, { reps: 5 }] });
  assert.deepEqual(changed[0], { exerciseId: 'bench-press', sets: [{ reps: 5 }, { reps: 5 }] });
  assert.equal(changed[0].sets[0].weightKg, undefined, 'a weight the new row does not name is gone');
  assert.equal(changed[1], entries[1]);
  assert.equal(entries[0].sets.length, 1);

  // The open row: every target goes together, because the store refuses a line asking for reps of nothing.
  const opened = withEntrySet(entries, 1, { exerciseId: 'chin-up', restSeconds: 120 });
  assert.deepEqual(opened[1], { exerciseId: 'chin-up', restSeconds: 120 });
  const write = routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: opened });
  assert.deepEqual(write.entries[1], { exerciseId: 'chin-up', restSeconds: 120 });
  assert.deepEqual(Object.keys(write.entries[1]), ['exerciseId', 'restSeconds']);
  assert.deepEqual(withEntrySet(entries, 9, { exerciseId: 'nothing' }), entries);
});

test('the sheet opens on what the row holds — the count and one row per set — and invents nothing', () => {
  // An open row opens EMPTY: no count, no rows, and the placeholders read on the row they are true of.
  assert.deepEqual(targetFieldsOf({ exerciseId: 'deadlift', restSeconds: 120 }), fields());
  assert.deepEqual(targetFieldsOf({ exerciseId: 'back-squat', sets: [{ reps: 3, weightKg: 110 }] }), fields({
    sets: '1', rows: [row('3', '110')],
  }));
  assert.deepEqual(targetFieldsOf({ exerciseId: 'chin-up', sets: [{ weightKg: -20 }, { reps: 8 }, {}] }), fields({
    sets: '3', rows: [row('', '-20'), row('8', ''), row('', '')],
  }));
  assert.deepEqual(targetFieldsOf({ exerciseId: 'back-squat', sets: RAMP }), fields({
    sets: '5', rows: [row('5', '60'), row('5', '80'), row('3', '90'), row('1', '100'), row('5', '80')],
  }));
  assert.deepEqual([OPEN_PLACEHOLDER, MAX_PLACEHOLDER, LAST_TIME_PLACEHOLDER, VARIES_PLACEHOLDER], ['open', 'max', 'last time', 'varies']);
});

test('headOf — the head speaks for every row: the shared value, or `varies` where the rows disagree', () => {
  assert.deepEqual(headOf(targetFieldsOf({ exerciseId: 'back-squat', sets: RAMP })), {
    reps: { value: '', placeholder: 'varies' },
    weight: { value: '', placeholder: 'varies' },
  });
  assert.deepEqual(headOf(fields({ sets: '5', rows: Array.from({ length: 5 }, () => row('5', '80')) })), {
    reps: { value: '5', placeholder: 'max' },
    weight: { value: '80', placeholder: 'last time' },
  });
  // Blank rows agree on nothing named, so the placeholders are the columns' own words.
  assert.deepEqual(headOf(fields({ sets: '3', rows: [row('', ''), row('', ''), row('', '')] })), {
    reps: { value: '', placeholder: 'max' },
    weight: { value: '', placeholder: 'last time' },
  });
  assert.deepEqual(headOf(fields()), {
    reps: { value: '', placeholder: 'max' },
    weight: { value: '', placeholder: 'last time' },
  });
  // A column can agree while the other varies, and two spellings of one load agree.
  assert.deepEqual(headOf(fields({ sets: '2', rows: [row('5', '80'), row('5', '80,0')] })), {
    reps: { value: '5', placeholder: 'max' },
    weight: { value: '80', placeholder: 'last time' },
  });
  assert.deepEqual(headOf(fields({ sets: '2', rows: [row('5', '80'), row('3', '80')] })).reps, { value: '', placeholder: 'varies' });
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

test('one refusal at a time, topmost first, under the row that carries the fault', () => {
  const straight = fields({ sets: '3', rows: [row('5', '82.5'), row('5', '82.5'), row('5', '82.5')] });
  assert.equal(targetRefusal(straight), null);
  assert.deepEqual(targetRefusal(withSets(straight, '99')), { field: 'sets', row: null, message: SETS_BAND });
  // The count first, then the rows top to bottom, reps before weight inside a row.
  const wrong = withRow(withRow(straight, 1, 'weight', '600'), 2, 'reps', '101');
  assert.deepEqual(targetRefusal(wrong), { field: 'weight', row: 1, message: OVER_MAX_LOAD });
  assert.deepEqual(targetRefusal(withRow(wrong, 1, 'weight', '80')), { field: 'reps', row: 2, message: REPS_BAND });
  assert.deepEqual(targetRefusal(withRow(withRow(wrong, 0, 'reps', '0'), 0, 'weight', '5-')), { field: 'reps', row: 0, message: ZERO_TARGET });
  assert.deepEqual(targetRefusal(withRow(wrong, 0, 'weight', '5-')), { field: 'weight', row: 0, message: NOT_A_NUMBER });
  assert.deepEqual(targetRefusal(withRow(wrong, 0, 'reps', '5,5,5')), { field: 'reps', row: 0, message: ONE_DECIMAL });
  // The head's copy-down puts the same fault on every row; the topmost carries it.
  assert.deepEqual(targetRefusal(withHead(straight, 'reps', '400')), { field: 'reps', row: 0, message: REPS_BAND });
  // A hidden ladder is not judged: the open line commits with nothing but its rest.
  assert.equal(targetRefusal(withSets(wrong, '')), null);
  assert.equal(targetRefusal(fields()), null);
});

test('the row the sheet hands back: the open line when the count is empty, the clamps as the last guard', () => {
  const entry = { exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 82.5 }], restSeconds: 180 };
  assert.deepEqual(targetEntryOf(entry, fields({ sets: '2', rows: [row('6', '85,5'), row('6', '85,5')] })), {
    exerciseId: 'bench-press', sets: [{ reps: 6, weightKg: 85.5 }, { reps: 6, weightKg: 85.5 }], restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf(entry, fields({ sets: '1', rows: [row('', '')] })), {
    exerciseId: 'bench-press', sets: [{}], restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf(entry, fields({ sets: '', rows: [row('6', '85')] })), {
    exerciseId: 'bench-press', restSeconds: 180,
  });
  assert.deepEqual(targetEntryOf({ exerciseId: 'chin-up' }, fields()), { exerciseId: 'chin-up' });
  assert.deepEqual(targetEntryOf(entry, fields({ sets: '1', rows: [row('900', '')] })).sets, [{ reps: ENTRY_REPS_MAX }]);
  assert.equal(ENTRY_SETS_MIN, 1);
  assert.equal(ENTRY_REPS_MIN, 1);
});

test('the count grows the ladder copying the row above, and a lower count hides rows without discarding them', () => {
  const ramp = targetFieldsOf({ exerciseId: 'back-squat', sets: RAMP });
  const six = withSets(ramp, '6');
  assert.deepEqual(six.rows, [...ramp.rows, row('5', '80')], 'the sixth set at the fifth’s numbers, not a blank');
  assert.equal(six.sets, '6');
  assert.deepEqual(ladderOf(six), six.rows);
  const four = withSets(six, '4');
  assert.deepEqual(ladderOf(four), ramp.rows.slice(0, 4), 'the ladder shows four');
  assert.deepEqual(four.rows, six.rows, 'and the sheet still holds six');
  const hidden = withSets(four, '');
  assert.equal(hidden.sets, '');
  assert.deepEqual(ladderOf(hidden), []);
  assert.deepEqual(hidden.rows, six.rows, 'hidden, not thrown away');
  assert.deepEqual(withSets(hidden, '5').rows, six.rows, 'retyping brings the rows back');
  assert.deepEqual(ladderOf(withSets(hidden, '5')), ramp.rows);
  assert.deepEqual(withSets(hidden, '8').rows, [...six.rows, row('5', '80'), row('5', '80')], 'and grows from the last of them');
  // A refused count leaves the rows alone and shows them all; from nothing, a count grows blank rows.
  assert.deepEqual(withSets(four, '99').rows, six.rows);
  assert.deepEqual(ladderOf(withSets(four, '99')), six.rows);
  assert.deepEqual(withSets(four, 'x').rows, six.rows);
  assert.deepEqual(withSets(fields(), '3'), fields({ sets: '3', rows: [row('', ''), row('', ''), row('', '')] }));
  // The copy-down writes every ladder row, never a hidden one, and never the count.
  const copied = withHead(four, 'weight', '85');
  assert.deepEqual(ladderOf(copied), ramp.rows.slice(0, 4).map((each) => row(each.reps, '85')));
  assert.deepEqual(copied.rows.slice(4), six.rows.slice(4), 'the hidden rows keep their numbers');
  assert.deepEqual(withRow(four, 2, 'reps', '2').rows[2], row('2', '90'));
});

test('typing a count through a lower intermediate — `5 → 1 → 12` — keeps every row and slices only at commit', () => {
  const entry = { exerciseId: 'back-squat', sets: RAMP, restSeconds: 180 };
  const ramp = targetFieldsOf(entry);
  const one = withSets(ramp, '1');
  assert.deepEqual(one.rows, ramp.rows, 'the keystroke that reads `1` on the way to `12` truncates nothing');
  assert.deepEqual(ladderOf(one), [row('5', '60')]);
  assert.deepEqual(targetEntryOf(entry, one), { ...entry, sets: [{ reps: 5, weightKg: 60 }] }, 'the commit hands back the rows the count names');
  const twelve = withSets(one, '12');
  assert.deepEqual(twelve.rows, [...ramp.rows, ...Array.from({ length: 7 }, () => row('5', '80'))], 'sets 2 to 5 came back, and 6 to 12 copy the fifth');
  assert.equal(targetEntryOf(entry, twelve).sets.length, 12);
  assert.deepEqual(targetEntryOf(entry, twelve).sets.slice(0, 5), RAMP);
  // A hidden row's fault is not judged, and a fill or a delete works on the ladder alone.
  const faulted = withRow(ramp, 4, 'weight', '600');
  assert.deepEqual(targetRefusal(faulted), { field: 'weight', row: 4, message: OVER_MAX_LOAD });
  assert.equal(targetRefusal(withSets(faulted, '4')), null);
  assert.deepEqual(withMatchedToFirst(withSets(faulted, '4')).rows, [row('5', '60'), row('5', '60'), row('5', '60'), row('5', '60'), row('5', '600')]);
  assert.deepEqual(withRowRemoved(withSets(faulted, '4'), 0), fields({ sets: '3', rows: [row('5', '80'), row('3', '90'), row('1', '100')] }));
  assert.deepEqual(withRowAdded(withSets(faulted, '4')), fields({ sets: '5', rows: [row('5', '60'), row('5', '80'), row('3', '90'), row('1', '100'), row('1', '100')] }));
});

test('Add set copies the row above and stops at twenty; deleting the last row lands on the open line', () => {
  const ramp = targetFieldsOf({ exerciseId: 'back-squat', sets: RAMP });
  const added = withRowAdded(ramp);
  assert.equal(added.sets, '6');
  assert.deepEqual(added.rows[5], row('5', '80'));
  assert.deepEqual(withRowAdded(fields()), fields({ sets: '1', rows: [row('', '')] }));

  let twenty = ramp;
  while (twenty.rows.length < ENTRY_SETS_MAX) twenty = withRowAdded(twenty);
  assert.equal(twenty.addRefused, false);
  const refused = withRowAdded(twenty);
  assert.equal(refused.rows.length, ENTRY_SETS_MAX, 'inert at twenty');
  assert.equal(refused.addRefused, true);
  assert.deepEqual(targetRefusal(refused), { field: 'add', row: null, message: SETS_BAND });
  // The next keystroke settles it.
  assert.equal(withRow(refused, 0, 'reps', '6').addRefused, false);
  assert.equal(withRowRemoved(refused, 19).addRefused, false);

  const four = withRowRemoved(ramp, 2);
  assert.equal(four.sets, '4');
  assert.deepEqual(four.rows, [row('5', '60'), row('5', '80'), row('1', '100'), row('5', '80')]);
  const one = withRowRemoved(withRowRemoved(withRowRemoved(four, 0), 0), 0);
  assert.deepEqual(one, fields({ sets: '1', rows: [row('5', '80')] }));
  const open = withRowRemoved(one, 0);
  assert.deepEqual(open, fields());
  assert.equal(targetRefusal(open), null);
  assert.deepEqual(targetEntryOf({ exerciseId: 'back-squat', restSeconds: 180 }, open), { exerciseId: 'back-squat', restSeconds: 180 });
});

test('Ramp up — two typed ends and one tap: 60 × 5 to 100 × 1 over five sets', () => {
  const ends = fields({ sets: '5', rows: [row('5', '60'), row('', ''), row('', ''), row('', ''), row('1', '100')] });
  assert.equal(rampDisabled(ends), false);
  const ramped = withRampUp(ends);
  assert.deepEqual(ramped.rows.map((each) => each.reps), ['5', '4', '3', '2', '1']);
  assert.deepEqual(ramped.rows.map((each) => each.weight), ['60', '70', '80', '90', '100']);
  assert.equal(ramped.sets, '5');
  // Each load between the ends snaps onto the PLATE grid — the band's small step, half away from
  // zero — the same rule on all three surfaces: 21.25 sits in the 2.5 band and goes up to 22.5; 61
  // sits in the 2.5 band and goes down to 60. The ends stay exactly as typed.
  const fine = withRampUp(fields({ sets: '3', rows: [row('5', '20'), row('', ''), row('3', '22.5')] }));
  assert.deepEqual(fine.rows.map((each) => each.weight), ['20', '22.5', '22.5']);
  assert.deepEqual(fine.rows.map((each) => each.reps), ['5', '4', '3']);
  const close = withRampUp(fields({ sets: '3', rows: [row('8', '60'), row('', ''), row('1', '62')] }));
  assert.deepEqual(close.rows.map((each) => each.weight), ['60', '60', '62']);
  // Under 20 the small step is 1; a band-assisted ramp snaps by magnitude, so the sign holds.
  const light = withRampUp(fields({ sets: '4', rows: [row('8', '10'), row('', ''), row('', ''), row('2', '16')] }));
  assert.deepEqual(light.rows.map((each) => each.weight), ['10', '12', '14', '16']);
  const assisted = withRampUp(fields({ sets: '3', rows: [row('8', '-30'), row('', ''), row('2', '-25')] }));
  assert.deepEqual(assisted.rows.map((each) => each.weight), ['-30', '-27.5', '-25']);
  // A comma at an end still reads as a decimal, and the end keeps the text it was typed as.
  const odd = withRampUp(fields({ sets: '4', rows: [row('8', '60'), row('', ''), row('', ''), row('2', '62,5')] }));
  assert.deepEqual(odd.rows.map((each) => each.weight), ['60', '60', '62.5', '62,5']);
  assert.deepEqual(odd.rows.map((each) => each.reps), ['8', '6', '4', '2']);
  // A column with an empty end is left as it stands; the other still ramps.
  const repsOnly = withRampUp(fields({ sets: '3', rows: [row('10', ''), row('7', '80'), row('2', '')] }));
  assert.deepEqual(repsOnly.rows, [row('10', ''), row('6', '80'), row('2', '')]);
  // Disabled while set 1 and set n agree, and under three rows there is nothing between.
  assert.equal(rampDisabled(fields({ sets: '5', rows: Array.from({ length: 5 }, () => row('5', '80')) })), true);
  assert.equal(rampDisabled(fields({ sets: '3', rows: [row('5', '80'), row('3', '90'), row('5', '80,0')] })), true);
  assert.equal(rampDisabled(fields({ sets: '2', rows: [row('5', '60'), row('1', '100')] })), true);
  assert.equal(rampDisabled(fields({ sets: '3', rows: [row('5', '60'), row('', ''), row('1', '100')] })), false);
  assert.equal(rampDisabled(fields({ sets: '3', rows: [row('5', ''), row('', ''), row('1', '')] })), false);
  assert.equal(rampDisabled(fields()), true);
});

test('Match set 1 — every row becomes the first, the way back to a straight scheme', () => {
  const matched = withMatchedToFirst(targetFieldsOf({ exerciseId: 'back-squat', sets: RAMP }));
  assert.deepEqual(matched.rows, Array.from({ length: 5 }, () => row('5', '60')));
  assert.equal(matched.sets, '5');
  assert.deepEqual(headOf(matched), { reps: { value: '5', placeholder: 'max' }, weight: { value: '60', placeholder: 'last time' } });
  assert.equal(rampDisabled(matched), true);
});

test('commitLabel — the scheme’s own readout while every set agrees, the count alone once they do not', () => {
  assert.equal(commitLabel({ exerciseId: 'back-squat', sets: RAMP }), 'Set · 5 sets');
  assert.equal(commitLabel({ exerciseId: 'bench-press', sets: STRAIGHT }), 'Set · 3 × 8 · 60');
  assert.equal(commitLabel({ exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 100 }] }), 'Set · 1 × 5 · 100');
  assert.equal(commitLabel({ exerciseId: 'chin-up', sets: [{}, {}, {}] }), 'Set · 3 × max');
  assert.equal(commitLabel({ exerciseId: 'chin-up' }), 'Set · open');
  assert.equal(commitLabel({ exerciseId: 'chin-up', restSeconds: 120 }), 'Set · open');
});

test('the sheet’s chrome is the pinned fourteen words', () => {
  assert.deepEqual([EVERY_SET, SET_BY_SET, FILL, RAMP_UP, MATCH_SET_ONE, ADD_SET], ['Every set', 'Set by set', 'Fill', 'Ramp up', 'Match set 1', 'Add set']);
  assert.deepEqual(SHEET_CHROME, ['Every set', 'Sets', 'Reps', 'Weight', 'Set by set', 'Fill', 'Add set']);
  const words = [...SHEET_CHROME, commitLabel({ exerciseId: 'back-squat', sets: RAMP })]
    .flatMap((line) => line.split(' ').filter((word) => word !== '·'));
  assert.equal(words.length, 14);
});

test('routineFromSession — a session too big to ask for is clamped to what a routine may ask for', () => {
  const many = Array.from({ length: 25 }, (each, index) => set('chin-up', 0, 8, index));
  const composed = routineFromSession({ id: 'rt_1', name: 'Wednesday', sets: many });
  assert.deepEqual(composed.entries, [
    { exerciseId: 'chin-up', sets: Array.from({ length: ENTRY_SETS_MAX }, () => ({ reps: 8, weightKg: 0 })) },
  ]);
  assert.equal(ENTRY_SETS_MAX, 20);
  assert.equal(ENTRY_REPS_MAX, 100);

  const marathon = routineFromSession({ id: 'rt_2', name: 'Thursday', sets: [set('chin-up', 0, 400, 1), set('chin-up', 0, 400, 2)] });
  assert.deepEqual(marathon.entries[0].sets, [{ reps: ENTRY_REPS_MAX, weightKg: 0 }, { reps: ENTRY_REPS_MAX, weightKg: 0 }]);
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

  const maxed = withEntrySet(two, 1, targetEntryOf(two[1], withSets(fields(), '3')));
  assert.deepEqual(maxed[1], { exerciseId: 'chin-up', sets: [{}, {}, {}] });
  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: maxed }).entries[1], {
    exerciseId: 'chin-up', sets: [{}, {}, {}],
  });
  assert.equal(entryLabel(maxed[1]), '3 × max');
});

test('saysNeverLogged — an untested routine, and a row that has not been filled in', () => {
  const built = { id: 'rt_1', name: 'Heavy Thursday', lastTrainedAt: null };
  const kept = { id: 'rt_2', name: 'Push A', lastTrainedAt: null };
  const trained = { id: 'rt_3', name: 'Legs', lastTrainedAt: AT };

  assert.equal(saysNeverLogged(built, { exerciseId: 'deadlift' }), true);
  assert.equal(saysNeverLogged(kept, { exerciseId: 'back-squat', sets: [{ reps: 3, weightKg: 110 }] }), false);
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift' }), false);
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift', sets: [{ reps: 5 }] }), false);
  assert.equal(saysNeverLogged(blankRoutine({ id: 'rt_new' }), { exerciseId: 'deadlift' }), true);
});

test('the open row carries the one pinned sentence, and a row with a target carries none', () => {
  assert.equal(OPEN_LINE, 'You decide the numbers at the rack.');
  assert.equal(isOpenEntry({ exerciseId: 'barbell-row' }), true);
  assert.equal(isOpenEntry({ exerciseId: 'barbell-row', restSeconds: 120 }), true);
  assert.equal(isOpenEntry({ exerciseId: 'back-squat', sets: [{ reps: 3 }] }), false);
  assert.equal(isOpenEntry({ exerciseId: 'back-squat', sets: [{}] }), false);
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
