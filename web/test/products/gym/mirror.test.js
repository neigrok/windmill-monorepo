import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, textOf } from './harness.mjs';

const NOW = 1_755_000_600_000;
const session = (plan) => ({ id: 'ses_1', startedAt: NOW - 600_000, ...(plan ? { plan } : {}) });
const sets = [{ id: 'set_1', exerciseId: 'bench-press', setNumber: 2, weightKg: 80, reps: 5, kind: 'working', completedAt: NOW - 30_000 }];

// The mirror hands the running session to a child; the harness renders no child, so it is drawn here.
async function mirror(t, { plan = null, restSeconds = null, logged = sets }) {
  browserWith();
  const { LiveMirror } = await loadScreen('products/gym/Mirror.jsx');
  const log = roomLog({
    session: session(plan),
    sets: logged,
    catalog: [{ id: 'bench-press', name: 'Bench press' }, { id: 'back-squat', name: 'Back Squat' }],
    preferences: { restSeconds },
  });
  const training = elementsOf(LiveMirror({ log, onSignIn: () => {} })).find((each) => typeof each.type === 'function');
  return renderHook(t, () => training.type(training.props)).tree;
}

test('the mirror shows two quiet count-up readings before the first set and after it, with no rest target', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const empty = await mirror(t, { logged: [] });
  assert.deepEqual(findByClass(empty, 'gym-workout-clock').map((clock) => [textOf(clock), clock.props['aria-label']]), [
    ['10:00', 'Workout time: 10 minutes'], ['10:00', 'Since start: 10 minutes'],
  ]);
  const logged = await mirror(t, { restSeconds: 120 });
  assert.deepEqual(findByClass(logged, 'gym-workout-clock').map((clock) => [textOf(clock), clock.props['aria-label']]), [
    ['10:00', 'Workout time: 10 minutes'], ['0:30', 'Since last set: 30 seconds'],
  ]);
  assert.equal(textOf(logged).includes('target 2:00'), false);
  assert.equal(findByClass(logged, 'gym-workout-clocks')[0].props['aria-live'], 'off');
});

// Lower A / Back Squat at the rack: sets 1 and 2 landed as planned, set 3 current (R11).
test('the mirror draws the plan line in the readout formula and the slots as rows — landed full, coming dim', async (t) => {
  const plan = {
    routine: 'Lower A',
    entries: [{
      exerciseId: 'back-squat',
      sets: [{ reps: 5, weightKg: 60 }, { reps: 5, weightKg: 80 }, { reps: 3, weightKg: 90 }, { reps: 1, weightKg: 100 }, { reps: 5, weightKg: 80 }],
      restSeconds: 180,
    }],
  };
  const logged = [
    { id: 'set_w', exerciseId: 'back-squat', setNumber: 1, weightKg: 40, reps: 8, kind: 'warmup', completedAt: NOW - 400_000 },
    { id: 'set_1', exerciseId: 'back-squat', setNumber: 2, weightKg: 60, reps: 5, kind: 'working', completedAt: NOW - 200_000 },
    { id: 'set_2', exerciseId: 'back-squat', setNumber: 3, weightKg: 80, reps: 5, kind: 'working', completedAt: NOW - 30_000 },
  ];
  const tree = await mirror(t, { plan, logged });
  assert.deepEqual(findByClass(tree, 'gym-mirror-plan').map(textOf), ['plan 5 × 1–5 · 60–100']);
  const rows = findByClass(tree, 'gym-mirror-slot');
  assert.deepEqual(rows.map((row) => [row.props.className, textOf(row), row.props['aria-label']]), [
    ['gym-mirror-slot is-warmup', '40 × 8 (warmup)', undefined],
    ['gym-mirror-slot is-lifted', '60 × 5', undefined],
    ['gym-mirror-slot is-lifted', '80 × 5', undefined],
    ['gym-mirror-slot is-target', '90 × 3', 'set 3, target 90 × 3'],
    ['gym-mirror-slot is-target', '100 × 1', 'set 4, target 100 × 1'],
    ['gym-mirror-slot is-target', '80 × 5', 'set 5, target 80 × 5'],
  ]);
  assert.deepEqual(findByClass(tree, 'gym-mirror-sets'), [], 'the joined string is gone');
  // Nothing on the mirror starts or logs anything.
  assert.equal(elementsOf(tree).some((each) => each.type === 'button'), false);
});

test('a free session draws no plan line and only what landed', async (t) => {
  const tree = await mirror(t, {});
  assert.deepEqual(findByClass(tree, 'gym-mirror-plan'), []);
  assert.deepEqual(findByClass(tree, 'gym-mirror-slot').map((row) => [row.props.className, textOf(row)]), [['gym-mirror-slot is-lifted', '80 × 5']]);
});

test('clock anchors survive corrections, exercise changes, deletion/Undo, finish and skew', async () => {
  const { workoutClocks } = await import('../../../src/products/gym/log.js');
  const session = { startedAt: 1000 };
  const first = { id: 's1', completedAt: 6000, exerciseId: 'squat', kind: 'warmup' };
  const last = { id: 's2', completedAt: 61000, exerciseId: 'bench', kind: 'working' };
  const now = 3662000;
  assert.deepEqual(workoutClocks(session, [first, last], now), [
    { label: 'Workout time', elapsed: 3661000, spoken: '1 hour 1 minute 1 second' },
    { label: 'Since last set', elapsed: 3601000, spoken: '1 hour 1 second' },
  ]);
  assert.deepEqual(workoutClocks(session, [first, { ...last, reps: 8, weightKg: 80, exerciseId: 'row' }], now), workoutClocks(session, [first, last], now));
  assert.equal(workoutClocks(session, [first], now)[1].elapsed, now - first.completedAt);
  assert.equal(workoutClocks(session, [], now)[1].elapsed, now - session.startedAt);
  assert.equal(workoutClocks(session, [first, last], now)[1].elapsed, now - last.completedAt);
  assert.deepEqual(workoutClocks({ ...session, finishedAt: 62000 }, [first, last], now), [
    { label: 'Workout time', elapsed: 61000, spoken: '1 minute 1 second' },
    { label: 'Since last set', elapsed: 1000, spoken: '1 second' },
  ]);
  assert.deepEqual(workoutClocks({ startedAt: now + 1000 }, [{ completedAt: now + 2000 }], now).map((clock) => clock.elapsed), [0, 0]);
});
