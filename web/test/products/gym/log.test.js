// The log's reading rules, pinned. These are the three places a phase-1 logger will lean on the
// hardest: where the hash points, what a session is called when the plan arrives in either wire
// shape, and the first-performed order the detail view groups sets in.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  durationLabel, groupByExercise, isFinished, routineNameOf, sessionHref, sessionIdOf,
  setCountLabel,
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

test('durationLabel and setCountLabel — the two numbers the log row says out loud', () => {
  assert.equal(durationLabel(0, 30 * 60_000), '30 min');
  assert.equal(durationLabel(0, 59 * 60_000), '59 min');
  assert.equal(durationLabel(0, 95 * 60_000), '1 h 35 min');
  assert.equal(durationLabel(0, 120 * 60_000), '2 h 0 min');
  assert.equal(durationLabel(0, 0), '1 min');
  assert.equal(setCountLabel(0), '0 sets');
  assert.equal(setCountLabel(1), '1 set');
  assert.equal(setCountLabel(12), '12 sets');
});
