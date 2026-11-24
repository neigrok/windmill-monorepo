import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, confirmed, elementsOf, gymAccount, loadScreen, renderHook, roomLog, settle } from './harness.mjs';

test('a finished workout’s review offers its share only to an account the shell has settled', async (t) => {
  browserWith();
  const startedAt = 1_755_000_000_000;
  await gymAccount(t, [
    confirmed('session', 'session0001', { startedAt, finishedAt: startedAt + 3_600_000 }),
    ...[1, 2, 3, 4].map((setNumber) => confirmed('set', `set000000${setNumber}`, {
      sessionId: 'session0001', exerciseId: 'back-squat', setNumber, weightKg: 100, reps: 5, completedAt: startedAt + setNumber * 600_000, note: '',
    })),
  ]);
  const { FinishScreen } = await loadScreen('products/gym/Finish.jsx');
  const shares = async (signedIn) => {
    const view = renderHook(t, () => FinishScreen({ id: 'session0001', log: roomLog(), signedIn }));
    await settle();
    view.redraw();
    return elementsOf(view.tree).filter((each) => each.type?.name === 'ShareWorkout').map((each) => each.props.sessionId);
  };
  assert.deepEqual([await shares(false), await shares(true)], [[], ['session0001']]);
});
