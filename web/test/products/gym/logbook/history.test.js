import test from 'node:test';
import assert from 'node:assert/strict';
import { collapsedScheme, historyHref, historyQuery, historyScope, historyTotals, workoutTotals, yearsOf } from '../../../../src/products/gym/logbook/history.js';

test('history scope and selection survive routes and clearing one filter preserves the others', () => {
  const route = '#/gym/log?year=2024&exercise=bench&routine=rt_a&density=compact&session=ses_a';
  const filters = historyQuery(route);
  assert.deepEqual(filters, { year: 2024, month: null, exercise: 'bench', routine: 'rt_a', density: 'compact', selected: 'ses_a' });
  assert.equal(historyHref(filters), route);
  assert.deepEqual(historyScope(filters), { from: new Date(2024, 0, 1).getTime(), until: new Date(2025, 0, 1).getTime(), exercise: 'bench', routine: 'rt_a' });
  assert.equal(historyHref(filters, { exercise: '', selected: null }), '#/gym/log?year=2024&routine=rt_a&density=compact');
  assert.equal(historyTotals({ sessions: 982, sets: 4908, reps: 24881 }), '982 workouts · 4908 sets · 24881 reps · loads in kg');
});

test('a saved scheme collapses only equal facts and never hides a note or a different rating', () => {
  const sets = [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }];
  assert.equal(collapsedScheme(sets), '3 × 8 · 60');
  assert.equal(collapsedScheme(sets.map((set) => ({ ...set, weightKg: 0 }))), '3 × 8 · bodyweight');
  assert.equal(collapsedScheme([sets[0], { ...sets[1], reps: 7 }]), null);
  assert.equal(collapsedScheme([sets[0], { ...sets[1], rpe: 9 }]), null);
  assert.equal(collapsedScheme([sets[0], { ...sets[1], note: 'heavy' }]), null);
});

test('workout totals count every set and each dumbbell a movement holds, and never an assisted load', () => {
  const catalog = [{ id: 'bench-press', equipment: 'barbell' }, { id: 'dumbbell-bench-press', equipment: 'dumbbell', loadCount: 2 },
    { id: 'dumbbell-row', equipment: 'dumbbell', loadCount: 1 }, { id: 'pull-up', equipment: 'bodyweight' }];
  const sets = [{ exerciseId: 'bench-press', weightKg: 60, reps: 8 }, { exerciseId: 'bench-press', weightKg: 40, reps: 8 },
    { exerciseId: 'dumbbell-bench-press', weightKg: 20, reps: 10 }, { exerciseId: 'dumbbell-row', weightKg: 30, reps: 10 },
    { exerciseId: 'pull-up', weightKg: -20, reps: 8 }, { exerciseId: 'pull-up', weightKg: 10, reps: 5 }];
  assert.deepEqual(workoutTotals(sets, catalog), { sets: 6, reps: 49, tonnageKg: 480 + 320 + 400 + 300 + 50 });
});

test('a month is a complete local calendar range and an invalid month cannot escape its year', () => {
  assert.deepEqual(historyScope(historyQuery('#/gym/log?year=2024&month=06')), { from: new Date(2024, 5, 1).getTime(), until: new Date(2024, 6, 1).getTime() });
  assert.equal(historyQuery('#/gym/log?year=2024&month=13').month, null);
});

test('dense history groups dates by their local month and year while small history keeps years', () => {
  const sessions = [{ id: 'a', startedAt: new Date(2026, 8, 1).getTime() }, { id: 'b', startedAt: new Date(2026, 7, 31).getTime() }, { id: 'c', startedAt: new Date(2024, 11, 1).getTime() }];
  assert.deepEqual(yearsOf(sessions), [{ year: 2026, sessions: sessions.slice(0, 2) }, { year: 2024, sessions: sessions.slice(2) }]);
  assert.deepEqual(yearsOf(sessions, true), [{ year: 'September 2026', sessions: sessions.slice(0, 1) }, { year: 'August 2026', sessions: sessions.slice(1, 2) }, { year: 'December 2024', sessions: sessions.slice(2) }]);
});
