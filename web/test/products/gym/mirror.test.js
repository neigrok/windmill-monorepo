import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, textOf } from './harness.mjs';

const NOW = 1_755_000_600_000;
const session = (plan) => ({ id: 'ses_1', startedAt: NOW - 600_000, ...(plan ? { plan } : {}) });
const sets = [{ id: 'set_1', exerciseId: 'bench-press', setNumber: 2, weightKg: 80, reps: 5, kind: 'working', completedAt: NOW - 30_000 }];

// The mirror hands the running session to a child; the harness renders no child, so it is drawn here.
async function mirrorLine(t, { plan = null, restSeconds = null }) {
  browserWith();
  const { LiveMirror } = await loadScreen('products/gym/Mirror.jsx');
  const log = roomLog({ session: session(plan), sets, catalog: [{ id: 'bench-press', name: 'Bench press' }], preferences: { restSeconds } });
  const training = elementsOf(LiveMirror({ log, onSignIn: () => {} })).find((each) => typeof each.type === 'function');
  const drawn = renderHook(t, () => training.type(training.props));
  return textOf(findByClass(drawn.tree, 'gym-mirror-line')[0]);
}

test('the mirror’s rest reads the dial, and says nothing about where it came from', async (t) => {
  const line = await mirrorLine(t, { restSeconds: 120 });
  assert.equal(line.endsWith('  ·  target 2:00'), true, line);
  assert.equal(line.includes('from the routine'), false);
});

test('the mirror’s rest reads the routine entry when the frozen plan carries one for this movement, and says so once', async (t) => {
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', targetSets: 5, restSeconds: 180 }] };
  const line = await mirrorLine(t, { plan, restSeconds: 120 });
  assert.equal(line.endsWith('  ·  target 3:00 · from the routine'), true, line);
  assert.equal((line.match(/from the routine/g) ?? []).length, 1);
  assert.equal((await mirrorLine(t, { plan, restSeconds: null })).endsWith('  ·  target 3:00 · from the routine'), true, 'the entry runs the clock with the dial off');
});

test('the mirror draws no rest with the dial off and no entry naming one', async (t) => {
  const plan = { routine: 'Push A', entries: [{ exerciseId: 'bench-press', targetSets: 5 }] };
  const line = await mirrorLine(t, { plan, restSeconds: null });
  assert.equal(line.includes('rest'), false, line);
});
