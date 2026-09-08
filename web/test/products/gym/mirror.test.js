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

const mirrorLine = async (t, over) => textOf(findByClass(await mirror(t, over), 'gym-mirror-line')[0]);

test('the mirror’s rest reads the dial, and says nothing about where it came from', async (t) => {
  const line = await mirrorLine(t, { restSeconds: 120 });
  assert.equal(line.endsWith('  ·  target 2:00'), true, line);
  assert.equal(line.includes('from the routine'), false);
});

test('the mirror’s rest reads the routine entry when the frozen plan carries one for this movement, and says so once', async (t) => {
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: [{ reps: 5 }], restSeconds: 180 }] };
  const line = await mirrorLine(t, { plan, restSeconds: 120 });
  assert.equal(line.endsWith('  ·  target 3:00 · from the routine'), true, line);
  assert.equal((line.match(/from the routine/g) ?? []).length, 1);
  assert.equal((await mirrorLine(t, { plan, restSeconds: null })).endsWith('  ·  target 3:00 · from the routine'), true, 'the entry runs the clock with the dial off');
});

test('the mirror draws no rest with the dial off and no entry naming one', async (t) => {
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: [{ reps: 5 }] }] };
  const line = await mirrorLine(t, { plan, restSeconds: null });
  assert.equal(line.includes('rest'), false, line);
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
