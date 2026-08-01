// The prefill, pinned — the product's soul is a precedence, and getting it backwards is the
// difference between a log that knows what you did and a form that asks.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  counterLine, planEntryFor, prefillCard, prefillFor, workingSetsOf,
} from '../../../../src/products/gym/logger/prefill.js';

// Local instants on purpose: a day label and an "N days ago" are read off the lifter's own clock,
// so a fixture built in UTC would name a different day either side of midnight.
const TUESDAY = new Date(2026, 6, 22, 18, 12).getTime();
const SATURDAY = new Date(2026, 6, 25, 18, 12).getTime();

function set(exerciseId, weightKg, reps, completedAt, kind = 'working') {
  return { id: `set_${completedAt}`, exerciseId, weightKg, reps, kind, completedAt };
}

// Exactly what `GET /v1/gym/last` puts on the wire, probed against the running server: the movement
// echoed back, the session, the routine name only when that session had one, and the working sets
// in order. A first-ever movement comes back as the movement alone.
function answer(exerciseId, startedAt, sets, routine) {
  const reply = { exerciseId, session: { id: `ses_${startedAt}`, startedAt, finishedAt: startedAt + 3600000 }, sets };
  if (routine !== undefined) reply.routine = routine;
  return reply;
}

test('prefillFor — plan wins over last time, and today wins over both', () => {
  const lastTime = answer('back-squat', TUESDAY, [
    set('back-squat', 100, 5, TUESDAY + 1000), set('back-squat', 95, 3, TUESDAY + 2000),
  ]);
  const planEntry = { exerciseId: 'back-squat', sets: 5, reps: 5, weightKg: 102.5 };

  assert.deepEqual(prefillFor({ todaySets: [], planEntry: null, lastTime: null }), { weight: 20, reps: 5 });
  assert.deepEqual(prefillFor({ todaySets: [], planEntry: null, lastTime }), { weight: 95, reps: 5 });
  assert.deepEqual(prefillFor({ todaySets: [], planEntry, lastTime }), { weight: 102.5, reps: 5 });
  assert.deepEqual(
    prefillFor({ todaySets: [set('back-squat', 80, 8, SATURDAY)], planEntry, lastTime }),
    { weight: 80, reps: 8 },
  );
});

// The asymmetry is deliberate: the weight comes from the LAST working set, where the lifter
// actually ended up, and the reps from the FIRST, before fatigue cut them.
test('prefillFor — last time gives the last set’s weight and the first set’s reps', () => {
  const lastTime = answer('back-squat', TUESDAY, [
    set('back-squat', 100, 8, TUESDAY + 1000),
    set('back-squat', 100, 7, TUESDAY + 2000),
    set('back-squat', 92.5, 5, TUESDAY + 3000),
  ]);
  assert.deepEqual(prefillFor({ lastTime }), { weight: 92.5, reps: 8 });
});

// The two absences the dial cannot tell apart, and must not: a movement never trained and a log
// that has not answered both leave the plan — or the empty bar — holding the number.
test('prefillFor — a first-ever movement and an unanswered read both fall through', () => {
  assert.deepEqual(prefillFor({ lastTime: { exerciseId: 'deadlift' } }), { weight: 20, reps: 5 });
  assert.deepEqual(prefillFor({ lastTime: null }), { weight: 20, reps: 5 });
  assert.deepEqual(
    prefillFor({ lastTime: { exerciseId: 'deadlift' }, planEntry: { sets: 3, reps: 5, weightKg: 60 } }),
    { weight: 60, reps: 5 },
  );
});

// A routine may name a movement without naming a load ("last time" is the target). The axis with
// no target falls through on its own rather than dialling a null onto the screen.
test('prefillFor — a plan with no weight falls through for the weight alone', () => {
  const lastTime = answer('chin-up', TUESDAY, [set('chin-up', 0, 8, TUESDAY + 1000)]);
  assert.deepEqual(
    prefillFor({ planEntry: { exerciseId: 'chin-up', sets: 3, reps: 8 }, lastTime }),
    { weight: 0, reps: 8 },
  );
  assert.deepEqual(
    prefillFor({ planEntry: { exerciseId: 'chin-up', sets: 3, reps: 8 }, lastTime: null }),
    { weight: 20, reps: 8 },
  );
});

test('planEntryFor — the frozen snapshot reads the same parsed or as stored json', () => {
  const entries = [{ exerciseId: 'back-squat', sets: 5, reps: 5, weightKg: 102.5 }];
  assert.deepEqual(planEntryFor({ plan: { routine: 'Squat day', entries } }, 'back-squat'), entries[0]);
  assert.deepEqual(planEntryFor({ plan: JSON.stringify({ routine: 'Squat day', entries }) }, 'back-squat'), entries[0]);
  assert.equal(planEntryFor({ plan: { routine: 'Squat day', entries } }, 'bench-press'), null);
  assert.equal(planEntryFor({ plan: null }, 'back-squat'), null);
  assert.equal(planEntryFor(null, 'back-squat'), null);
});

// Today's own sets are the one thing still filtered here: the warmups in last time were dropped by
// the store before the block ever reached the wire.
test('workingSetsOf — a warmup is not a set of the day’s work', () => {
  const sets = [
    set('back-squat', 60, 5, TUESDAY + 1000, 'warmup'),
    set('back-squat', 100, 5, TUESDAY + 2000),
    set('bench-press', 80, 5, TUESDAY + 3000),
  ];
  assert.deepEqual(workingSetsOf(sets, 'back-squat'), [sets[1]]);
  assert.deepEqual(workingSetsOf(sets, 'bench-press'), [sets[2]]);
  assert.deepEqual(workingSetsOf(sets, 'deadlift'), []);
  assert.deepEqual(workingSetsOf([sets[0]], 'back-squat'), []);
});

test('prefillCard — the day, how long ago, and which routine it happened on', () => {
  const rows = [
    set('back-squat', 100, 5, TUESDAY + 1000),
    set('back-squat', 100, 5, TUESDAY + 2000),
    set('back-squat', 100, 5, TUESDAY + 3000),
    set('back-squat', 100, 5, TUESDAY + 4000),
    set('back-squat', 100, 5, TUESDAY + 5000),
  ];
  assert.deepEqual(prefillCard({ lastTime: answer('back-squat', TUESDAY, rows), now: SATURDAY }), {
    title: 'Last time · Wed 22 Jul · 3 days ago',
    body: '100 × 5,   100 × 5,   100 × 5,   100 × 5,   +1 more',
  });
  assert.deepEqual(prefillCard({
    lastTime: answer('back-squat', TUESDAY, rows.slice(0, 2), 'Bench day'),
    routine: 'Squat day',
    now: SATURDAY,
  }), {
    title: 'Last time · Wed 22 Jul · 3 days ago  ·  Bench day',
    body: '100 × 5,   100 × 5',
  });
  assert.deepEqual(prefillCard({
    lastTime: answer('back-squat', TUESDAY, rows.slice(0, 1), 'Squat day'),
    routine: 'Squat day',
    now: SATURDAY,
  }), {
    title: 'Last time · Wed 22 Jul · 3 days ago',
    body: '100 × 5',
  });
});

// An ad-hoc session names no routine at all, so the field is absent rather than null — the card
// reads the same as it does for a session trained on today's own routine.
test('prefillCard — a session with no routine adds no suffix', () => {
  assert.deepEqual(prefillCard({
    lastTime: answer('back-squat', TUESDAY, [set('back-squat', 100, 5, TUESDAY + 1000)]),
    routine: 'Squat day',
    now: SATURDAY,
  }), {
    title: 'Last time · Wed 22 Jul · 3 days ago',
    body: '100 × 5',
  });
});

test('prefillCard — first time logging this, with and without a plan to dial to', () => {
  const firstEver = { exerciseId: 'deadlift' };
  assert.deepEqual(prefillCard({ lastTime: firstEver, planEntry: null }), {
    title: 'First time logging this',
    body: 'no history — start where you like',
  });
  assert.deepEqual(prefillCard({ lastTime: firstEver, planEntry: { sets: 3, reps: 8, weightKg: 45 } }), {
    title: 'First time logging this',
    body: 'no history — dialled to the plan’s 45 kg',
  });
});

// The one the old client could not say. "Never trained" is something only the log can tell you, and
// until it does — a read in flight, a phone in a basement — the card says it is still reading
// instead of writing "no history" over a year of squats.
test('prefillCard — an unanswered read is not a first time', () => {
  assert.deepEqual(prefillCard({ lastTime: null, planEntry: null }), {
    title: 'Last time',
    body: 'reading your log…',
  });
  assert.deepEqual(prefillCard({ lastTime: null, planEntry: { sets: 3, reps: 8, weightKg: 45 } }), {
    title: 'Last time',
    body: 'reading your log…',
  });
});

// …and a read that came back empty-handed is not one either. Saying "reading your log…" ten minutes
// after the read failed is the same lie told more quietly: the card claims an in-flight request
// that ended, and nothing on screen accounts for the wait.
test('prefillCard — a read that failed says so instead of claiming to still be reading', () => {
  assert.deepEqual(prefillCard({ lastTime: null, planEntry: null, readFailed: true }), {
    title: 'Last time',
    body: 'the log didn’t answer',
  });
  assert.deepEqual(prefillCard({
    lastTime: null, planEntry: { sets: 3, reps: 8, weightKg: 45 }, readFailed: true,
  }), {
    title: 'Last time',
    body: 'the log didn’t answer',
  });
  // An answer that landed later outranks the failure that preceded it.
  const answered = {
    exerciseId: 'back-squat',
    session: { id: 'ses_1', startedAt: Date.UTC(2025, 6, 22, 18, 12) },
    routine: null,
    sets: [{ weightKg: 100, reps: 5 }],
  };
  assert.deepEqual(prefillCard({
    lastTime: answered, readFailed: true, now: Date.UTC(2025, 6, 24, 18, 12),
  }), {
    title: 'Last time · Tue 22 Jul · 2 days ago',
    body: '100 × 5',
  });
});

// "set 4 of 3" is legal and unremarkable: the plan is a snapshot of what was written down, the log
// is what happened, and when they disagree the log is right.
test('counterLine — the plan is always visible, and never scolds', () => {
  const planEntry = { sets: 5, reps: 5, weightKg: 102.5 };
  assert.deepEqual(counterLine({ workingSetsToday: 2, planEntry }), {
    count: 'set 3 of 5', tail: '  ·  plan 5 × 5 @ 102.5',
  });
  assert.deepEqual(counterLine({ workingSetsToday: 3, planEntry: { sets: 3, reps: 8, weightKg: 0 } }), {
    count: 'set 4 of 3', tail: '  ·  plan 3 × 8 @ 0',
  });
  assert.deepEqual(counterLine({ workingSetsToday: 0, planEntry: null }), {
    count: 'set 1', tail: '  ·  no target',
  });
  assert.deepEqual(counterLine({ workingSetsToday: 1, planEntry: { sets: 3, reps: 8 } }), {
    count: 'set 2 of 3', tail: '  ·  plan 3 × 8',
  });
});
