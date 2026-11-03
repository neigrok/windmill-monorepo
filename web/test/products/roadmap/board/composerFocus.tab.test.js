import test from 'node:test';
import assert from 'node:assert/strict';
import { focusableElements, wrapTab } from '../../../../src/products/roadmap/board/composerFocus.js';

function layer() {
  const calls = [];
  const root = {
    ownerDocument: { activeElement: null, defaultView: { getComputedStyle: (element) => ({ visibility: element.visibility ?? 'visible' }) } },
    closest: () => null,
    focus: () => calls.push('layer'),
    querySelectorAll: () => root.children,
  };
  root.children = ['first', 'middle', 'last'].map((name) => ({
    matches: () => false,
    hasAttribute: () => false,
    closest: () => null,
    getClientRects: () => [{}],
    focus: () => calls.push(name),
  }));
  return {
    root,
    calls,
    press: (active, options = {}) => {
      root.ownerDocument.activeElement = active;
      wrapTab({ key: 'Tab', preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop'), ...options }, root);
    },
  };
}

test('Tab rule wraps both edges and outside focus, preserving native movement inside', () => {
  for (const [index, shiftKey, expected] of [
    [2, false, ['stop', 'prevent', 'first']],
    [0, true, ['stop', 'prevent', 'last']],
    [-1, false, ['stop', 'prevent', 'first']],
    [-1, true, ['stop', 'prevent', 'last']],
    [1, false, ['stop']],
    [1, true, ['stop']],
  ]) {
    const item = layer();
    item.press(item.root.children[index], { shiftKey });
    assert.deepEqual(item.calls, expected);
  }
});

test('Tab rule reads the current page and contains a layer with no remaining stops', () => {
  const item = layer();
  const removed = item.root.children[0];
  item.root.children = [item.root.children[2]];
  item.press(removed);
  assert.deepEqual(item.calls, ['stop', 'prevent', 'last']);
  item.calls.length = 0;
  item.root.children = [];
  item.press(removed, { shiftKey: true });
  assert.deepEqual(item.calls, ['stop', 'prevent', 'layer']);
});

test('Tab rule leaves handled events, other keys and covered layers alone', () => {
  const item = layer();
  item.press(null, { defaultPrevented: true });
  item.press(null, { key: 'Escape' });
  item.root.closest = () => ({});
  item.press(null);
  assert.deepEqual(item.calls, []);
});

test('focusable query excludes disabled, negative-tabindex, hidden and inert controls', () => {
  const item = layer();
  const allowed = item.root.children[0];
  const disabled = { ...allowed, matches: () => true };
  const covered = { ...allowed, closest: () => ({}) };
  const hidden = { ...allowed, getClientRects: () => [] };
  const negative = { ...allowed, hasAttribute: () => true, tabIndex: -2 };
  const invisible = { ...allowed, visibility: 'hidden' };
  item.root.children = [disabled, covered, allowed, hidden, negative, invisible];
  assert.deepEqual(focusableElements(item.root), [allowed]);
  assert.deepEqual(focusableElements(null), []);
});
