import test from 'node:test';
import assert from 'node:assert/strict';
import { coachWorkout } from '../../../../src/products/gym/coach/coach.js';

test('live mirror uses frozen targets and actual sets without comparing ambiguous or unplanned movements', () => {
  const session = { startedAt: 0, plan: { routine: 'Push', entries: [
    { exerciseId: 'bench', sets: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }] },
    { exerciseId: 'chin', sets: [{ weightKg: 0, reps: 6 }] },
  ] } };
  const sets = [{ id: 'set_1', exerciseId: 'bench', weightKg: 62.5, reps: 7, setNumber: 1, completedAt: 1 }];
  const catalog = [{ id: 'bench', name: 'Bench Press' }, { id: 'chin', name: 'Chin-up', equipment: 'bodyweight' }];
  const result = coachWorkout(session, sets, catalog);
  assert.deepEqual({ ...result, started: 'local time' }, { name: 'Push', started: 'local time', count: '1 set logged', progress: 'set 2 of 3', active: 'bench', groups: [
    { id: 'bench', name: 'Bench Press', scheme: '2 × 8 · 60', targets: 2, rows: [
      { key: 'set_1', kind: 'lifted', label: '62.5 × 7' },
      { key: 'slot-2', kind: 'target', label: '60 × 8', spoken: 'set 2, target 60 × 8' },
    ] },
    { id: 'chin', name: 'Chin-up', scheme: '1 × 6 · 0 · bodyweight', targets: 1, rows: [{ key: 'slot-1', kind: 'target', label: '0 × 6', spoken: 'set 1, target 0 × 6' }] },
  ] });
  const ambiguous = coachWorkout({ ...session, plan: { entries: [session.plan.entries[0], session.plan.entries[0]] } }, sets, catalog);
  assert.deepEqual(ambiguous.groups, [{ id: 'bench', name: 'Bench Press', scheme: null, targets: null, rows: [{ key: 'set_1', kind: 'lifted', label: '62.5 × 7' }] }]);
  assert.equal(ambiguous.progress, '1 set logged');
  assert.deepEqual(coachWorkout({ startedAt: 0, plan: '{bad json' }, [], []).groups, []);
});

test('extra sets on one movement never consume another movement’s planned slots', () => {
  const session = { startedAt: 0, plan: { entries: ['bench', 'press'].map((exerciseId) => ({ exerciseId,
    sets: Array.from({ length: 3 }, () => ({ weightKg: 60, reps: 8 })) })) } };
  const sets = Array.from({ length: 5 }, (_, index) => ({ id: `set_${index}`, exerciseId: 'bench',
    setNumber: index + 1, completedAt: index, weightKg: 60, reps: 8 }));
  sets.push({ id: 'set_light', exerciseId: 'press', setNumber: 1, completedAt: 6, weightKg: 20, reps: 8 });
  const workout = coachWorkout(session, sets);
  const lifted = (key, label) => ({ key, kind: 'lifted', label });
  const target = (n) => ({ key: `slot-${n}`, kind: 'target', label: '60 × 8', spoken: `set ${n}, target 60 × 8` });
  assert.deepEqual({ ...workout, started: 'local time' }, { name: 'Free session', started: 'local time', count: '6 sets logged', progress: 'set 5 of 6', active: 'press', groups: [
    { id: 'bench', name: 'bench', scheme: '3 × 8 · 60', targets: 3, rows: [0, 1, 2, 3, 4].map((index) => lifted(`set_${index}`, '60 × 8')) },
    { id: 'press', name: 'press', scheme: '3 × 8 · 60', targets: 3, rows: [lifted('set_light', '20 × 8'), target(2), target(3)] },
  ] });
});

test('a movement\'s sets fill its slots in the order they were done, a set the server has not numbered included', () => {
  const session = { startedAt: 0, plan: { entries: [{ exerciseId: 'bench', sets: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }] }] } };
  const sets = [
    { id: 'set_b', exerciseId: 'bench', setNumber: 1, completedAt: 2, weightKg: 62.5, reps: 6 },
    { id: 'set_a', exerciseId: 'bench', completedAt: 1, weightKg: 60, reps: 8 },
  ];
  assert.deepEqual(coachWorkout(session, sets).groups[0].rows, [
    { key: 'set_a', kind: 'lifted', label: '60 × 8' },
    { key: 'set_b', kind: 'lifted', label: '62.5 × 6' },
  ]);
});
