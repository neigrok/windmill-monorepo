import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, findByClass, loadScreen, renderHook, textOf } from '../products/gym/harness.mjs';

const options = [{ value: 'off', label: 'Off' }, { value: '30', label: '0:30' }, { value: '60', label: '1:00' }, { value: '90', label: '1:30' }];

// The window's pointer listeners, so a press outside can be sent the way the browser would.
function listeningWindow() {
  browserWith();
  const bound = new Map();
  window.addEventListener = (type, fn) => bound.set(type, [...(bound.get(type) ?? []), fn]);
  window.removeEventListener = (type, fn) => bound.set(type, (bound.get(type) ?? []).filter((each) => each !== fn));
  return { fire: (type, event) => (bound.get(type) ?? []).forEach((fn) => fn(event)), count: (type) => (bound.get(type) ?? []).length };
}

async function select(t, props) {
  const { Select } = await loadScreen('design-system/forms/Select.jsx');
  const chosen = [];
  const drawn = renderHook(t, () => Select({ options, onChange: (value) => chosen.push(value), ...props }));
  const opener = () => findByClass(drawn.tree, 'wm-select-open')[0];
  const key = (name) => {
    const event = { key: name, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    opener().props.onKeyDown(event);
    return event;
  };
  const listed = () => findByClass(drawn.tree, 'wm-select-option').map((option) => [textOf(option), option.props['aria-selected'], option.props.className.includes('is-active')]);
  return { drawn, opener, key, listed, chosen };
}

test('a compact select is a combobox named by its row, showing its value, its listbox closed', async (t) => {
  listeningWindow();
  const { drawn, opener } = await select(t, { value: '60', compact: true, labelledBy: 'row-label' });
  assert.equal(drawn.tree.props.className, 'wm-select is-compact');
  const { role, 'aria-haspopup': popup, 'aria-expanded': expanded, 'aria-labelledby': named, type } = opener().props;
  assert.deepEqual({ role, popup, expanded, named, type }, { role: 'combobox', popup: 'listbox', expanded: false, named: 'row-label', type: 'button' });
  assert.equal(textOf(findByClass(drawn.tree, 'wm-select-value')[0]), '1:00');
  assert.equal(findByClass(drawn.tree, 'wm-select-list').length, 0);
});

test('Enter opens on the current option, the arrows move, Enter chooses and closes, and a choice of the current value changes nothing', async (t) => {
  listeningWindow();
  const { drawn, opener, key, listed, chosen } = await select(t, { value: '30', compact: true });
  assert.equal(key('Enter').prevented, true);
  assert.equal(opener().props['aria-expanded'], true);
  assert.equal(findByClass(drawn.tree, 'wm-select-list')[0].props.role, 'listbox');
  assert.deepEqual(listed(), [['Off', false, false], ['0:30', true, true], ['1:00', false, false], ['1:30', false, false]]);
  assert.equal(opener().props['aria-activedescendant'], findByClass(drawn.tree, 'wm-select-option')[1].props.id);
  key('ArrowDown');
  key('ArrowDown');
  key('ArrowDown');
  key('ArrowUp');
  assert.deepEqual(listed().map(([label, , active]) => active && label).filter(Boolean), ['1:00']);
  key('Enter');
  assert.deepEqual(chosen, ['60']);
  assert.equal(opener().props['aria-expanded'], false);
  key('ArrowDown');
  key('Enter');
  assert.deepEqual(chosen, ['60'], 'the current value, chosen again, is no change');
});

test('Escape closes without leaving the page, and a pointer outside closes, its listener living only while open', async (t) => {
  const win = listeningWindow();
  const { opener, key, drawn } = await select(t, { value: 'off', compact: true });
  assert.equal(win.count('pointerdown'), 0);
  key(' ');
  assert.equal(win.count('pointerdown'), 1);
  const escape = key('Escape');
  assert.deepEqual([escape.prevented, escape.stopped, opener().props['aria-expanded']], [true, true, false]);
  assert.equal(key('Escape').prevented, false, 'a closed select leaves Escape to the page');
  opener().props.onClick();
  const inside = { inside: true };
  drawn.tree.ref.current = { contains: (target) => target === inside };
  win.fire('pointerdown', { target: inside });
  assert.equal(opener().props['aria-expanded'], true);
  win.fire('pointerdown', { target: { outside: true } });
  assert.equal(opener().props['aria-expanded'], false);
  assert.equal(win.count('pointerdown'), 0);
});

test('a labelled select keeps its label and its full width, with no check by the current option', async (t) => {
  listeningWindow();
  const { drawn, opener, key } = await select(t, { value: '90', label: 'Rest' });
  assert.equal(drawn.tree.props.className, 'wm-select');
  const label = findByClass(drawn.tree, 'wm-select-label')[0];
  assert.deepEqual([textOf(label), opener().props['aria-labelledby']], ['Rest', label.props.id]);
  key('ArrowDown');
  assert.deepEqual(findByClass(drawn.tree, 'wm-select-option').map((option) => (Array.isArray(option.props.children) ? option.props.children.filter(Boolean).length : 1)),
    [1, 1, 1, 1]);
});
