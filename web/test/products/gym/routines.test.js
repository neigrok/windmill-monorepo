// The routine rules, pinned. Three of them decide what a lifter's program becomes without them
// ever opening an editor — the routine composed from the session they just did, the copy of one,
// the drag that reorders it — and the fourth is the only question gym asks mid-workout, which is
// the one place a session is allowed to change the program it is running against.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blankRoutine, deviationAsk, draftFrom, dueRoutine, duplicateRoutine, ENTRY_REPS_MAX,
  ENTRY_REPS_MIN, ENTRY_SETS_MAX, ENTRY_SETS_MIN, NAME_MAX, NEW_ENTRY_REPS, NEW_ENTRY_SETS,
  reorderEntries, routineFromSession, routineWrite, withEntryAdded, withEntryChanged,
  withEntryRemoved, withEntryWeight,
} from '../../../src/products/gym/routines.js';

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

// A duplicate must never bounce off a refusal we could see coming: the store takes 80 characters
// and " copy" is five of ours. The original is what gives way — a copy whose suffix was cut off
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

// PUT replaces the whole document, so the modify half has to hand back everything that came back.
test('withEntryWeight — one target changes and the rest of the program comes with it', () => {
  const stored = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    lastTrainedAt: 1_754_300_000_000,
    entries: [
      { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 },
      { position: 2, exerciseId: 'overhead-press', targetSets: 3, targetReps: 8, targetWeightKg: 45 },
    ],
  };
  assert.deepEqual(withEntryWeight(stored, { position: 1, exerciseId: 'bench-press' }, 87.5), {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 87.5, restSeconds: 180 },
      { exerciseId: 'overhead-press', targetSets: 3, targetReps: 8, targetWeightKg: 45 },
    ],
  });
});

// THE LIFT BUG FAMILY, in the one place on this surface it could still happen. A routine naming one
// lift twice — the heavy line and the back-off line — is the case `(routine_id, position)` exists to
// make representable, and a write-back matched on the MOVEMENT rewrote both: the lifter answered one
// question about their top set and the back-off line's 70 kg was destroyed with no second number
// ever shown to them, under a PUT that has no undo.
test('withEntryWeight — a routine naming one lift twice changes only the line that was asked about', () => {
  const stored = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [
      { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 100 },
      { position: 2, exerciseId: 'bench-press', targetSets: 3, targetReps: 10, targetWeightKg: 70 },
      { position: 3, exerciseId: 'back-squat', targetSets: 3, targetReps: 5, targetWeightKg: 120 },
    ],
  };
  assert.deepEqual(withEntryWeight(stored, { position: 1, exerciseId: 'bench-press' }, 105).entries, [
    { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 105 },
    { exerciseId: 'bench-press', targetSets: 3, targetReps: 10, targetWeightKg: 70 },
    { exerciseId: 'back-squat', targetSets: 3, targetReps: 5, targetWeightKg: 120 },
  ]);
  // And the back-off line is addressable in its own right, without touching the heavy one.
  assert.deepEqual(withEntryWeight(stored, { position: 2, exerciseId: 'bench-press' }, 75).entries, [
    { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 100 },
    { exerciseId: 'bench-press', targetSets: 3, targetReps: 10, targetWeightKg: 75 },
    { exerciseId: 'back-squat', targetSets: 3, targetReps: 5, targetWeightKg: 120 },
  ]);
});

// The snapshot is frozen at the session's start and the routine has kept moving. A movement the
// lifter has since deleted must not come back because a session from before still remembers it —
// and neither may a line that moved: position 1 naming something else is a program that changed
// under the question, and half-right is worse than untouched.
//
// So the answer is NOTHING, and not the routine as it was found. Handing the caller back a document
// it can PUT is handing it a write that changes no program: the request succeeds, the sheet closes
// with nothing said, and the lifter who pressed `Save 92.5 to Push A` has seen exactly what a save
// looks like over a Push A that is byte-identical to the one they had.
test('withEntryWeight — a line the routine no longer holds where it was cannot be addressed at all', () => {
  const stored = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [{ position: 1, exerciseId: 'overhead-press', targetSets: 3, targetReps: 8, targetWeightKg: 45 }],
  };
  assert.equal(withEntryWeight(stored, { position: 1, exerciseId: 'cable-fly' }, 25), null);
  assert.equal(withEntryWeight(stored, { position: 4, exerciseId: 'overhead-press' }, 25), null);
  // And the line that IS still there is addressable exactly as it was — the refusal is narrow.
  assert.deepEqual(withEntryWeight(stored, { position: 1, exerciseId: 'overhead-press' }, 50), {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [{ exerciseId: 'overhead-press', targetSets: 3, targetReps: 8, targetWeightKg: 50 }],
  });
});

// Screen 8, word for word. The plan snapshot keeps last Tuesday reading correctly either way, so
// this is only ever a question about the program, never about the session.
test('deviationAsk — a heavier day is asked about once, in the words the design decided', () => {
  const planEntry = { exerciseId: 'bench-press', position: 1, sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180 };
  const sets = [
    set('bench-press', 82.5, 5, 4),
    set('bench-press', 87.5, 5, 9),
    set('bench-press', 87.5, 4, 14),
  ];
  assert.deepEqual(deviationAsk({ routine: 'Push A', planEntry, movement: 'Bench Press', sets }), {
    exerciseId: 'bench-press',
    // Which LINE of the routine the answer edits — carried from the snapshot, because a routine may
    // name one lift twice and only one of them was asked about (withEntryWeight).
    position: 1,
    weightKg: 87.5,
    title: 'Heavier than the plan',
    body: 'Today’s Bench Press ran at 87.5 against a planned 82.5. Today’s session already has it. Push A does not.',
    save: 'Save 87.5 to Push A',
    keep: 'Today only',
  });
  // Asked at the exercise boundary, once, and never again that session.
  assert.equal(deviationAsk({ routine: 'Push A', planEntry, movement: 'Bench Press', sets, asked: ['bench-press'] }), null);
});

// A lighter day is a bad day, not a decision. A program that ratcheted down every time somebody was
// tired would be one nobody wrote.
test('deviationAsk — lighter, equal, warmed-up-only and unplanned all ask nothing', () => {
  const planEntry = { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 };
  const ask = (sets, over = {}) => deviationAsk({ routine: 'Push A', planEntry, movement: 'Bench Press', sets, ...over });

  assert.equal(ask([set('bench-press', 75, 5, 4), set('bench-press', 75, 5, 9)]), null);
  assert.equal(ask([set('bench-press', 82.5, 5, 4)]), null);
  // A warmup above the plan's working weight is not a heavier day; nor is another movement's set.
  assert.equal(ask([set('bench-press', 90, 2, 4, 'warmup')]), null);
  assert.equal(ask([set('overhead-press', 100, 5, 4)]), null);
  assert.equal(ask([]), null);
  // Nothing to deviate from: no routine on the session, or a plan entry that set no weight target.
  assert.equal(ask([set('bench-press', 90, 5, 4)], { routine: null }), null);
  assert.equal(
    ask([set('bench-press', 90, 5, 4)], { planEntry: { exerciseId: 'bench-press', sets: 3, reps: 8 } }),
    null,
  );
  assert.equal(ask([set('bench-press', 90, 5, 4)], { planEntry: null }), null);
});

// A rotation's next turn is the one that has waited longest, and a routine written down and never
// trained has waited longer than any routine ever has.
test('dueRoutine — the card on Today is the routine that has waited longest', () => {
  const routine = (id, days) => ({
    id, name: id, position: 0, entries: [],
    ...(days === null ? {} : { lastTrainedAt: AT - days * 86_400_000 }),
  });
  const rotation = [routine('pull-a', 2), routine('push-a', 5), routine('legs', 3), routine('push-b', 21)];
  assert.equal(dueRoutine(rotation).id, 'push-b');
  assert.equal(dueRoutine([routine('pull-a', 2), routine('new-one', null), routine('push-b', 21)]).id, 'new-one');
  assert.equal(dueRoutine([routine('only', 1)]).id, 'only');
  // Nothing here reads a calendar: with no routines there is no card, and a tie keeps the row the
  // wire already put first.
  assert.equal(dueRoutine([]), null);
  assert.equal(dueRoutine([routine('first', 4), routine('second', 4)]).id, 'first');
  assert.equal(dueRoutine([routine('first', null), routine('second', null)]).id, 'first');
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
      { exerciseId: 'barbell-row', targetSets: NEW_ENTRY_SETS, targetReps: NEW_ENTRY_REPS },
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

// A movement joins on three sets of five and no load: five is the opening value of nearly every
// barbell program there is, it is on screen, and one tap moves it — including one tap onto `max`,
// which is where a chin-up line ends up. The load is the one target it declines to set from the
// start, because "whatever you did last time" is right before the lifter has said anything.
test('blankRoutine, withEntryAdded and withEntryRemoved — the editor’s three membership changes', () => {
  assert.deepEqual(blankRoutine({ id: 'rt_new' }), { id: 'rt_new', name: '', position: 0, entries: [] });
  assert.deepEqual(blankRoutine({ id: 'rt_new', position: 3 }).position, 3);

  const one = withEntryAdded([], 'bench-press');
  assert.deepEqual(one, [{ exerciseId: 'bench-press', targetSets: 3, targetReps: 5 }]);
  assert.equal(NEW_ENTRY_SETS, 3);
  assert.equal(NEW_ENTRY_REPS, 5);

  const two = withEntryAdded(one, 'chin-up');
  assert.deepEqual(two.map((entry) => entry.exerciseId), ['bench-press', 'chin-up']);
  assert.equal(one.length, 1);

  assert.deepEqual(withEntryRemoved(two, 0).map((entry) => entry.exerciseId), ['chin-up']);
  assert.deepEqual(withEntryRemoved(two, 1).map((entry) => entry.exerciseId), ['bench-press']);
  assert.deepEqual(withEntryRemoved(two, 7), two);
  assert.equal(two.length, 2);

  // And the way to canon screen 6's `Chin-up 3 × max` — the one target the editor CLEARS rather
  // than dials, exactly as the load already is, and the wire spells both by omission.
  const maxed = withEntryChanged(two, 1, { targetReps: null });
  assert.deepEqual(maxed[1], { exerciseId: 'chin-up', targetSets: NEW_ENTRY_SETS, targetReps: null });
  assert.deepEqual(routineWrite({ id: 'rt_1', name: 'Push A', position: 0, entries: maxed }).entries[1], {
    exerciseId: 'chin-up', targetSets: NEW_ENTRY_SETS,
  });
});
