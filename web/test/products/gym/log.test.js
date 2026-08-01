// The log's reading rules, pinned. These are the three places a phase-1 logger will lean on the
// hardest: where the hash points, what a session is called when the plan arrives in either wire
// shape, and the first-performed order the detail view groups sets in.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agoLabel, clockOf, dayLabel, durLabel, fmt, groupByExercise, isFinished, nameOfMovement, planOf,
  routineNameOf, screenOf, sessionHref, sessionIdOf, sessionMetaLabel, setCountLabel, timeLabel,
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

test('screenOf — one grammar decides which of the three rooms a hash names', () => {
  assert.equal(screenOf('#/gym'), 'today');
  assert.equal(screenOf('#/gym/'), 'today');
  assert.equal(screenOf('#/gym/log'), 'log');
  assert.equal(screenOf('#/gym/log?page=2'), 'log');
  assert.equal(screenOf('#/gym/session/ses_9f3a1c22'), 'session');
  assert.equal(screenOf(''), 'today');
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

test('planOf — the frozen snapshot, parsed once for every surface that reads it', () => {
  const plan = { routine: 'Squat day', entries: [{ exerciseId: 'back-squat', sets: 5, reps: 5, weightKg: 102.5 }] };
  assert.deepEqual(planOf({ plan }), plan);
  assert.deepEqual(planOf({ plan: JSON.stringify(plan) }), plan);
  assert.equal(planOf({ plan: 'not json at all' }), null);
  assert.equal(planOf({ plan: null }), null);
  assert.equal(planOf({}), null);
  assert.equal(planOf(null), null);
});
