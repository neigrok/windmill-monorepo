// The log's reading rules, pinned. Where the hash points and what each room is called, what a
// session is named when the plan arrives in either wire shape, and the first-performed order the
// detail view groups sets in — plus the two facts G8 draws on every row: which set was the top one,
// and whether anybody actually pressed Finish. Both have two sources and one rule, because a
// session in the list carries the store's own answer and a session read whole carries its sets.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agoLabel, BACKFILL_HREF, clockOf, CLOSED_ITSELF_NOTE, closedOnItsOwn, dayLabel, durLabel,
  entryLabel, finishHref, finishIdOf, fmt, groupByExercise, isFinished, isFirstSession,
  nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE, planOf, routineHref, routineIdOf, routineMetaLabel,
  routineNameOf, ROUTINES_HREF, screenOf, sessionHref, sessionIdOf, sessionMetaLabel,
  setCountLabel, sharedHref, sharedTokenOf, STATS_HREF, timeLabel, topSetLabel,
  topSetOf, utcDayLabel, weekdayName, workingSetsOf,
} from '../../../src/products/gym/log.js';

test('sessionIdOf — a session hash yields its id, everything else yields nothing', () => {
  assert.equal(sessionIdOf('#/gym/session/ses_9f3a1c22'), 'ses_9f3a1c22');
  assert.equal(sessionIdOf('#/gym/session/ses_9f3a1c22/sets'), 'ses_9f3a1c22');
  assert.equal(sessionIdOf('#/gym'), null);
  assert.equal(sessionIdOf('#/gym/session/'), null);
  assert.equal(sessionIdOf('#/journal/2026-08-01'), null);
  assert.equal(sessionIdOf(''), null);
  assert.equal(sessionIdOf(undefined), null);
});

test('sessionHref — the link the log writes is the link the log reads back', () => {
  assert.equal(sessionHref('ses_9f3a1c22'), '#/gym/session/ses_9f3a1c22');
  assert.equal(sessionIdOf(sessionHref('ses_9f3a1c22')), 'ses_9f3a1c22');
});

test('routineNameOf — the plan reads the same whether it arrives parsed or as stored json', () => {
  assert.equal(routineNameOf({ plan: { routine: 'Upper A', entries: [] } }), 'Upper A');
  assert.equal(routineNameOf({ plan: '{"routine":"Upper A","entries":[]}' }), 'Upper A');
  assert.equal(routineNameOf({ plan: '{"entries":[]}' }), null);
  assert.equal(routineNameOf({ plan: { entries: [] } }), null);
  assert.equal(routineNameOf({ plan: 'not json at all' }), null);
  assert.equal(routineNameOf({ plan: '' }), null);
  assert.equal(routineNameOf({}), null);
});

test('routineNameOf — a routine the snapshot does not hold as a name is no routine', () => {
  assert.equal(routineNameOf({ plan: { routine: { name: 'Upper A' } } }), null);
  assert.equal(routineNameOf({ plan: { routine: ['Upper A'] } }), null);
  assert.equal(routineNameOf({ plan: { routine: 7 } }), null);
  assert.equal(routineNameOf({ plan: { routine: null } }), null);
  assert.equal(routineNameOf({ plan: { routine: '' } }), null);
});

test('nameOfMovement — the catalog names a movement, and its id stands in until the catalog answers', () => {
  const catalog = [{ id: 'back-squat', name: 'Back Squat' }, { id: 'face-pull', name: 'Face Pull' }];
  assert.equal(nameOfMovement(catalog, 'face-pull'), 'Face Pull');
  assert.equal(nameOfMovement(catalog, 'deadlift'), 'deadlift');
  assert.equal(nameOfMovement([], 'back-squat'), 'back-squat');
  assert.equal(nameOfMovement(null, 'back-squat'), 'back-squat');
  assert.equal(nameOfMovement(undefined, 'back-squat'), 'back-squat');
});

test('groupByExercise — first-performed order across exercises, server numbering within one', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const sets = [
    set('set_4', 'bench-press', 2, 1_900_000_400_000),
    set('set_1', 'back-squat', 1, 1_900_000_100_000),
    set('set_3', 'bench-press', 1, 1_900_000_300_000),
    set('set_2', 'back-squat', 2, 1_900_000_200_000),
  ];
  assert.deepEqual(groupByExercise(sets), [
    ['back-squat', [sets[1], sets[3]]],
    ['bench-press', [sets[2], sets[0]]],
  ]);
  assert.deepEqual(sets.map((each) => each.id), ['set_4', 'set_1', 'set_3', 'set_2']);
  assert.deepEqual(groupByExercise([]), []);
});

test('groupByExercise — a movement returned to later keeps its first-performed place', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const squat1 = set('set_1', 'back-squat', 1, 1_900_000_100_000);
  const bench = set('set_2', 'bench-press', 1, 1_900_000_200_000);
  const squat2 = set('set_3', 'back-squat', 2, 1_900_000_300_000);
  assert.deepEqual(groupByExercise([squat1, bench, squat2]), [
    ['back-squat', [squat1, squat2]],
    ['bench-press', [bench]],
  ]);
});

test('groupByExercise — a set the server has not numbered yet sorts last, then by completion', () => {
  const set = (id, exerciseId, setNumber, completedAt) => ({ id, exerciseId, setNumber, completedAt });
  const first = set('set_1', 'back-squat', 1, 1_900_000_100_000);
  const second = set('set_2', 'back-squat', 2, 1_900_000_200_000);
  const flushing = set('set_3', 'back-squat', undefined, 1_900_000_300_000);
  const alsoFlushing = set('set_4', 'back-squat', undefined, 1_900_000_250_000);
  assert.deepEqual(groupByExercise([flushing, second, alsoFlushing, first]), [
    ['back-squat', [first, second, alsoFlushing, flushing]],
  ]);
});

test('isFinished — an end instant of zero is still an end, absence is not', () => {
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: 1_900_003_600_000 }), true);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: 0 }), true);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000, finishedAt: null }), false);
  assert.equal(isFinished({ startedAt: 1_900_000_000_000 }), false);
});

test('durLabel and setCountLabel — the two numbers the log row says out loud', () => {
  assert.equal(durLabel(30 * 60_000), '30m');
  assert.equal(durLabel(59 * 60_000), '59m');
  assert.equal(durLabel(62 * 60_000), '1h 02m');
  assert.equal(durLabel(95 * 60_000), '1h 35m');
  assert.equal(durLabel(120 * 60_000), '2h 00m');
  assert.equal(durLabel(0), '1m');
  assert.equal(setCountLabel(0), '0 sets');
  assert.equal(setCountLabel(1), '1 set');
  assert.equal(setCountLabel(12), '12 sets');
});

// The day is the title above this line, so the meta never repeats it: when it ran, how long it
// took, how much is in it. An open session is not given an end time it does not have.
test('sessionMetaLabel — a session read whole, without printing its day twice', () => {
  const started = new Date(2025, 6, 22, 18, 12).getTime();
  const finished = new Date(2025, 6, 22, 19, 34).getTime();
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: finished }, 13),
    '18:12–19:34   ·   1h 22m   ·   13 sets',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: started + 600_000 }, 1),
    '18:12–18:22   ·   10m   ·   1 set',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: null }, 4),
    '18:12   ·   in progress   ·   4 sets',
  );
  assert.equal(
    sessionMetaLabel({ startedAt: started, finishedAt: finished }, 0),
    '18:12–19:34   ·   1h 22m   ·   0 sets',
  );
});

test('screenOf — one grammar decides which of the nine rooms a hash names', () => {
  assert.equal(screenOf('#/gym'), 'today');
  assert.equal(screenOf('#/gym/'), 'today');
  assert.equal(screenOf('#/gym/log'), 'log');
  assert.equal(screenOf('#/gym/log?page=2'), 'log');
  assert.equal(screenOf('#/gym/session/ses_9f3a1c22'), 'session');
  assert.equal(screenOf('#/gym/finish/ses_9f3a1c22'), 'finish');
  assert.equal(screenOf('#/gym/backfill'), 'backfill');
  assert.equal(screenOf('#/gym/routines'), 'routines');
  assert.equal(screenOf('#/gym/routines/'), 'routines');
  assert.equal(screenOf('#/gym/routines?new=1'), 'routines');
  assert.equal(screenOf('#/gym/routines/rt_9f2c'), 'routine');
  assert.equal(screenOf(routineHref(NEW_ROUTINE_ID)), 'routine');
  assert.equal(screenOf(STATS_HREF), 'stats');
  assert.equal(screenOf('#/gym/stats'), 'stats');
  assert.equal(screenOf('#/gym/stats?movement=bench-press'), 'stats');
  assert.equal(screenOf(''), 'today');
  // A hash this build does not know is a link from a build that did, and Today is where a lifter
  // can get anywhere from — never a blank screen with a working URL in the bar.
  assert.equal(screenOf('#/gym/strength-tree'), 'today');
});

// THE ONE ROOM THAT IS NOT THE LIFTER'S. It has to be recognised before anything that could send a
// visitor at the sign-in door, because the token IS the credential and a coach has no account —
// GymApp answers this branch above the auth switch entirely, and this is the parse under it.
test('sharedTokenOf — the coach’s link carries a whole base64url token, and only that shape', () => {
  const token = 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0';
  assert.equal(screenOf(sharedHref(token)), 'shared');
  assert.equal(sharedTokenOf(sharedHref(token)), token);
  assert.equal(sharedHref(token), `#/gym/shared/${token}`);
  // The mint's alphabet, whole: 32 bytes of entropy, base64url, unpadded — so '-' and '_' are
  // ordinary characters in it and a parse that stopped at either would truncate the credential.
  assert.equal(sharedTokenOf('#/gym/shared/a-b_c'), 'a-b_c');
  assert.equal(sharedTokenOf('#/gym/shared/'), null);
  assert.equal(sharedTokenOf('#/gym/session/ses_9f3a1c22'), null);
  assert.equal(sharedTokenOf('#/gym'), null);
  assert.equal(sharedTokenOf(''), null);
  assert.equal(sharedTokenOf(undefined), null);
});

test('routineIdOf — the editor link the routines list writes is the link it reads back', () => {
  assert.equal(routineIdOf('#/gym/routines/rt_9f2c1a04'), 'rt_9f2c1a04');
  assert.equal(routineHref('rt_9f2c1a04'), '#/gym/routines/rt_9f2c1a04');
  assert.equal(routineIdOf(routineHref('rt_9f2c1a04')), 'rt_9f2c1a04');
  assert.equal(routineIdOf(ROUTINES_HREF), null);
  assert.equal(routineIdOf('#/gym/routines/'), null);
  assert.equal(routineIdOf('#/gym/session/ses_9f3a1c22'), null);
  assert.equal(routineIdOf(''), null);
  assert.equal(routineIdOf(undefined), null);
});

test('finishIdOf — the end of a session is a place, so a reload lands back on it', () => {
  assert.equal(finishIdOf('#/gym/finish/ses_9f3a1c22'), 'ses_9f3a1c22');
  assert.equal(finishHref('ses_9f3a1c22'), '#/gym/finish/ses_9f3a1c22');
  assert.equal(finishIdOf(finishHref('ses_9f3a1c22')), 'ses_9f3a1c22');
  assert.equal(finishIdOf(sessionHref('ses_9f3a1c22')), null);
  assert.equal(finishIdOf(BACKFILL_HREF), null);
  assert.equal(finishIdOf('#/gym/finish/'), null);
  assert.equal(finishIdOf(''), null);
  assert.equal(finishIdOf(undefined), null);
});

// The one id a mint can never produce, so the blank editor survives a reload without asking the
// store for a routine nobody has saved.
test('NEW_ROUTINE_ID — a routine being written for the first time stands at the editor URL', () => {
  assert.equal(routineIdOf(routineHref(NEW_ROUTINE_ID)), NEW_ROUTINE_ID);
  assert.notEqual(NEW_ROUTINE_ID.slice(0, 3), 'rt_');
});

// The target reads the same in the editor, on Today's card and on the finish screen's offer. A
// weight it does not ask for is "whatever you did last time" and prints nothing — and neither does
// a load of zero, which is the absence of one rather than a number.
// A REP target it does not ask for is canon screen 6's `3 × max`, a movement taken to whatever it
// gives that day — spelled by omission on the wire, exactly like the load.
test('entryLabel — what a routine asks a movement for, and the two targets it may decline to set', () => {
  assert.equal(entryLabel({ exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }), '5 × 5 · 82.5');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8, targetWeightKg: 0 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'pull-up', targetSets: 4, targetReps: 6, targetWeightKg: -20 }), '4 × 6 · −20');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3 }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: null }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'dip', targetSets: 3, targetWeightKg: 20 }), '3 × max · 20');
});

// "Your first session" is a claim about the LIST, and one other finished session refutes it.
test('isFirstSession — the session being asked about never counts as its own predecessor', () => {
  const session = (id, finishedAt) => ({ id, startedAt: 1, finishedAt });
  assert.equal(isFirstSession([session('ses_1', 2)], 'ses_1'), true);
  assert.equal(isFirstSession([], 'ses_1'), true);
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_0', 2)], 'ses_1'), false);
  // An open session is not a session that happened yet — a backfill door left ajar must not make
  // the first workout somebody ever logged read as their second.
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_2', null)], 'ses_1'), true);
});

test('weekdayName — the day a session happened, as the opening value in the name field', () => {
  assert.equal(weekdayName(new Date(2026, 7, 4, 18, 12).getTime()), 'Tuesday');
  assert.equal(weekdayName(new Date(2026, 7, 9, 7, 40).getTime()), 'Sunday');
});

// The row says the same fact the list is sorted by, so it never has to explain its own order.
test('routineMetaLabel — what a routine holds, and when it was last used', () => {
  const now = new Date(2026, 7, 4, 9, 41).getTime();
  const entries = (count) => Array.from({ length: count }, (each, index) => ({ position: index + 1 }));
  assert.equal(
    routineMetaLabel({ entries: entries(6), lastTrainedAt: now - 5 * 86_400_000 }, now),
    '6 exercises · trained 5 days ago',
  );
  assert.equal(
    routineMetaLabel({ entries: entries(1), lastTrainedAt: now - 86_400_000 }, now),
    '1 exercise · trained yesterday',
  );
  assert.equal(routineMetaLabel({ entries: entries(4), lastTrainedAt: now }, now), '4 exercises · trained today');
  assert.equal(routineMetaLabel({ entries: entries(5) }, now), '5 exercises · never trained');
  assert.equal(routineMetaLabel({ entries: [] }, now), '0 exercises · never trained');
});

// ONE WORD FOR WHAT COUNTS, and every surface that counts anything reads it: the plan counter, the
// carry-forward, the top set and the routine composed from a session. A drop and a failure count
// toward nothing, exactly as the domain's record rules read them — the logger's own counter filtered
// only warmups, so a drop advanced "set 4 of 5" while counting toward no record anywhere else.
test('workingSetsOf — only a working set counts, and the other three kinds count toward nothing', () => {
  const set = (exerciseId, weightKg, reps, kind) => ({ exerciseId, weightKg, reps, kind, completedAt: 0 });
  const sets = [
    set('back-squat', 60, 5, 'warmup'),
    set('back-squat', 100, 5, 'working'),
    set('back-squat', 90, 3, 'drop'),
    set('back-squat', 100, 1, 'failure'),
    set('bench-press', 80, 5, 'working'),
  ];
  assert.deepEqual(workingSetsOf(sets), [sets[1], sets[4]]);
  assert.deepEqual(workingSetsOf(sets, 'back-squat'), [sets[1]]);
  assert.deepEqual(workingSetsOf(sets, 'bench-press'), [sets[4]]);
  assert.deepEqual(workingSetsOf(sets, 'deadlift'), []);
  assert.deepEqual(workingSetsOf([sets[0], sets[2], sets[3]]), []);
});

// Never volume: four light sets must not beat three heavy ones, here or anywhere else in gym.
test('topSetOf — the heaviest working set, from the sets or from the summary that carries it', () => {
  const set = (weightKg, reps, kind) => ({ exerciseId: 'back-squat', weightKg, reps, kind, completedAt: 0 });
  const label = (sets) => topSetLabel(topSetOf({ id: 'ses_1' }, sets));
  assert.equal(label([set(100, 5, 'working'), set(102.5, 5, 'working'), set(100, 8, 'working')]), '102.5 × 5');
  assert.equal(label([set(60, 5, 'warmup'), set(120, 1, 'warmup'), set(100, 5, 'working')]), '100 × 5');
  assert.equal(label([set(100, 5, 'working'), set(140, 3, 'drop'), set(140, 1, 'failure')]), '100 × 5');
  // A tie on the load goes to the set that got more reps out of it.
  assert.equal(label([set(100, 5, 'working'), set(100, 8, 'working')]), '100 × 8');
  assert.equal(label([set(0, 12, 'working'), set(-20, 8, 'working')]), '0 × 12');
  assert.equal(label([set(60, 10, 'warmup')]), '—');
  assert.equal(label([]), '—');

  // A row in the LIST carries no sets, so the store hands it the same pick under `topSet` — the
  // column G8 draws had nothing behind it until the summary carried one, and a top set derived
  // from a set COUNT would have been a number nobody lifted.
  const row = { id: 'ses_1', setCount: 14, topSet: { weightKg: 102.5, reps: 5 } };
  assert.deepEqual(topSetOf(row), { weightKg: 102.5, reps: 5 });
  assert.equal(topSetLabel(topSetOf(row)), '102.5 × 5');
  // A session holding no working set has no top set at all — omitted on the wire, and nothing here.
  assert.equal(topSetOf({ id: 'ses_1', setCount: 2 }), null);
  assert.equal(topSetLabel(topSetOf({ id: 'ses_1', setCount: 2 })), '—');
  assert.equal(topSetLabel(null), '—');
});

// The wire carries no flag for the four-hour close, so the fingerprint is the end instant itself.
test('closedOnItsOwn — an end nobody pressed is one stamped at the last thing that happened', () => {
  const startedAt = 1_900_000_000_000;
  const sets = [
    { id: 'set_1', weightKg: 100, reps: 5, completedAt: startedAt + 600_000 },
    { id: 'set_2', weightKg: 100, reps: 5, completedAt: startedAt + 900_000 },
  ];
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }, sets), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_001 }, sets), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 3_600_000 }, sets), false);
  // A session that never got a set ended when it began.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt }, []), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000 }, []), false);
  // Still running is not closed at all, whoever would have closed it.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: null }, sets), false);
  assert.equal(CLOSED_ITSELF_NOTE, 'closed on its own — no set for four hours');

  // A row in the LIST carries no sets either, so the store answers the same question under
  // `closedItself` — the note G8 draws on the row had nothing behind it until it did.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000, closedItself: true }), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000, closedItself: false }), false);
  // With neither the flag nor the sets there is nothing to read it off, and silence is the answer.
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }), false);
});

// THE SESSION CLOCK IS DERIVED. It is a function of (now − startedAt) and of nothing else, which is
// why the number below survives a locked phone: a counter would have stopped with the beats.
test('clockOf — the clock is computed from the start instant, never accumulated', () => {
  const startedAt = 1_900_000_000_000;
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(9_000), '0:09');
  assert.equal(clockOf(24 * 60_000 + 18_000), '24:18');
  assert.equal(clockOf(60 * 60_000), '1:00:00');
  assert.equal(clockOf(3_600_000 + 2 * 60_000 + 7_000), '1:02:07');
  assert.equal(clockOf(-5_000), '0:00');

  // Three beats, then the phone locks for an hour. A counter shows what it managed to add up;
  // the log shows what actually elapsed.
  let counted = 0;
  for (let beat = 0; beat < 3; beat += 1) counted += 500;
  const wokeAt = startedAt + 3_600_000 + 1_500;
  assert.equal(clockOf(counted), '0:01');
  assert.equal(clockOf(wokeAt - startedAt), '1:00:01');
});

test('fmt — trailing zeros stripped, a real minus, and a negative load is an ordinary number', () => {
  assert.equal(fmt(102.5), '102.5');
  assert.equal(fmt(100), '100');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(-20), '−20');
  assert.equal(fmt(-2.25), '−2.25');
  assert.equal(fmt(102.505), '102.51');
  assert.equal(fmt(-20).charCodeAt(0), 0x2212);
});

test('dayLabel, timeLabel and agoLabel — the labels a lifter judges relevance by', () => {
  const wednesday = new Date(2026, 6, 22, 18, 12).getTime();
  assert.equal(dayLabel(wednesday), 'Wed 22 Jul');
  assert.equal(dayLabel(new Date(2026, 0, 4, 9, 5).getTime()), 'Sun 4 Jan');
  assert.equal(timeLabel(wednesday), '18:12');
  assert.equal(timeLabel(new Date(2026, 6, 22, 9, 5).getTime()), '09:05');
  assert.equal(agoLabel(wednesday, wednesday), 'today');
  assert.equal(agoLabel(wednesday, wednesday + 86_400_000), 'yesterday');
  assert.equal(agoLabel(wednesday, wednesday + 4 * 86_400_000), '4 days ago');
  assert.equal(agoLabel(wednesday, wednesday - 86_400_000), 'today');
});

// TWO SPELLINGS, ONE VOCABULARY. Every date in gym but one is an instant a lifter stood in and is
// read in the zone they were standing in. The one exception is a statistics week: it arrives as the
// start of a `date_trunc('week', … AT TIME ZONE 'UTC')` bucket, which is a UTC Monday midnight and
// no moment anybody trained in — read locally it is the Sunday evening before, for everybody west
// of Greenwich. Both spellings come off the same tables, which is why they live side by side.
test('utcDayLabel — a week bucket is named by its UTC day, wherever it is read from', () => {
  const bucket = Date.UTC(2026, 6, 6);
  const zone = process.env.TZ;
  try {
    for (const where of ['America/Los_Angeles', 'UTC', 'Pacific/Auckland']) {
      process.env.TZ = where;
      assert.equal(utcDayLabel(bucket), 'Mon 6 Jul');
      assert.equal(utcDayLabel(Date.UTC(2026, 0, 4, 23, 59)), 'Sun 4 Jan');
    }
    // And the local spelling stays genuinely local — this is the disagreement, and it is the reason
    // the statistics weeks may not read it.
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(dayLabel(bucket), 'Sun 5 Jul');
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(dayLabel(bucket), 'Mon 6 Jul');
  } finally {
    if (zone == null) delete process.env.TZ; else process.env.TZ = zone;
  }
});

// "Yesterday" is a claim about the CALENDAR. Rounding elapsed hours told a lifter who trained at
// 07:00 that they had trained yesterday by 21:00 the same day — and the routines row prints no date
// beside it for anybody to correct against.
test('agoLabel — the day is counted from midnight, not from a rounded number of hours', () => {
  const morning = new Date(2026, 6, 22, 7, 0).getTime();
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 21, 0).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 23, 59).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 23, 0, 1).getTime()), 'yesterday');
  // And the other way: eleven hours can already be yesterday, when a midnight sits between them.
  const lateNight = new Date(2026, 6, 22, 23, 0).getTime();
  assert.equal(agoLabel(lateNight, new Date(2026, 6, 23, 10, 0).getTime()), 'yesterday');
  assert.equal(agoLabel(new Date(2026, 6, 18, 23, 0).getTime(), new Date(2026, 6, 22, 6, 0).getTime()), '4 days ago');
});

// One word for a session nobody planned, wherever it is named: the row, the detail, the review
// subtitle, the overlap panel and the mirror's head. "Ad-hoc" was retired for the same session.
test('NO_ROUTINE — the one word for a session with no routine', () => {
  assert.equal(NO_ROUTINE, 'No routine');
});

test('planOf — the frozen snapshot, parsed once for every surface that reads it', () => {
  const plan = { routine: 'Squat day', entries: [{ exerciseId: 'back-squat', sets: 5, reps: 5, weightKg: 102.5 }] };
  assert.deepEqual(planOf({ plan }), plan);
  assert.deepEqual(planOf({ plan: JSON.stringify(plan) }), plan);
  assert.equal(planOf({ plan: 'not json at all' }), null);
  assert.equal(planOf({ plan: null }), null);
  assert.equal(planOf({}), null);
  assert.equal(planOf(null), null);
});
