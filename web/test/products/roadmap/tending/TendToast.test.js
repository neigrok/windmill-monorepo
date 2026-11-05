import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, renderHook, elementsOf, textOf } from '../../gym/harness.mjs';

const receipt = { key: 7, message: 'Added 2 steps', detail: 'Two practice steps connect the lesson to the first trip.', action: { label: 'Undo', run: () => {} } };

function pill(t, TendToast, toast, extra = {}) {
  const calls = [];
  const handlers = { onShown: (key) => calls.push(['shown', key]), onPause: () => calls.push(['pause']), onAct: () => calls.push(['act']) };
  const view = renderHook(t, () => TendToast({ toast, overCanvas: false, ...handlers, ...extra }));
  const button = (name) => elementsOf(view.tree).find((node) => node.type === 'button' && textOf(node) === name);
  return { view, calls, button };
}

test('an AI receipt holds from when it shows, and reading its reason pauses the hold until it is hidden', async (t) => {
  const { TendToast } = await loadScreen('products/roadmap/tending/TendToast.jsx');
  const { view, calls, button } = pill(t, TendToast, receipt);
  assert.equal(textOf(view.tree), 'Added 2 stepsWhy?Undo');
  assert.equal(view.tree.props.role, 'status');
  button('Why?').props.onClick();
  assert.equal(textOf(view.tree), `Added 2 stepsHideUndo${receipt.detail}`);
  assert.equal(view.tree.props.className, 'st-toast st-toast--expanded');
  button('Hide').props.onClick();
  assert.equal(textOf(view.tree), 'Added 2 stepsWhy?Undo');
  button('Undo').props.onClick();
  assert.deepEqual(calls, [['shown', 7], ['pause'], ['shown', 7], ['act']]);
});

test('an AI answer with no detail or action offers neither, and stands over the canvas in the Graph\'s seat', async (t) => {
  const { TendToast } = await loadScreen('products/roadmap/tending/TendToast.jsx');
  const { view } = pill(t, TendToast, { key: 8, message: 'AI changes reverted', leaving: true }, { overCanvas: true });
  assert.equal(textOf(view.tree), 'AI changes reverted');
  assert.equal(view.tree.props.className, 'st-toast st-toast--graph is-leaving');
  assert.equal(elementsOf(view.tree).filter((node) => node.type === 'button').length, 0);
});
