import test from 'node:test';
import assert from 'node:assert/strict';
import { focusableElements, wrapTab } from '../../../src/design-system/feedback/dialogFocus.js';

function layer(t) {
  const beforeDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const beforeStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  t.after(() => {
    if (beforeDocument) Object.defineProperty(globalThis, 'document', beforeDocument);
    else delete globalThis.document;
    if (beforeStyle) Object.defineProperty(globalThis, 'getComputedStyle', beforeStyle);
    else delete globalThis.getComputedStyle;
  });
  globalThis.document = { activeElement: null };
  globalThis.getComputedStyle = (element) => ({ visibility: element.visibility ?? 'visible' });
  const calls = [];
  const root = {
    focus: () => calls.push('layer'),
    querySelectorAll: () => root.children,
  };
  root.children = ['first', 'middle', 'last'].map((name) => ({
    matches: () => false,
    tabIndex: 0,
    closest: () => null,
    getClientRects: () => [{}],
    focus: () => calls.push(name),
  }));
  return {
    root,
    calls,
    press: (active, options = {}) => {
      document.activeElement = active;
      wrapTab({ key: 'Tab', preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop'), ...options }, root);
    },
  };
}

test('shared dialogs stop Tab propagation, wrap both edges and outside focus, and preserve native movement inside', (t) => {
  const item = layer(t);
  for (const [index, shiftKey, expected] of [
    [2, false, ['stop', 'prevent', 'first']],
    [0, true, ['stop', 'prevent', 'last']],
    [-1, false, ['stop', 'prevent', 'first']],
    [-1, true, ['stop', 'prevent', 'last']],
    [1, false, ['stop']],
    [1, true, ['stop']],
  ]) {
    item.calls.length = 0;
    item.press(item.root.children[index], { shiftKey });
    assert.deepEqual(item.calls, expected);
  }
});

test('shared dialogs read the current page and focus the layer when no Tab stops remain', (t) => {
  const item = layer(t);
  const removed = item.root.children[0];
  item.root.children = [item.root.children[2]];
  item.press(removed);
  assert.deepEqual(item.calls, ['stop', 'prevent', 'last']);
  item.calls.length = 0;
  item.root.children = [];
  item.press(removed, { shiftKey: true });
  assert.deepEqual(item.calls, ['stop', 'prevent', 'layer']);
});

test('Tab rule leaves handled events and other keys alone', (t) => {
  const item = layer(t);
  item.press(null, { defaultPrevented: true });
  item.press(null, { key: 'Escape' });
  assert.deepEqual(item.calls, []);
});

test('focusable query excludes disabled, negative-tabindex, hidden and inert controls', (t) => {
  const item = layer(t);
  const allowed = item.root.children[0];
  const disabled = { ...allowed, matches: () => true };
  const covered = { ...allowed, closest: () => ({}) };
  const hidden = { ...allowed, getClientRects: () => [] };
  const negative = { ...allowed, tabIndex: -2 };
  const invisible = { ...allowed, visibility: 'hidden' };
  item.root.children = [disabled, covered, allowed, hidden, negative, invisible];
  assert.deepEqual(focusableElements(item.root), [allowed]);
  assert.deepEqual(focusableElements(null), []);
});
