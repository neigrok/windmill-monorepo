// The routine rules, pinned. Three of them decide what a lifter's program becomes without them
// ever opening an editor — the routine composed from the session they just did, the copy of one,
// the drag that reorders it. The capture-time rules (which routine is due, the mid-workout
// question) went to the phone rooms with the capture itself (§11) and are pinned there.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blankRoutine, builtLabel, draftFrom, duplicateRoutine, ENTRY_REPS_MAX, ENTRY_REPS_MIN,
  ENTRY_SETS_MAX, ENTRY_SETS_MIN, entryPlaceLabel, historyRows, NAME_SUGGESTIONS, NEW_ENTRY_REPS,
  NEW_ENTRY_SETS, openTargetsLine, reorderEntries, routineFromSession, routineWrite, saysNeverLogged,
  targetDraftOf, withEntryAdded, withEntryChanged, withEntryOpened, withEntryRemoved,
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

// Screen 3, the whole of it: the order performed, the count of working sets, the modal reps and
// the heaviest load. Rest is left out so the routine takes the client's default instead of freezing
// however long this one session happened to rest.
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

// A movement that got no working set is not a target. A warmup nobody followed up on is not a
// movement the lifter chose to do, and an entry asking for zero sets is not something to train to.
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

// The reps target is the modal count, and a tie goes to the set performed earliest — the same
// asymmetry the prefill keeps, where reps come from before fatigue cut them. 8, 8, 6, 6 started
// at 8, and the heaviest load is the target whether or not it was the last one lifted.
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

// What the store numbered is the store's to number, and what it remembers is its to remember: a
// write carries the order and nothing that repeats it.
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

// All three absences mean something, and a zero would quietly turn each of them into a number the
// lifter never chose: an omitted weight is "whatever you did last time", an omitted rest is the
// client's own default, and an omitted rep target is canon screen 6's `3 × max`. An absent optional
// is OMITTED and never null, exactly as the rest of this module's wire does it.
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

// A duplicate must never bounce off a refusal we could see coming: this client stops at sixty
// characters — under the store's own eighty bytes, on purpose (log.js) — and " copy" is five of ours. The original is what gives way — a copy whose suffix was cut off
// would be a second routine wearing the first one's name.
test('duplicateRoutine — the default name fits the store, and the suffix is what survives', () => {
  const long = 'P'.repeat(NAME_MAX);
  const copy = duplicateRoutine({ id: 'rt_1', name: long, position: 0, entries: [] }, { id: 'rt_2' });
  assert.equal(copy.name, `${'P'.repeat(NAME_MAX - 5)} copy`);
  assert.equal(copy.name.length, NAME_MAX);

  const typed = duplicateRoutine({ id: 'rt_1', name: 'Push A', position: 0, entries: [] }, { id: 'rt_2', name: 'Q'.repeat(NAME_MAX + 20) });
  assert.equal(typed.name.length, NAME_MAX);
});

// Renumbering from the new order every time is the only way a list dragged twice cannot end up
// with two rows claiming the same place.
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
  // The list handed in is never the list handed back.
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

// The editor changes a COPY. Nothing reaches the store until Done, so a lifter who walks away
// mid-edit still has the program they trained against yesterday.
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
  // The movement that just joined asks for nothing yet, and the two that were already there are
  // untouched by its arrival.
  assert.deepEqual(draft.entries[2], { exerciseId: 'barbell-row' });
  assert.equal(routine.name, 'Push A');
  assert.equal(routine.entries.length, 2);
  assert.equal(routine.entries[0].targetWeightKg, 82.5);

  // What goes to the store is the same write document either way, and the draft's own entry order
  // is the routine's order.
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

// ± is a button a thumb holds down, and each target has one value no stepper can reach: none at
// all, which is the wire's way of saying "whatever you did last time" for a load and `3 × max` for
// a rep count. The clamp lets both absences through — clamping a cleared target back to 1 would
// make the editor's own way to `max` unreachable.
test('withEntryChanged — one line changes, the counts stay inside what a movement can ask for', () => {
  const entries = [
    { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 },
    { exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
  ];
  assert.equal(withEntryChanged(entries, 0, { targetSets: 6 })[0].targetSets, 6);
  assert.equal(withEntryChanged(entries, 0, { targetSets: 0 })[0].targetSets, ENTRY_SETS_MIN);
  assert.equal(withEntryChanged(entries, 0, { targetSets: 99 })[0].targetSets, ENTRY_SETS_MAX);
  assert.equal(withEntryChanged(entries, 0, { targetReps: 0 })[0].targetReps, ENTRY_REPS_MIN);
  assert.equal(withEntryChanged(entries, 0, { targetReps: 500 })[0].targetReps, ENTRY_REPS_MAX);
  assert.equal(withEntryChanged(entries, 1, { targetWeightKg: 60 })[1].targetWeightKg, 60);
  assert.equal(withEntryChanged(entries, 0, { targetWeightKg: null })[0].targetWeightKg, null);
  // Cleared back to "whatever you did last time" is an OMISSION on the wire, never a zero.
  assert.deepEqual(
    routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: withEntryChanged(entries, 0, { targetWeightKg: null }) }).entries[0],
    { exerciseId: 'bench-press', targetSets: 5, targetReps: 5 },
  );
  assert.equal(withEntryChanged(entries, 0, { targetSets: 6 })[1], entries[1]);
  assert.equal(entries[0].targetSets, 5);

  // Cleared to `3 × max`, and it survives the clamp rather than being repaired to one rep.
  assert.equal(withEntryChanged(entries, 0, { targetReps: null })[0].targetReps, null);
  assert.deepEqual(
    routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: withEntryChanged(entries, 1, { targetReps: null }) }).entries[1],
    { exerciseId: 'chin-up', targetSets: 3 },
  );
});

// COMPOSED WITHOUT A HUMAN IN THE LOOP, and it was the one path that never clamped. A density day
// of 25 chin-up sets composed a routine the domain refuses (1..20) — and the finish screen reported
// every failure as "the log didn't answer", which is false for a 400 that no retry can ever fix.
test('routineFromSession — a session too big to ask for is clamped to what a routine may ask for', () => {
  const many = Array.from({ length: 25 }, (each, index) => set('chin-up', 0, 8, index));
  const composed = routineFromSession({ id: 'rt_1', name: 'Wednesday', sets: many });
  assert.deepEqual(composed.entries, [
    { exerciseId: 'chin-up', targetSets: ENTRY_SETS_MAX, targetReps: 8, targetWeightKg: 0 },
  ]);
  // The same ceiling the editor's own ± stops at, so one rule bounds every path to the store.
  assert.equal(ENTRY_SETS_MAX, 12);

  const marathon = routineFromSession({ id: 'rt_2', name: 'Thursday', sets: [set('chin-up', 0, 400, 1), set('chin-up', 0, 400, 2)] });
  assert.equal(marathon.entries[0].targetReps, ENTRY_REPS_MAX);
  assert.equal(marathon.entries[0].targetSets, 2);
});

// A MOVEMENT JOINS THE DAY OPEN (§M screen 29: `Deadlift open`, `Barbell Row open`, with the sheet
// standing on one of them). The routine names the movement before it says what to do with it, so the
// only numbers in a routine built at the desk are numbers a lifter typed — and `open`, the row the
// board draws, is where the ordinary path lands rather than a detour through a sheet you decline.
// Three of five is still the sheet's opening value, and only the sheet's.
test('blankRoutine, withEntryAdded and withEntryRemoved — the editor’s three membership changes', () => {
  assert.deepEqual(blankRoutine({ id: 'rt_new' }), { id: 'rt_new', name: '', position: 0, entries: [] });
  assert.deepEqual(blankRoutine({ id: 'rt_new', position: 3 }).position, 3);

  const one = withEntryAdded([], 'bench-press');
  assert.deepEqual(one, [{ exerciseId: 'bench-press' }]);
  assert.equal(NEW_ENTRY_SETS, 3);
  assert.equal(NEW_ENTRY_REPS, 5);

  const two = withEntryAdded(one, 'chin-up');
  assert.deepEqual(two.map((entry) => entry.exerciseId), ['bench-press', 'chin-up']);
  assert.equal(one.length, 1);

  // NAMED, AND ASKING FOR NOTHING, ALL THE WAY TO THE WIRE: a routine saved the moment its movements
  // are in carries no target anybody invented, so the rack asks rather than grading a set against a
  // number nobody chose.
  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Heavy Thursday', position: 0, entries: two }).entries, [
    { exerciseId: 'bench-press' },
    { exerciseId: 'chin-up' },
  ]);
  assert.equal(entryLabel(two[0]), 'open');

  assert.deepEqual(withEntryRemoved(two, 0).map((entry) => entry.exerciseId), ['chin-up']);
  assert.deepEqual(withEntryRemoved(two, 1).map((entry) => entry.exerciseId), ['bench-press']);
  assert.deepEqual(withEntryRemoved(two, 7), two);
  assert.equal(two.length, 2);

  // And the way to canon screen 6's `Chin-up 3 × max` — the one target the editor CLEARS rather
  // than dials, exactly as the load already is, and the wire spells both by omission. It is the
  // sheet that sets a line, so this is the sheet's draft coming back through `Set`.
  const sheet = targetDraftOf(two[1]);
  const maxed = withEntryChanged(two, 1, { ...sheet, targetReps: null });
  assert.deepEqual(maxed[1], { exerciseId: 'chin-up', targetSets: NEW_ENTRY_SETS, targetReps: null });
  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: maxed }).entries[1], {
    exerciseId: 'chin-up', targetSets: NEW_ENTRY_SETS,
  });
});

// THE SENTENCE THAT SAYS THERE IS NOTHING BEHIND THESE NUMBERS, drawn on both halves of what makes
// it true (§M screen 29). The first routine most lifters ever have is kept from a session they just
// did, so it is untested on the day it is born with every number in it out of the log — and the
// sheet over one of those rows must not tell them it was never logged.
test('saysNeverLogged — an untested routine, and a row that has not been filled in', () => {
  const built = { id: 'rt_1', name: 'Heavy Thursday', lastTrainedAt: null };
  const kept = { id: 'rt_2', name: 'Push A', lastTrainedAt: null };
  const trained = { id: 'rt_3', name: 'Legs', lastTrainedAt: AT };

  assert.equal(saysNeverLogged(built, { exerciseId: 'deadlift' }), true);
  // The row the session composed carries the weights actually used, so nothing about it is unlogged.
  assert.equal(saysNeverLogged(kept, { exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 }), false);
  // A routine that HAS been trained says nothing at all, whatever the row holds.
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift' }), false);
  assert.equal(saysNeverLogged(trained, { exerciseId: 'deadlift', targetSets: 3, targetReps: 5 }), false);
  // A routine nobody has saved yet is untested by the same absence, so a fresh day says it too.
  assert.equal(saysNeverLogged(blankRoutine({ id: 'rt_new' }), { exerciseId: 'deadlift' }), true);
});

// ── The third door: a program typed in at the desk (§M) ─────────────────────────────────────────

// A ROUTINE IS SAVABLE WHILE INCOMPLETE, and this is the whole of what that costs the document: the
// row keeps its place in the day and stops asking for anything. All three targets go together —
// the store refuses a line with reps and no sets to do them for, 400, on a save no retry repairs —
// and rest stays, being how long you wait rather than what you are asked to do.
test('withEntryOpened — an open row keeps its place, its rest, and no target at all', () => {
  const entries = [
    { position: 1, exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 },
    { position: 2, exerciseId: 'barbell-row', targetSets: 4, targetReps: 8, targetWeightKg: 70, restSeconds: 120 },
  ];
  const opened = withEntryOpened(entries, 1);
  assert.deepEqual(opened, [
    { position: 1, exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 },
    { exerciseId: 'barbell-row', restSeconds: 120 },
  ]);
  // The list it was given is untouched, like every other change in this module.
  assert.equal(entries[1].targetSets, 4);
  // An index that names no row changes nothing.
  assert.deepEqual(withEntryOpened(entries, 9), entries);

  // AND THE WRITE CARRIES THE ABSENCE. A `targetSets` sent as null or as a zero would be a target of
  // nothing rather than the open line, and reps or a weight beside no sets is the refusal above.
  const write = routineWrite({ id: 'rt_1', name: 'Heavy Thursday', position: 0, entries: opened });
  assert.deepEqual(write.entries[1], { exerciseId: 'barbell-row', restSeconds: 120 });
  assert.deepEqual(Object.keys(write.entries[1]), ['exerciseId', 'restSeconds']);

  // Even handed a half-open line — a shape no action here produces — the write is the last gate
  // before a 400 nobody can repair, so it drops what an open line may not carry.
  const half = routineWrite({
    id: 'rt_1',
    name: 'Heavy Thursday',
    position: 0,
    entries: [{ exerciseId: 'deadlift', targetReps: 5, targetWeightKg: 140 }],
  });
  assert.deepEqual(half.entries[0], { exerciseId: 'deadlift' });
});

// WHICH LINES WILL ASK AT THE RACK, said as a fact about the day. It is composed from the entries
// themselves, so it is never a sentence about a routine other than the one on screen.
test('openTargetsLine — the open rows are named, and a routine with none says nothing', () => {
  const catalog = [
    { id: 'back-squat', name: 'Back Squat' },
    { id: 'barbell-row', name: 'Barbell Row' },
    { id: 'deadlift', name: 'Deadlift' },
  ];
  const targeted = { exerciseId: 'back-squat', targetSets: 5, targetReps: 3 };
  assert.equal(openTargetsLine([targeted], catalog), null);
  assert.equal(openTargetsLine([], catalog), null);
  assert.equal(
    openTargetsLine([targeted, { exerciseId: 'barbell-row' }], catalog),
    'Barbell Row has no target — it will ask at the rack.',
  );
  assert.equal(
    openTargetsLine([{ exerciseId: 'barbell-row' }, { exerciseId: 'deadlift' }], catalog),
    'Barbell Row and Deadlift have no target — they will ask at the rack.',
  );
  assert.equal(
    openTargetsLine([{ exerciseId: 'barbell-row' }, { exerciseId: 'deadlift' }, { exerciseId: 'back-squat' }], catalog),
    'Barbell Row, Deadlift and Back Squat have no target — they will ask at the rack.',
  );
  // A catalog that has not answered still names the movement, by its id, exactly as every other
  // sentence in this product does rather than leaving a hole where the movement should be.
  assert.equal(openTargetsLine([{ exerciseId: 'barbell-row' }], []), 'barbell-row has no target — it will ask at the rack.');
});

// The sheet opens an open row at the OPENING VALUES and the row stays open until `Set` brings them
// back: a number on screen to be typed over, and never a prefill — a routine built at home has no
// history to prefill from, which is the line the sheet itself says out loud.
test('targetDraftOf — an open row opens the sheet at three of five, and takes nothing on its own', () => {
  const open = { exerciseId: 'deadlift', restSeconds: 120 };
  assert.deepEqual(targetDraftOf(open), {
    exerciseId: 'deadlift', restSeconds: 120, targetSets: NEW_ENTRY_SETS, targetReps: NEW_ENTRY_REPS,
  });
  // No weight is invented with them: "whatever you did last time" is still the one right answer for
  // a load nobody has named.
  assert.equal(targetDraftOf(open).targetWeightKg, undefined);
  assert.equal(open.targetSets, undefined);

  const set = { exerciseId: 'back-squat', targetSets: 5, targetReps: 3, targetWeightKg: 110 };
  assert.deepEqual(targetDraftOf(set), set);
  assert.notEqual(targetDraftOf(set), set);
});

// Three openers past a blank field, and they are the same three every time: an opener that changed
// with the day would read as the app knowing something about the program.
test('NAME_SUGGESTIONS — three fixed openers, and none of them is derived from anything', () => {
  assert.deepEqual(NAME_SUGGESTIONS, ['Push C', 'Lower B', 'Thursday']);
  for (const suggestion of NAME_SUGGESTIONS) assert.equal(suggestion.length <= NAME_MAX, true);
});

// Where you are in the day, on the sheet asking for one line's numbers. A routine still being named
// is a state this editor genuinely has, and the label drops the separator rather than the fact.
test('entryPlaceLabel — the position in the run, and the routine when it has a name', () => {
  assert.equal(entryPlaceLabel(1, 4, 'Heavy Thursday'), '2 of 4 · Heavy Thursday');
  assert.equal(entryPlaceLabel(0, 1, 'Legs'), '1 of 1 · Legs');
  assert.equal(entryPlaceLabel(1, 4, '   '), '2 of 4');
  assert.equal(entryPlaceLabel(1, 4, ''), '2 of 4');
});

// WHEN THE DAY WAS WRITTEN, AND HOW BIG IT WAS THEN. The count is the store's `movements` — what the
// routine was CREATED with — and a routine written before that column existed carries none: today's
// entry count is not a substitute, because a day built with four and cut to three would claim it was
// born at three. Past six days the weekday stops being unambiguous and the date is what is left.
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
  // A routine that has not been saved has no history at all, and is asked for nothing.
  assert.equal(builtLabel({ history: [] }, now), null);
  assert.equal(builtLabel({}, now), null);
  assert.equal(builtLabel(null, now), null);
});

// THE ROUTINE'S HISTORY IS ONE LIST OF TWO KINDS, in the order the store sent it: newest first, the
// created row last and always there. A created row with no `by` is the lifter's own hand — the
// absence IS the claim — and one with a door names the agent instead, because `created by you` over
// an agent's day would be putting words in a lifter's mouth.
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
    line: '10 Aug · 3 changes from your connected agent · waiting for you',
  });
  assert.deepEqual(rows[1], {
    key: 'created-1',
    pending: false,
    href: null,
    line: '9 Aug · created by you · 4 movements',
  });

  // An agent's day names the door it came through, and never the lifter.
  const byAgent = historyRows({
    history: [{ kind: 'created', at: new Date(2026, 7, 9, 11, 0).getTime(), by: 'ask', movements: 2 }],
  });
  assert.equal(byAgent[0].line, '9 Aug · created by Ask · 2 movements');
  assert.equal(byAgent[0].line.includes('by you'), false);
  assert.equal(
    historyRows({ history: [{ kind: 'created', at: new Date(2026, 7, 9, 11, 0).getTime(), by: 'mcp' }] })[0].line,
    '9 Aug · created by your connected agent',
  );

  // A routine nobody has saved, and one read from a store that sends no history, both draw nothing.
  assert.deepEqual(historyRows({ history: [] }), []);
  assert.deepEqual(historyRows({}), []);
  assert.deepEqual(historyRows(null), []);
});
