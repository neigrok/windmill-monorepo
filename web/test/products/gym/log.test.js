import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agoLabel, alsoReadsLabel, arrivedLabel, BACKFILL_HREF, COACH_HREF, clockOf, CLOSED_ITSELF_NOTE,
  closedOnItsOwn,
  CONNECT_HREF,
  dayLabel,
  durLabel, e1rmLabel, entryLabel, finishHref, finishIdOf, firstSessionLabel, fmt, fmtKg,
  groupByExercise,
  hasRecord, isFinished, isFirstSession, isNameOverCap, isUntested, loadedLine, logWhenLabel,
  MOVEMENTS_HREF,
  movementIdOf, movementOf, NAME_COUNT_FROM, NAME_MAX, nameCountLabel, NOTES_HREF,
  nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE, NOT_IN_PLAN, numberWord, onThisDevice, OPEN_TARGET,
  planFrozenLabel,
  BODYWEIGHT_HREF, planOf, planReadingOf, proposalHref, proposalIdOf,
  recordHref, routineHref, routineIdOf, routineMetaLabel, routineNameOf, ROUTINES_HREF, screenOf, showsNameCount,
  sessionDetailMeta, sessionHref, sessionIdOf, sessionMetaLabel, setCountLabel, setLoadLabel,
  setNoteOf, sharedHref, sharedTokenOf, shortDayLabel, timeLabel, tonnageLabel, tonnageOf,
  threadHref, threadIdOf, THREADS_HREF,
  topSetLabel, topSetOf, UNTESTED, weekdayName, weeksOf, whenLabel, workingLabel, workingSetsOf,
} from '../../../src/products/gym/log.js';
import { KG, LB, spellWeightsIn } from '../../../src/products/gym/units.js';

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

test('screenOf — one grammar decides which of the fifteen rooms a hash names, and #/gym is the routines home', () => {
  assert.equal(ROUTINES_HREF, '#/gym');
  assert.equal(BODYWEIGHT_HREF, '#/gym/bodyweight');
  assert.equal(screenOf(BODYWEIGHT_HREF), 'bodyweight');
  assert.equal(screenOf('#/gym/bodyweight/'), 'bodyweight');
  assert.equal(screenOf('#/gym/bodyweight?window=all'), 'bodyweight');
  assert.equal(screenOf('#/gym'), 'routines');
  assert.equal(screenOf('#/gym/'), 'routines');
  assert.equal(screenOf('#/gym/log'), 'log');
  assert.equal(screenOf('#/gym/log?page=2'), 'log');
  assert.equal(screenOf('#/gym/session/ses_9f3a1c22'), 'session');
  assert.equal(screenOf('#/gym/finish/ses_9f3a1c22'), 'finish');
  assert.equal(screenOf('#/gym/backfill'), 'backfill');
  assert.equal(screenOf('#/gym/routines'), 'routines');
  assert.equal(screenOf('#/gym/routines/'), 'routines');
  assert.equal(screenOf('#/gym/routines?new=1'), 'routines');
  assert.equal(screenOf('#/gym/routines/rt_9f2c'), 'routine');
  assert.equal(screenOf('#/gym/proposals/prop_2f9c40a1'), 'proposal');
  assert.equal(COACH_HREF, '#/gym/coach');
  assert.equal(screenOf(COACH_HREF), 'coach');
  assert.equal(screenOf('#/gym/coach/'), 'coach');
  assert.equal(screenOf('#/gym/coach?from=proposal'), 'coach');
  assert.equal(THREADS_HREF, '#/gym/coach/threads');
  assert.equal(screenOf(THREADS_HREF), 'threads');
  assert.equal(screenOf('#/gym/coach/threads/'), 'threads');
  assert.equal(screenOf('#/gym/coach/threads?from=routine'), 'threads');
  assert.equal(screenOf(threadHref('thr_0a1b2c3d4e5f6071')), 'thread');
  assert.equal(threadIdOf(threadHref('thr_0a1b2c3d4e5f6071')), 'thr_0a1b2c3d4e5f6071');
  assert.equal(threadHref('thr_1'), '#/gym/coach/threads/thr_1');
  assert.equal(NOTES_HREF, '#/gym/notes');
  assert.equal(screenOf(NOTES_HREF), 'notes');
  assert.equal(screenOf('#/gym/notes/'), 'notes');
  assert.equal(threadIdOf('#/gym/ask/threads/A-b_9'), 'A-b_9');
  assert.equal(threadIdOf(THREADS_HREF), null);
  assert.equal(threadIdOf('#/gym/ask'), null);
  assert.equal(screenOf(CONNECT_HREF), 'connect');
  assert.equal(screenOf('#/gym/connect'), 'connect');
  assert.equal(screenOf('#/gym/connect/'), 'connect');
  assert.equal(screenOf('#/gym/connect?from=routines'), 'connect');
  assert.equal(screenOf(routineHref(NEW_ROUTINE_ID)), 'routine');
  assert.equal(screenOf(MOVEMENTS_HREF), 'record');
  assert.equal(screenOf(recordHref('back-squat')), 'record');
  assert.equal(screenOf('#/gym/stats'), 'record');
  assert.equal(screenOf('#/gym/stats?movement=bench-press'), 'record');
  assert.equal(screenOf(''), 'routines');
  assert.equal(screenOf('#/gym/strength-tree'), 'routines');
  assert.equal(screenOf('#/gym/today'), 'routines');
});

test('screenOf — the older spellings still resolve to the same screens, and are never written', () => {
  assert.equal(screenOf('#/gym/routines'), 'routines');
  assert.equal(screenOf('#/gym/routines/'), 'routines');
  assert.equal(screenOf('#/gym/ask'), 'coach');
  assert.equal(screenOf('#/gym/ask/'), 'coach');
  assert.equal(screenOf('#/gym/ask?from=proposal'), 'coach');
  assert.equal(screenOf('#/gym/ask/threads'), 'threads');
  assert.equal(screenOf('#/gym/ask/threads/thr_0a1b2c3d4e5f6071'), 'thread');
  assert.equal(threadIdOf('#/gym/ask/threads/thr_0a1b2c3d4e5f6071'), 'thr_0a1b2c3d4e5f6071');
  for (const written of [ROUTINES_HREF, COACH_HREF, THREADS_HREF, threadHref('thr_1'), NOTES_HREF]) {
    assert.equal(written.includes('/ask'), false, written);
    assert.equal(written.includes('/today'), false, written);
  }
});

test('sharedTokenOf — the share link carries a whole base64url token, and only that shape', () => {
  const token = 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0';
  assert.equal(screenOf(sharedHref(token)), 'shared');
  assert.equal(sharedTokenOf(sharedHref(token)), token);
  assert.equal(sharedHref(token), `#/gym/shared/${token}`);
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

test('movementIdOf — the record link a name writes is the link the record reads back', () => {
  assert.equal(recordHref('back-squat'), '#/gym/movement/back-squat');
  assert.equal(movementIdOf(recordHref('back-squat')), 'back-squat');
  assert.equal(movementIdOf(recordHref('ex_31ab77c0')), 'ex_31ab77c0');
  assert.equal(MOVEMENTS_HREF, '#/gym/movement');
  assert.equal(movementIdOf(MOVEMENTS_HREF), null);
  assert.equal(movementIdOf('#/gym/movement/'), null);
  assert.equal(movementIdOf('#/gym/stats'), null);
  assert.equal(movementIdOf(sessionHref('ses_9f3a1c22')), null);
  assert.equal(movementIdOf(''), null);
  assert.equal(movementIdOf(undefined), null);
});

test('proposalIdOf — the deep link an agent’s receipt hands out is the link this app reads back', () => {
  assert.equal(proposalHref('prop_2f9c40a1'), '#/gym/proposals/prop_2f9c40a1');
  assert.equal(proposalIdOf(proposalHref('prop_2f9c40a1')), 'prop_2f9c40a1');
  assert.equal(proposalIdOf('#/gym/proposals/a-b_c9'), 'a-b_c9');
  assert.equal(screenOf(proposalHref('prop_2f9c40a1')), 'proposal');
  assert.equal(proposalIdOf(ROUTINES_HREF), null);
  assert.equal(proposalIdOf(routineHref('rt_9f2c1a04')), null);
  assert.equal(routineIdOf(proposalHref('prop_2f9c40a1')), null);
  assert.equal(proposalIdOf('#/gym/proposals'), null);
  assert.equal(proposalIdOf('#/gym/proposals/'), null);
  assert.equal(proposalIdOf(''), null);
  assert.equal(proposalIdOf(undefined), null);
});

test('NEW_ROUTINE_ID — a routine being written for the first time stands at the editor URL', () => {
  assert.equal(routineIdOf(routineHref(NEW_ROUTINE_ID)), NEW_ROUTINE_ID);
  assert.notEqual(NEW_ROUTINE_ID.slice(0, 3), 'rt_');
});

test('entryLabel — what a routine asks a movement for, and the two targets it may decline to set', () => {
  assert.equal(entryLabel({ exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }), '5 × 5 · 82.5');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: 8, targetWeightKg: 0 }), '3 × 8');
  assert.equal(entryLabel({ exerciseId: 'pull-up', targetSets: 4, targetReps: 6, targetWeightKg: -20 }), '4 × 6 · −20');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3 }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'chin-up', targetSets: 3, targetReps: null }), '3 × max');
  assert.equal(entryLabel({ exerciseId: 'dip', targetSets: 3, targetWeightKg: 20 }), '3 × max · 20');
});

test('entryLabel — a line with no set target is open, whatever else is on it', () => {
  assert.equal(entryLabel({ exerciseId: 'barbell-row' }), 'open');
  assert.equal(entryLabel({ exerciseId: 'barbell-row', targetSets: null }), 'open');
  assert.equal(entryLabel({ exerciseId: 'barbell-row', restSeconds: 120 }), 'open');
  assert.equal(entryLabel({ exerciseId: 'barbell-row', targetReps: 5, targetWeightKg: 70 }), 'open');
  assert.equal(OPEN_TARGET, 'open');
  assert.equal(entryLabel({ exerciseId: 'barbell-row', targetSets: 0, targetReps: 5 }), '0 × 5');
});

test('the name cap is one number, under the store’s own, and the counter counts the field', () => {
  assert.equal(NAME_MAX, 60);
  assert.equal(nameCountLabel(''), '0/60');
  assert.equal(nameCountLabel('Heavy Thursday'), '14/60');
  assert.equal(nameCountLabel('  '), '2/60');
  assert.equal(nameCountLabel(undefined), '0/60');
  assert.equal(nameCountLabel('P'.repeat(NAME_MAX)), '60/60');

  assert.equal(isNameOverCap('P'.repeat(NAME_MAX)), false);
  assert.equal(isNameOverCap('P'.repeat(NAME_MAX + 10)), true);
  assert.equal(nameCountLabel('P'.repeat(NAME_MAX + 10)), '70/60');
  assert.equal(isNameOverCap(''), false);
  assert.equal(isNameOverCap(undefined), false);
});

test('the name counter is drawn from the last fifth only, and the threshold is named once', () => {
  assert.equal(NAME_COUNT_FROM, 48);
  assert.equal(showsNameCount(''), false);
  assert.equal(showsNameCount(undefined), false);
  assert.equal(showsNameCount('P'.repeat(47)), false);
  assert.equal(showsNameCount('P'.repeat(48)), true);
  assert.equal(showsNameCount('P'.repeat(NAME_MAX + 10)), true);
});

test('movementOf — the catalog row, and the name is the one field read off it', () => {
  const catalog = [
    { id: 'back-squat', name: 'Back Squat', custom: false },
    { id: 'ex_31ab', name: 'Hammer row', custom: true },
  ];
  assert.deepEqual(movementOf(catalog, 'ex_31ab'), catalog[1]);
  assert.equal(movementOf(catalog, 'deadlift'), null);
  assert.equal(movementOf(null, 'deadlift'), null);
  assert.equal(nameOfMovement(catalog, 'ex_31ab'), 'Hammer row');
  assert.equal(nameOfMovement(catalog, 'deadlift'), 'deadlift');
});

test('isFirstSession — the session being asked about never counts as its own predecessor', () => {
  const session = (id, finishedAt) => ({ id, startedAt: 1, finishedAt });
  assert.equal(isFirstSession([session('ses_1', 2)], 'ses_1'), true);
  assert.equal(isFirstSession([], 'ses_1'), true);
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_0', 2)], 'ses_1'), false);
  assert.equal(isFirstSession([session('ses_1', 2), session('ses_2', null)], 'ses_1'), true);
});

test('weekdayName — the day a session happened, as the opening value in the name field', () => {
  assert.equal(weekdayName(new Date(2026, 7, 4, 18, 12).getTime()), 'Tuesday');
  assert.equal(weekdayName(new Date(2026, 7, 9, 7, 40).getTime()), 'Sunday');
});

test('routineMetaLabel — what a routine holds, and when it was last used', () => {
  const now = new Date(2026, 7, 4, 9, 41).getTime();
  const entries = (count) => Array.from({ length: count }, (each, index) => ({ position: index + 1 }));
  assert.equal(
    routineMetaLabel({ entries: entries(6), lastTrainedAt: now - 5 * 86_400_000 }, now),
    '6 movements · trained 5 days ago',
  );
  assert.equal(
    routineMetaLabel({ entries: entries(1), lastTrainedAt: now - 86_400_000 }, now),
    '1 movement · trained yesterday',
  );
  assert.equal(routineMetaLabel({ entries: entries(4), lastTrainedAt: now }, now), '4 movements · trained today');
  assert.equal(routineMetaLabel({ entries: entries(5) }, now), '5 movements · untested');
  assert.equal(routineMetaLabel({ entries: [] }, now), '0 movements · untested');
  assert.equal(UNTESTED, 'untested');
  assert.equal(isUntested({ entries: [] }), true);
  assert.equal(isUntested({ entries: [], lastTrainedAt: now }), false);
  assert.equal(isUntested({ entries: [], lastTrainedAt: 0 }), false);
  assert.equal(isUntested(null), true);
});

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

test('topSetOf — the heaviest working set, from the sets or from the summary that carries it', () => {
  const set = (weightKg, reps, kind) => ({ exerciseId: 'back-squat', weightKg, reps, kind, completedAt: 0 });
  const label = (sets) => topSetLabel(topSetOf({ id: 'ses_1' }, sets));
  assert.equal(label([set(100, 5, 'working'), set(102.5, 5, 'working'), set(100, 8, 'working')]), '102.5 × 5');
  assert.equal(label([set(60, 5, 'warmup'), set(120, 1, 'warmup'), set(100, 5, 'working')]), '100 × 5');
  assert.equal(label([set(100, 5, 'working'), set(140, 3, 'drop'), set(140, 1, 'failure')]), '100 × 5');
  assert.equal(label([set(100, 5, 'working'), set(100, 8, 'working')]), '100 × 8');
  assert.equal(label([set(0, 12, 'working'), set(-20, 8, 'working')]), '0 × 12');
  assert.equal(label([set(60, 10, 'warmup')]), '—');
  assert.equal(label([]), '—');

  const row = { id: 'ses_1', setCount: 14, topSet: { weightKg: 102.5, reps: 5 } };
  assert.deepEqual(topSetOf(row), { weightKg: 102.5, reps: 5 });
  assert.equal(topSetLabel(topSetOf(row)), '102.5 × 5');
  assert.equal(topSetOf({ id: 'ses_1', setCount: 2 }), null);
  assert.equal(topSetLabel(topSetOf({ id: 'ses_1', setCount: 2 })), '—');
  assert.equal(topSetLabel(null), '—');
});

test('closedOnItsOwn — an end nobody pressed is one stamped at the last thing that happened', () => {
  const startedAt = 1_900_000_000_000;
  const sets = [
    { id: 'set_1', weightKg: 100, reps: 5, completedAt: startedAt + 600_000 },
    { id: 'set_2', weightKg: 100, reps: 5, completedAt: startedAt + 900_000 },
  ];
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }, sets), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_001 }, sets), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 3_600_000 }, sets), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt }, []), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000 }, []), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: null }, sets), false);
  assert.equal(CLOSED_ITSELF_NOTE, 'closed on its own — no set for four hours');

  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 60_000, closedItself: true }), true);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000, closedItself: false }), false);
  assert.equal(closedOnItsOwn({ startedAt, finishedAt: startedAt + 900_000 }), false);
});

test('clockOf — the clock is computed from the start instant, never accumulated', () => {
  const startedAt = 1_900_000_000_000;
  assert.equal(clockOf(0), '0:00');
  assert.equal(clockOf(9_000), '0:09');
  assert.equal(clockOf(24 * 60_000 + 18_000), '24:18');
  assert.equal(clockOf(60 * 60_000), '1:00:00');
  assert.equal(clockOf(3_600_000 + 2 * 60_000 + 7_000), '1:02:07');
  assert.equal(clockOf(-5_000), '0:00');

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

test('fmt spells the account’s unit, and fmtKg spells the one the store holds', (t) => {
  t.after(() => spellWeightsIn(KG));
  spellWeightsIn(LB);

  assert.equal(fmt(102.5), '226');
  assert.equal(fmt(100), '220.5');
  assert.equal(fmt(-20), '−44.1');
  assert.equal(fmt(0), '0');
  assert.equal(fmtKg(102.5), '102.5');
  assert.equal(fmtKg(-20), '−20');
  assert.equal(fmtKg(1.25), '1.25');

  assert.equal(setLoadLabel({ weightKg: 102.5, reps: 5 }), '226 × 5');
  assert.equal(topSetLabel({ weightKg: 100, reps: 3 }), '220.5 × 3');
  assert.equal(entryLabel({ targetSets: 5, targetReps: 5, targetWeightKg: 102.5 }), '5 × 5 · 226');
});

test('a kilogram field over a pounds reading says what the other numeral is', (t) => {
  t.after(() => spellWeightsIn(KG));

  assert.equal(alsoReadsLabel(100), null);
  assert.equal(alsoReadsLabel(null), null);

  spellWeightsIn(LB);
  assert.equal(alsoReadsLabel(100), 'reads 220.5 lb in your log');
  assert.equal(alsoReadsLabel(102.5), 'reads 226 lb in your log');
  assert.equal(alsoReadsLabel(-20), 'reads −44.1 lb in your log');
  assert.equal(alsoReadsLabel(null), null);
  assert.equal(alsoReadsLabel(undefined), null);
});

test('the scale of a week follows the reading, and switches at the same mass either way', (t) => {
  t.after(() => spellWeightsIn(KG));
  spellWeightsIn(LB);

  assert.equal(tonnageLabel(999), '2202.4 lb');
  assert.equal(tonnageLabel(1000), '2.2k lb');
  assert.equal(tonnageLabel(14_200), '31.3k lb');
  assert.equal(tonnageLabel(0), null);
  assert.equal(tonnageLabel(null), null);
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

test('arrivedLabel — the weekday and the hour, until a weekday stops naming one day', () => {
  const sunday = new Date(2026, 7, 2, 21, 14).getTime();
  assert.equal(arrivedLabel(sunday, sunday), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 10 * 60 * 60 * 1000), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 5 * 86_400_000), 'Sun 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 6 * 86_400_000), 'Sun 2 Aug · 21:14');
  assert.equal(arrivedLabel(sunday, sunday + 30 * 86_400_000), 'Sun 2 Aug · 21:14');
  assert.equal(whenLabel(sunday), 'Sun 2 Aug · 21:14');
});

test('numberWord — a small count spelled, and a large one left as a numeral', () => {
  assert.equal(numberWord(1), 'one');
  assert.equal(numberWord(4), 'four');
  assert.equal(numberWord(10), 'ten');
  assert.equal(numberWord(11), '11');
  assert.equal(numberWord(0), 'zero');
});

test('shortDayLabel — a day named by its date alone, in the zone the session happened in', () => {
  const wednesday = new Date(2026, 6, 22, 18, 12).getTime();
  assert.equal(shortDayLabel(wednesday), '22 Jul');
  assert.equal(dayLabel(wednesday), 'Wed 22 Jul');
  assert.equal(shortDayLabel(new Date(2026, 0, 1, 0, 0).getTime()), '1 Jan');
  assert.equal(shortDayLabel(new Date(2026, 11, 31, 23, 59).getTime()), '31 Dec');
});

test('agoLabel — the day is counted from midnight, not from a rounded number of hours', () => {
  const morning = new Date(2026, 6, 22, 7, 0).getTime();
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 21, 0).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 22, 23, 59).getTime()), 'today');
  assert.equal(agoLabel(morning, new Date(2026, 6, 23, 0, 1).getTime()), 'yesterday');
  const lateNight = new Date(2026, 6, 22, 23, 0).getTime();
  assert.equal(agoLabel(lateNight, new Date(2026, 6, 23, 10, 0).getTime()), 'yesterday');
  assert.equal(agoLabel(new Date(2026, 6, 18, 23, 0).getTime(), new Date(2026, 6, 22, 6, 0).getTime()), '4 days ago');
});

test('NO_ROUTINE — the one phrase for a session with no routine', () => {
  assert.equal(NO_ROUTINE, 'Session · no routine');
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

test('firstSessionLabel — the bottom of the log is the day it started', () => {
  assert.equal(firstSessionLabel(new Date(2026, 4, 6, 7, 30).getTime()), 'first session · 6 May 2026');
  assert.equal(firstSessionLabel(new Date(2024, 11, 31, 23, 59).getTime()), 'first session · 31 Dec 2024');
  assert.equal(firstSessionLabel(new Date(2025, 0, 1, 0, 0).getTime()), 'first session · 1 Jan 2025');
});

test('logWhenLabel — today is a time, everything older is a day, and an open session says so', () => {
  const now = new Date(2026, 7, 10, 20, 15).getTime();
  const today = new Date(2026, 7, 10, 18, 44).getTime();
  const friday = new Date(2026, 7, 7, 9, 5).getTime();
  assert.equal(logWhenLabel({ startedAt: today, finishedAt: today + 3_600_000 }, now), 'today · 18:44');
  assert.equal(logWhenLabel({ startedAt: friday, finishedAt: friday + 3_600_000 }, now), 'Fri 7 Aug');
  assert.equal(logWhenLabel({ startedAt: today, finishedAt: null }, now), 'today · 18:44 · in progress');
  assert.equal(logWhenLabel({ startedAt: friday, finishedAt: null }, now), 'Fri 7 Aug · in progress');
  assert.equal(
    logWhenLabel({ startedAt: today, finishedAt: today + 60_000 }, new Date(2026, 7, 11, 0, 30).getTime()),
    'Mon 10 Aug',
  );
});

test('workingLabel and e1rmLabel — the two facts the wire hands a row', () => {
  assert.equal(workingLabel(11), '11 working');
  assert.equal(workingLabel(1), '1 working');
  assert.equal(workingLabel(0), '0 working');
  assert.equal(e1rmLabel(122.5), 'e1RM 122.5');
  assert.equal(e1rmLabel(84), 'e1RM 84');
  assert.equal(e1rmLabel(null), null);
  assert.equal(e1rmLabel(undefined), null);
});

test('tonnageOf — the store’s sum on a row, the same sum from the sets on a session', () => {
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 5400 }), 5400);
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 0 }), 0);
  assert.equal(tonnageOf({ id: 'ses_1' }), null);
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', 100, 5), set('working', 80, 10)]), 1300);
  assert.equal(
    tonnageOf({ id: 'ses_1' }, [set('warmup', 40, 8), set('working', 100, 5), set('drop', 60, 8), set('failure', 100, 1)]),
    500,
  );
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', -20, 9), set('working', 0, 12)]), 0);
  assert.equal(tonnageOf({ id: 'ses_1' }, [set('working', -20, 9), set('working', 60, 5)]), 300);
  assert.equal(tonnageOf({ id: 'ses_1' }, []), 0);
  assert.equal(tonnageOf({ id: 'ses_1', tonnageKg: 5400 }, [set('working', 100, 5)]), 5400);
});

test('tonnageLabel — a zero says nothing at all, and no figure is ever spelled at a scale that doubles it', () => {
  assert.equal(tonnageLabel(14_200), '14.2 t');
  assert.equal(tonnageLabel(5400), '5.4 t');
  assert.equal(tonnageLabel(1200), '1.2 t');
  assert.equal(tonnageLabel(18_949), '18.9 t');
  assert.equal(tonnageLabel(1000), '1.0 t');
  assert.equal(tonnageLabel(999), '999 kg');
  assert.equal(tonnageLabel(825), '825 kg');
  assert.equal(tonnageLabel(51), '51 kg');
  assert.equal(tonnageLabel(50), '50 kg');
  assert.equal(tonnageLabel(49.5), '49.5 kg');
  assert.equal(tonnageLabel(12), '12 kg');
  assert.equal(tonnageLabel(0), null);
  assert.equal(tonnageLabel(null), null);
  assert.equal(tonnageLabel(undefined), null);
});

test('loadedLine — the head says how much of the log is on the screen', () => {
  assert.equal(loadedLine(41, 12), '41 sessions · 12 weeks loaded');
  assert.equal(loadedLine(1, 1), '1 session · 1 week loaded');
  assert.equal(loadedLine(2, 1), '2 sessions · 1 week loaded');
});

test('onThisDevice — only a session that says so is saved on this device only', () => {
  assert.equal(onThisDevice({ id: 'ses_1', onThisDevice: true }), true);
  assert.equal(onThisDevice({ id: 'ses_1', onThisDevice: false }), false);
  assert.equal(onThisDevice({ id: 'ses_1' }), false);
  assert.equal(onThisDevice(null), false);
});

test('hasRecord — only a session the store says holds a record wears the dot', () => {
  assert.equal(hasRecord({ id: 'ses_1', record: true }), true);
  assert.equal(hasRecord({ id: 'ses_1', record: false }), false);
  assert.equal(hasRecord({ id: 'ses_1' }), false);
  assert.equal(hasRecord(null), false);
});

test('weeksOf — Monday to Monday, newest first, and the oldest week withholds its tonnage', () => {
  const row = (id, at, tonnageKg) => ({ id, startedAt: at.getTime(), tonnageKg });
  const summaries = [
    row('ses_5', new Date(2026, 7, 10, 18, 44), 5400),
    row('ses_4', new Date(2026, 7, 7, 9, 5), 6100),
    row('ses_3', new Date(2026, 7, 5, 18, 0), 9800),
    row('ses_2', new Date(2026, 7, 3, 7, 30), 1200),
    row('ses_1', new Date(2026, 7, 1, 11, 0), 5000),
  ];
  const weeks = weeksOf(summaries);
  assert.deepEqual(weeks.map((week) => week.label), ['week of 10 aug', 'week of 3 aug', 'week of 27 jul']);
  assert.deepEqual(weeks.map((week) => week.tonnage), ['5.4 t', '17.1 t', null]);
  assert.deepEqual(weeks.map((week) => week.sessions.map((session) => session.id)), [
    ['ses_5'], ['ses_4', 'ses_3', 'ses_2'], ['ses_1'],
  ]);
  assert.deepEqual(weeks.map((week) => week.startedAt), [
    new Date(2026, 7, 10).getTime(), new Date(2026, 7, 3).getTime(), new Date(2026, 6, 27).getTime(),
  ]);
  assert.deepEqual(weeksOf(summaries, { complete: true }).map((week) => week.tonnage), ['5.4 t', '17.1 t', '5.0 t']);
  assert.deepEqual(weeksOf([]), []);
});

test('weeksOf — a week nobody can sum, and a week that adds up to nothing, both say nothing', () => {
  const row = (id, at, tonnageKg) => ({ id, startedAt: at.getTime(), tonnageKg });
  const partly = [
    row('ses_3', new Date(2026, 7, 10, 18, 44), 5400),
    { id: 'ses_2', startedAt: new Date(2026, 7, 12, 7, 0).getTime() },
    row('ses_1', new Date(2026, 7, 4, 18, 0), 3000),
  ];
  assert.deepEqual(weeksOf(partly, { complete: true }).map((week) => week.tonnage), [null, '3.0 t']);
  const bodyweight = [
    row('ses_2', new Date(2026, 7, 12, 7, 0), 0),
    row('ses_1', new Date(2026, 7, 10, 7, 0), 0),
  ];
  assert.deepEqual(weeksOf(bodyweight, { complete: true }).map((week) => week.tonnage), [null]);
});

test('weeksOf — one training week is one divider in a zone whose clocks jump at midnight', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'America/Santiago';
    const chile = weeksOf([
      { id: 'ses_4', startedAt: new Date(2026, 8, 6, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_3', startedAt: new Date(2026, 8, 5, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_2', startedAt: new Date(2026, 8, 2, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 7, 31, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(chile.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 31 aug', '4.0 t', 4],
    ]);

    process.env.TZ = 'Asia/Beirut';
    const lebanon = weeksOf([
      { id: 'ses_2', startedAt: new Date(2026, 2, 29, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 2, 23, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(lebanon.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 23 mar', '2.0 t', 2],
    ]);

    process.env.TZ = 'Europe/Berlin';
    const berlin = weeksOf([
      { id: 'ses_2', startedAt: new Date(2026, 2, 29, 10, 0).getTime(), tonnageKg: 1000 },
      { id: 'ses_1', startedAt: new Date(2026, 2, 23, 10, 0).getTime(), tonnageKg: 1000 },
    ], { complete: true });
    assert.deepEqual(berlin.map((week) => [week.label, week.tonnage, week.sessions.length]), [
      ['week of 23 mar', '2.0 t', 2],
    ]);
  } finally {
    if (zone == null) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('weeksOf — a session that crosses midnight into Monday starts the new week, not the old one', () => {
  const summaries = [
    { id: 'ses_2', startedAt: new Date(2026, 7, 10, 0, 20).getTime(), tonnageKg: 1000 },
    { id: 'ses_1', startedAt: new Date(2026, 7, 9, 23, 40).getTime(), tonnageKg: 2000 },
  ];
  const weeks = weeksOf(summaries, { complete: true });
  assert.deepEqual(weeks.map((week) => [week.label, week.tonnage]), [
    ['week of 10 aug', '1.0 t'], ['week of 3 aug', '2.0 t'],
  ]);
});

test('sessionDetailMeta — the day, the length, and the two facts the header is measured in', () => {
  const startedAt = new Date(2026, 7, 10, 18, 2).getTime();
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });
  const sets = [set('warmup', 40, 8), set('working', 82.5, 5), set('working', 82.5, 5)];
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 58 * 60_000 }, sets),
    'Mon 10 Aug · 58m · 2 working · 825 kg',
  );
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: null }, sets),
    'Mon 10 Aug · in progress · 2 working · 825 kg',
  );
  const wholeSession = [set('warmup', 40, 8), ...Array.from({ length: 11 }, () => set('working', 98, 5))];
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 58 * 60_000 }, wholeSession),
    'Mon 10 Aug · 58m · 11 working · 5.4 t',
  );
  assert.equal(
    sessionDetailMeta({ startedAt, finishedAt: startedAt + 3_600_000 }, [set('working', 0, 9), set('working', 0, 7)]),
    'Mon 10 Aug · 1h 00m · 2 working',
  );
  assert.equal(sessionDetailMeta({ startedAt, finishedAt: startedAt + 600_000 }, []), 'Mon 10 Aug · 10m · 0 working');
});

test('planFrozenLabel — the snapshot is named by the moment it was taken', () => {
  const startedAt = new Date(2026, 7, 10, 18, 2).getTime();
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 }] };
  assert.equal(planFrozenLabel({ startedAt, plan }), 'plan snapshot · frozen 18:02');
  assert.equal(planFrozenLabel({ startedAt, plan: JSON.stringify(plan) }), 'plan snapshot · frozen 18:02');
  assert.equal(planFrozenLabel({ startedAt }), null);
  assert.equal(planFrozenLabel({ startedAt, plan: 'not json at all' }), null);
});

test('planReadingOf — the target, the movement nobody planned, and the plan that names one twice', () => {
  const session = {
    startedAt: 1_900_000_000_000,
    plan: {
      routine: 'Push A',
      entries: [
        { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 },
        { exerciseId: 'overhead-press', sets: 5, reps: 5 },
      ],
    },
  };
  assert.deepEqual(planReadingOf(session, 'bench-press'), {
    kind: 'planned',
    line: 'plan 5 × 5 · 82.5',
    entry: { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 },
  });
  assert.equal(planReadingOf(session, 'overhead-press').line, 'plan 5 × 5');
  assert.deepEqual(planReadingOf(session, 'chin-up'), { kind: 'added', line: NOT_IN_PLAN, entry: null });
  assert.equal(NOT_IN_PLAN, 'not in the plan');

  const twice = {
    startedAt: 1_900_000_000_000,
    plan: {
      routine: 'Squat day',
      entries: [
        { exerciseId: 'back-squat', sets: 3, reps: 3, weightKg: 140 },
        { exerciseId: 'back-squat', sets: 3, reps: 8, weightKg: 100 },
      ],
    },
  };
  assert.deepEqual(planReadingOf(twice, 'back-squat'), { kind: 'ambiguous', line: null, entry: null });

  assert.deepEqual(planReadingOf({ startedAt: 1 }, 'bench-press'), { kind: 'unplanned', line: null, entry: null });

  const unreadable = { kind: 'unplanned', line: null, entry: null };
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A', entries: {} } }, 'bench-press'), unreadable);
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A' } }, 'bench-press'), unreadable);
  assert.deepEqual(planReadingOf({ plan: [{ exerciseId: 'bench-press', sets: 5 }] }, 'bench-press'), unreadable);
  assert.deepEqual(planReadingOf({ plan: { routine: 'Push A', entries: [] } }, 'bench-press'), {
    kind: 'added', line: NOT_IN_PLAN, entry: null,
  });
});

test('setNoteOf — one word per set, and never a grade', () => {
  const planned = planReadingOf({
    plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 }] },
  }, 'bench-press');
  const set = (kind, weightKg, reps) => ({ kind, weightKg, reps });

  assert.equal(setNoteOf(set('working', 82.5, 5), planned, false), 'on plan');
  assert.equal(setNoteOf(set('working', 82.5, 3), planned, false), 'two short');
  assert.equal(setNoteOf(set('working', 82.5, 4), planned, false), 'one short');
  assert.equal(setNoteOf(set('working', 85, 5), planned, false), '+2.5 over plan');
  assert.equal(setNoteOf(set('working', 100, 5), planned, false), '+17.5 over plan');
  assert.equal(setNoteOf(set('working', 85, 3), planned, false), '+2.5 over plan');
  assert.equal(setNoteOf(set('working', 70, 5), planned, false), null);
  assert.equal(setNoteOf(set('working', 70, 3), planned, false), 'two short');
  assert.equal(setNoteOf(set('working', 82.5, 0), { ...planned, entry: { ...planned.entry, reps: 12 } }, false), '12 short');

  assert.equal(setNoteOf(set('warmup', 40, 8), planned, true), 'warmup');
  assert.equal(setNoteOf(set('drop', 60, 8), planned, false), 'drop');
  assert.equal(setNoteOf(set('failure', 82.5, 1), planned, false), 'failure');

  const added = planReadingOf({ plan: { routine: 'Push A', entries: [] } }, 'chin-up');
  assert.equal(setNoteOf(set('working', 0, 9), added, true), 'added today');
  assert.equal(setNoteOf(set('working', 0, 7), added, false), null);

  assert.equal(setNoteOf(set('working', 140, 3), { kind: 'ambiguous', line: null, entry: null }, true), null);
  assert.equal(setNoteOf(set('working', 140, 3), { kind: 'unplanned', line: null, entry: null }, true), null);

  const toMax = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3 }] },
  }, 'chin-up');
  assert.equal(toMax.line, 'plan 3 × max');
  assert.equal(setNoteOf(set('working', 0, 9), toMax, true), null);
  assert.equal(setNoteOf(set('working', 5, 9), toMax, true), null);

  const bodyweight = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3, reps: 9, weightKg: 0 }] },
  }, 'chin-up');
  assert.equal(bodyweight.line, 'plan 3 × 9');
  assert.equal(setNoteOf(set('working', 0, 9), bodyweight, true), null);
  assert.equal(setNoteOf(set('working', 5, 9), bodyweight, true), null);
  assert.equal(setNoteOf(set('working', 0, 7), bodyweight, false), 'two short');

  const assisted = planReadingOf({
    plan: { routine: 'Pull A', entries: [{ exerciseId: 'chin-up', sets: 3, reps: 6, weightKg: -20 }] },
  }, 'chin-up');
  assert.equal(assisted.line, 'plan 3 × 6 · −20');
  assert.equal(setNoteOf(set('working', -20, 6), assisted, true), 'on plan');
  assert.equal(setNoteOf(set('working', -10, 6), assisted, true), '+10 over plan');
});

test('setLoadLabel — what a set was, in the one spelling a weight has here', () => {
  assert.equal(setLoadLabel({ weightKg: 82.5, reps: 5 }), '82.5 × 5');
  assert.equal(setLoadLabel({ weightKg: 0, reps: 9 }), 'bodyweight × 9');
  assert.equal(setLoadLabel({ weightKg: -20, reps: 9 }), '−20 × 9');
  assert.equal(setLoadLabel({ weightKg: 100, reps: 1 }), '100 × 1');
});
