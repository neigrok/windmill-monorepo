import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserWith, findByClass, loadScreen, renderHook, textOf } from '../products/gym/harness.mjs';

const DS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/design-system');

// The window's listeners, so a key or a pointer can be sent the way the browser would.
function listeningWindow() {
  browserWith();
  const bound = new Map();
  window.addEventListener = (type, fn) => bound.set(type, [...(bound.get(type) ?? []), fn]);
  window.removeEventListener = (type, fn) => bound.set(type, (bound.get(type) ?? []).filter((each) => each !== fn));
  return {
    fire: (type, event) => (bound.get(type) ?? []).forEach((fn) => fn(event)),
    count: (type) => (bound.get(type) ?? []).length,
  };
}

const items = (ran) => [
  { label: 'Duplicate', run: () => ran.push('Duplicate') },
  { label: 'Delete', run: () => ran.push('Delete') },
];

test('the menu is closed until its opener is pressed, and the opener says so', async (t) => {
  listeningWindow();
  const { Menu } = await loadScreen('design-system/core/Menu.jsx');
  const menu = renderHook(t, () => Menu({ label: 'More for Push A', items: items([]) }));

  const opener = () => findByClass(menu.tree, 'wm-menu-open')[0];
  assert.equal(opener().props['aria-label'], 'More for Push A');
  assert.equal(opener().props['aria-haspopup'], 'menu');
  assert.equal(opener().props['aria-expanded'], false);
  assert.equal(findByClass(menu.tree, 'wm-menu-list').length, 0);

  opener().props.onClick();
  assert.equal(opener().props['aria-expanded'], true);
  const list = findByClass(menu.tree, 'wm-menu-list');
  assert.equal(list.length, 1);
  assert.equal(list[0].props.role, 'menu');
  const drawn = findByClass(menu.tree, 'wm-menu-item');
  assert.deepEqual(drawn.map(textOf), ['Duplicate', 'Delete']);
  assert.deepEqual(drawn.map((each) => each.props.role), ['menuitem', 'menuitem']);

  opener().props.onClick();
  assert.equal(opener().props['aria-expanded'], false, 'the opener toggles');
});

test('an item runs its act and closes the menu in the same press', async (t) => {
  listeningWindow();
  const { Menu } = await loadScreen('design-system/core/Menu.jsx');
  const ran = [];
  const menu = renderHook(t, () => Menu({ label: 'More', items: items(ran) }));
  findByClass(menu.tree, 'wm-menu-open')[0].props.onClick();
  findByClass(menu.tree, 'wm-menu-item')[1].props.onClick();
  assert.deepEqual(ran, ['Delete']);
  assert.equal(findByClass(menu.tree, 'wm-menu-list').length, 0);
});

test('Escape and a pointer outside close it, and the listeners live only while it is open', async (t) => {
  const win = listeningWindow();
  const { Menu } = await loadScreen('design-system/core/Menu.jsx');
  const menu = renderHook(t, () => Menu({ label: 'More', items: items([]) }));
  const open = () => findByClass(menu.tree, 'wm-menu-open')[0].props.onClick();
  const isOpen = () => findByClass(menu.tree, 'wm-menu-list').length === 1;
  assert.equal(win.count('keydown'), 0);
  assert.equal(win.count('pointerdown'), 0);

  open();
  assert.equal(isOpen(), true);
  assert.equal(win.count('keydown'), 1);
  assert.equal(win.count('pointerdown'), 1);
  win.fire('keydown', { key: 'Enter' });
  assert.equal(isOpen(), true, 'only Escape closes');
  win.fire('keydown', { key: 'Escape' });
  assert.equal(isOpen(), false);
  assert.equal(win.count('keydown'), 0, 'unbound with the close');
  assert.equal(win.count('pointerdown'), 0);

  open();
  // No element is mounted in this harness, so nothing is inside the box: the pointer is outside.
  win.fire('pointerdown', { target: {} });
  assert.equal(isOpen(), false);
});

test('the menu paints off the shared roles alone, and gym reaches it through the index', () => {
  const css = fs.readFileSync(path.join(DS, '../styles/global.css'), 'utf8');
  for (const rule of ['.wm-menu {', '.wm-menu-open {', '.wm-menu-list {', '.wm-menu-item {']) {
    assert.equal(css.includes(rule), true, rule);
  }
  const block = css.slice(css.indexOf('.wm-menu {'));
  assert.equal(/--gym-/.test(block), false, 'no product token in the design system');
  assert.equal(fs.readFileSync(path.join(DS, 'index.js'), 'utf8').includes("export { Menu } from './core/Menu.jsx';"), true);
});
