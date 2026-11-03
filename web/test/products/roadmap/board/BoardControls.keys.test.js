import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const { handleMenuKey, dismissOverlayOutside } = await import('../../../../src/products/roadmap/board/BoardControls.jsx');

function menu({ selected = 0, selector = '[role="menuitem"]', onTab = true } = {}) {
  const calls = [];
  const options = ['first', 'middle', 'last'].map((name) => ({ focus: () => calls.push(['focus', name]) }));
  const root = {
    ownerDocument: { activeElement: options[selected] },
    querySelectorAll: (query) => {
      assert.equal(query, selector);
      return options;
    },
  };
  return {
    calls,
    press: (key) => handleMenuKey({ key,
      preventDefault: () => calls.push(['preventDefault']),
      stopPropagation: () => calls.push(['stopPropagation']),
    }, {
      root, selector, onEscape: () => calls.push(['escape']),
      onTab: onTab ? () => calls.push(['tab']) : undefined,
    }),
  };
}

test('shared menu keys loop both directions for action and radio menus', () => {
  for (const selector of ['[role="menuitem"]', '[role="menuitemradio"]']) {
    for (const [selected, key, target] of [[0, 'ArrowUp', 'last'], [2, 'ArrowDown', 'first'], [1, 'ArrowDown', 'last']]) {
      const item = menu({ selector, selected });
      item.press(key);
      assert.deepEqual(item.calls, [['preventDefault'], ['focus', target]]);
    }
  }
});

test('shared menu keys stop Escape, preserve native Tab, and leave unrelated keys alone', () => {
  const item = menu();
  item.press('Escape');
  item.press('Tab');
  item.press('x');
  assert.deepEqual(item.calls, [['preventDefault'], ['stopPropagation'], ['escape'], ['tab']]);
  const sort = menu({ onTab: false });
  sort.press('Tab');
  assert.deepEqual(sort.calls, []);
});

test('outside dismissal prevents the browser from undoing the trigger focus restored by close', () => {
  for (const inside of [false, true]) {
    const calls = [];
    const event = { target: {}, preventDefault: () => calls.push('preventDefault') };
    dismissOverlayOutside(event, { contains: (target) => {
      assert.equal(target, event.target);
      return inside;
    } }, () => calls.push('close and focus trigger'));
    assert.deepEqual(calls, inside ? [] : ['preventDefault', 'close and focus trigger']);
  }
});
