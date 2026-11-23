// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { LogRead } from '../../../../../src/products/gym/domain/coach/abilityReads.js';
import { GymRules, refusalForm } from '../../../../../src/products/gym/domain/gymRules.js';
import { SessionRules } from '../../../../../src/products/gym/domain/training.js';
import { ProductCorpus } from '../../../../platform/domain-kit/productCorpus.js';

// The newest page `list_sessions` answers over the given records, a minute after the last instant they hold.
/** @param {any[]} records */
function listed(records) {
  const now = Math.max(...records.flatMap((record) => ['startedAt', 'finishedAt', 'completedAt'].flatMap((name) => record.f[name] ? [record.f[name][0]] : []))) + 60_000;
  const vector = { file: 'abilityReads.test.js', name: 'list_sessions', input: { records: { drawn: records }, now, offsetSeconds: 0 }, expect: null };
  const read = new LogRead({ kind: 'sessions', before: SessionRules.maxInstantMs, beforeId: '', limit: LogRead.defaultPage });
  const decided = /** @type {any} */ (new ProductCorpus(GymRules.book, GymRules.spec).decision(read, vector, (answer) => answer.payload, refusalForm));
  return decided.decision.unchanged.result.sessions;
}

/** @param {string} t @param {string} id @param {Record<string, any>} fields */
function row(t, id, fields) {
  const stamp = '1789000000000:0:r_aaaaaaaaaaaa';
  return { t, id, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])) };
}

// A workout finished an hour after it started, by a tap.
/** @param {string} id @param {number} startedAt @param {Record<string, any>} [fields] */
function workout(id, startedAt, fields = {}) {
  return row('session', id, { startedAt, finishedAt: startedAt + 3_600_000, closedBy: 'finish', ...fields });
}

/** @param {string} id @param {string} sessionId @param {string} exerciseId @param {number} weightKg @param {number} reps @param {number} completedAt */
function set(id, sessionId, exerciseId, weightKg, reps, completedAt) {
  return row('set', id, { sessionId, exerciseId, weightKg, reps, note: '', completedAt });
}

test('a row names the movement its heaviest set was lifted on, and each movement\'s line holds its own heaviest set and estimate', () => {
  const at = 1_789_740_800_000;
  const sessions = listed([
    workout('sesAAAAAAAAAAAA1', at),
    set('setA000000000001', 'sesAAAAAAAAAAAA1', 'back-squat', 100, 1, at + 60_000),
    set('setA000000000002', 'sesAAAAAAAAAAAA1', 'bench-press', 90, 8, at + 120_000),
    set('setA000000000003', 'sesAAAAAAAAAAAA1', 'bench-press', 80, 8, at + 180_000),
    set('setA000000000004', 'sesAAAAAAAAAAAA1', 'pull-up', 0, 12, at + 240_000),
    set('setA000000000005', 'sesAAAAAAAAAAAA1', 'dip', -20, 8, at + 300_000),
    set('setA000000000006', 'sesAAAAAAAAAAAA1', 'dip', -10, 6, at + 360_000),
  ]);
  assert.deepEqual(sessions, [{
    id: 'sesAAAAAAAAAAAA1', startedAt: at, finishedAt: at + 3_600_000, setCount: 6, workingSetCount: 6, tonnageKg: 1460,
    exercises: ['Back Squat', 'Bench Press', 'Dip', 'Pull Up'], topSet: { exerciseId: 'back-squat', weightKg: 100, reps: 1 }, topE1rm: 114,
    record: false, closedItself: false,
    movements: [
      { exerciseId: 'back-squat', topSet: { weightKg: 100, reps: 1 }, topE1rm: 100 },
      { exerciseId: 'bench-press', topSet: { weightKg: 90, reps: 8 }, topE1rm: 114 },
      { exerciseId: 'dip', topSet: { weightKg: -10, reps: 6 }, topE1rm: null },
      { exerciseId: 'pull-up', topSet: { weightKg: 0, reps: 12 }, topE1rm: null },
    ],
  }]);
});

test('two movements whose heaviest sets tie on load and reps give the row\'s top set to the lower set id', () => {
  const at = 1_789_740_800_000;
  const sessions = listed([
    workout('sesTTTTTTTTTTTT1', at),
    set('setT000000000000', 'sesTTTTTTTTTTTT1', 'back-squat', 50, 10, at + 60_000),
    set('setT000000000002', 'sesTTTTTTTTTTTT1', 'back-squat', 60, 5, at + 120_000),
    set('setT000000000001', 'sesTTTTTTTTTTTT1', 'overhead-press', 60, 5, at + 180_000),
  ]);
  assert.deepEqual(sessions, [{
    id: 'sesTTTTTTTTTTTT1', startedAt: at, finishedAt: at + 3_600_000, setCount: 3, workingSetCount: 3, tonnageKg: 1100,
    exercises: ['Back Squat', 'Overhead Press'], topSet: { exerciseId: 'overhead-press', weightKg: 60, reps: 5 }, topE1rm: 70,
    record: false, closedItself: false,
    movements: [
      { exerciseId: 'back-squat', topSet: { weightKg: 60, reps: 5 }, topE1rm: 70 },
      { exerciseId: 'overhead-press', topSet: { weightKg: 60, reps: 5 }, topE1rm: 70 },
    ],
  }]);
});

test('a row goes by its display override, else its plan\'s name, and by none when neither names one; no row holds its plan', () => {
  const at = 1_789_740_800_000;
  const day = 86_400_000;
  /** @param {string} routine */
  const plan = (routine) => ({ routine, entries: [{ exerciseId: 'bench-press', sets: [{ weightKg: 60, reps: 5 }] }] });
  const sessions = listed([
    workout('sesRRRRRRRRRRRR1', at, { routineId: 'rtAAAAAAAAAAAAA1', plan: plan('Push'), displayName: 'Push day' }),
    set('setR000000000001', 'sesRRRRRRRRRRRR1', 'bench-press', 60, 5, at + 60_000),
    workout('sesRRRRRRRRRRRR2', at - day, { routineId: 'rtAAAAAAAAAAAAA2', plan: plan('Pull') }),
    set('setR000000000002', 'sesRRRRRRRRRRRR2', 'bench-press', 60, 5, at - day + 60_000),
    workout('sesRRRRRRRRRRRR3', at - 2 * day, { plan: plan('') }),
    set('setR000000000003', 'sesRRRRRRRRRRRR3', 'bench-press', 60, 5, at - 2 * day + 60_000),
    workout('sesRRRRRRRRRRRR4', at - 3 * day),
  ]);
  /** @param {string} id @param {number} startedAt */
  const benched = (id, startedAt) => ({ id, startedAt, finishedAt: startedAt + 3_600_000, setCount: 1, workingSetCount: 1, tonnageKg: 300,
    exercises: ['Bench Press'], topSet: { exerciseId: 'bench-press', weightKg: 60, reps: 5 }, topE1rm: 70, record: false, closedItself: false,
    movements: [{ exerciseId: 'bench-press', topSet: { weightKg: 60, reps: 5 }, topE1rm: 70 }] });
  assert.deepEqual(sessions, [
    { ...benched('sesRRRRRRRRRRRR1', at), routineId: 'rtAAAAAAAAAAAAA1', routineName: 'Push day' },
    { ...benched('sesRRRRRRRRRRRR2', at - day), routineId: 'rtAAAAAAAAAAAAA2', routineName: 'Pull' },
    benched('sesRRRRRRRRRRRR3', at - 2 * day),
    { id: 'sesRRRRRRRRRRRR4', startedAt: at - 3 * day, finishedAt: at - 3 * day + 3_600_000, setCount: 0, workingSetCount: 0, tonnageKg: 0,
      exercises: [], topE1rm: null, record: false, closedItself: false, movements: [] },
  ]);
});

test('the open workout\'s row lists the movements it holds so far, a line\'s estimate being its best set\'s, not its heaviest\'s', () => {
  const at = 1_789_740_800_000;
  const sessions = listed([
    row('session', 'sesOOOOOOOOOOOO1', { startedAt: at }),
    set('setO000000000001', 'sesOOOOOOOOOOOO1', 'deadlift', 140, 6, at + 60_000),
    set('setO000000000002', 'sesOOOOOOOOOOOO1', 'deadlift', 150, 2, at + 120_000),
  ]);
  assert.deepEqual(sessions, [{
    id: 'sesOOOOOOOOOOOO1', startedAt: at, setCount: 2, workingSetCount: 2, tonnageKg: 1140, exercises: ['Deadlift'],
    topSet: { exerciseId: 'deadlift', weightKg: 150, reps: 2 }, topE1rm: 168, record: false, closedItself: false,
    movements: [{ exerciseId: 'deadlift', topSet: { weightKg: 150, reps: 2 }, topE1rm: 168 }],
  }]);
});
