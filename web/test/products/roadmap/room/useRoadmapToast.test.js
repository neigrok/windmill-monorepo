import test from 'node:test';
import assert from 'node:assert/strict';
import { toastSeat, useRoadmapToast } from '../../../../src/products/roadmap/room/useRoadmapToast.js';
import { renderHook } from '../../gym/harness.mjs';

function slot(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return renderHook(t, () => useRoadmapToast());
}

test('toastSeat — a toast stands where its surface says, and a room toast takes the Board slot unless a step covers it', () => {
  const seats = (surface) => [
    toastSeat({ surface }, { canvasView: true, stepOpen: false }),
    toastSeat({ surface }, { canvasView: true, stepOpen: true }),
    toastSeat({ surface }, { canvasView: false, stepOpen: false }),
    toastSeat({ surface }, { canvasView: false, stepOpen: true }),
  ];
  assert.deepEqual(seats('board'), ['board', 'board', 'board', 'board']);
  assert.deepEqual(seats('graph'), ['room', 'room', null, null]);
  assert.deepEqual(seats('room'), ['room', 'room', 'board', 'room']);
  assert.deepEqual(seats('tend'), [null, null, null, null]);
  assert.equal(toastSeat(null, { canvasView: true, stepOpen: false }), null);
});

test('a toast holds from when it is shown: four seconds, six with an action, then its 280ms exit', (t) => {
  const hook = slot(t);
  hook.tree.showToast('Plain');
  const plain = hook.tree.toast;
  assert.deepEqual({ surface: plain.surface, holdMs: plain.holdMs, message: plain.message }, { surface: 'room', holdMs: 4000, message: 'Plain' });
  t.mock.timers.tick(9000);
  assert.equal(hook.tree.toast.leaving, false);
  hook.tree.toastShown(plain.key);
  t.mock.timers.tick(3999);
  assert.equal(hook.tree.toast.leaving, false);
  t.mock.timers.tick(1);
  assert.equal(hook.tree.toast.leaving, true);
  t.mock.timers.tick(280);
  assert.equal(hook.tree.toast, null);
  hook.tree.showToast('With Undo', { action: { label: 'Undo', run: () => {} } });
  assert.equal(hook.tree.toast.holdMs, 6000);
  hook.tree.showToast('Own hold', { holdMs: 9000 });
  assert.equal(hook.tree.toast.holdMs, 9000);
});

test('a newer toast replaces the one standing, which leaves once', (t) => {
  const hook = slot(t);
  const left = [];
  hook.tree.showToast('First', { onLeave: (via) => left.push(via) });
  const first = hook.tree.toast;
  hook.tree.toastShown(first.key);
  hook.tree.showToast('Second');
  assert.deepEqual([hook.tree.toast.message, left], ['Second', ['replaced']]);
  t.mock.timers.tick(10000);
  assert.deepEqual([hook.tree.toast.message, hook.tree.toast.leaving, left], ['Second', false, ['replaced']]);
});

test('a paused toast holds until it is shown again', (t) => {
  const hook = slot(t);
  hook.tree.showToast('Added 2 steps', { holdMs: 6000 });
  const { key } = hook.tree.toast;
  hook.tree.toastShown(key);
  t.mock.timers.tick(1000);
  hook.tree.pauseToast();
  t.mock.timers.tick(60000);
  assert.equal(hook.tree.toast.leaving, false);
  hook.tree.toastShown(key);
  t.mock.timers.tick(6000);
  assert.equal(hook.tree.toast.leaving, true);
});

test('an action runs before its toast is dismissed, and what the action says stands', (t) => {
  const hook = slot(t);
  const calls = [];
  hook.tree.showToast('Held', { onLeave: (via) => calls.push(`left ${via}`), action: { label: 'Undo', run: () => calls.push('undone') } });
  hook.tree.runToastAction(hook.tree.toast);
  assert.deepEqual([hook.tree.toast, calls], [null, ['undone', 'left replaced']]);

  hook.tree.showToast('Added 2 steps', { action: { label: 'Undo', run: () => hook.tree.showToast('AI changes reverted') } });
  hook.tree.runToastAction(hook.tree.toast);
  assert.equal(hook.tree.toast.message, 'AI changes reverted');
});

test('dismissToastIf leaves a toast it does not name, and tells the one it does how it went', (t) => {
  const hook = slot(t);
  const left = [];
  hook.tree.showToast('Room');
  hook.tree.dismissToastIf((shown) => shown.surface === 'board', 'left');
  assert.equal(hook.tree.toast.message, 'Room');
  hook.tree.showToast('Board', { surface: 'board', onLeave: (via) => left.push(via) });
  hook.tree.dismissToastIf((shown) => shown.surface === 'board', 'left');
  assert.deepEqual([hook.tree.toast, left], [null, ['left']]);
  hook.tree.dismissToastIf(() => assert.fail('nothing is standing'));
});
