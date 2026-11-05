import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScreen, renderHook, elementsOf, textOf } from '../../gym/harness.mjs';
import { createdToast } from '../../../../src/products/roadmap/copy.js';

test('phone refusal defers the creation toast, including one already visible', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { BoardToast } = await loadScreen('products/roadmap/board/BoardToast.jsx');
  const shown = [];
  const toast = { key: 1, message: createdToast({ step: 'Read the wind', column: 'upNext' }), action: { label: 'Undo' } };
  let blocked = true;
  const view = renderHook(t, () => BoardToast({ toast, phone: true, blocked, onToastShown: (key) => shown.push(key) }));
  const visible = () => elementsOf(view.tree).filter((node) => node.props.className === 'st-board-toast').map(textOf);
  t.mock.timers.tick(6000);
  assert.deepEqual({ visible: visible(), shown }, { visible: [], shown: [] });
  blocked = false;
  view.redraw();
  t.mock.timers.tick(120);
  assert.deepEqual({ visible: visible(), shown }, { visible: [toast.message + 'Undo'], shown: [1] });
  blocked = true;
  view.redraw();
  assert.deepEqual(visible(), []);
  blocked = false;
  view.redraw();
  assert.deepEqual({ visible: visible(), shown }, { visible: [toast.message + 'Undo'], shown: [1] });
});

test('a held delete stands over a phone refusal: its hold runs and its Undo stays reachable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { BoardToast } = await loadScreen('products/roadmap/board/BoardToast.jsx');
  const shown = [];
  const toast = { key: 2, act: 'delete', overRefusal: true, message: 'Read the wind deleted', action: { label: 'Undo' } };
  const view = renderHook(t, () => BoardToast({ toast, phone: true, blocked: true, onToastShown: (key) => shown.push(key) }));
  t.mock.timers.tick(120);
  view.redraw();
  assert.deepEqual({ visible: elementsOf(view.tree).filter((node) => node.props.className?.startsWith('st-board-toast st-board-toast--delete')).map(textOf), shown }, { visible: ['Read the wind deletedUndo'], shown: [2] });
});
