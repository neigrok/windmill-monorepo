// The landing nav's Light · Dark bar: two segments, the checked one the RESOLVED appearance — so with
// nothing stored it reads the device and moves when the device flips — and a pick stores a choice.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

const MARKETING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/shell/marketing');

// The device prefers dark before the store is first loaded, so "nothing stored" resolves to dark.
const disk = new Map();
const query = { matches: true, handlers: [], addEventListener(type, fn) { this.handlers.push(fn); }, removeEventListener() {} };
globalThis.window = { matchMedia: () => query, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => disk.set(key, value),
  removeItem: (key) => disk.delete(key),
};

// The toggle and the bar it draws, rendered as one so a redraw reaches both.
const mount = (t, AppearanceToggle) => renderHook(t, () => {
  const bar = elementsOf(AppearanceToggle()).find((each) => typeof each.type === 'function');
  return bar.type(bar.props);
});
const radios = (tree) => elementsOf(tree).filter((each) => each.props.role === 'radio');
const state = (tree) => radios(tree).map((each) => [textOf(each), each.props['aria-label'], each.props['aria-checked']]);

test('with nothing stored the checked segment is the device side, and it moves with the device', async (t) => {
  const { subscribeAppearance } = await loadScreen('shell/appearance.js');
  const { AppearanceToggle } = await loadScreen('shell/marketing/AppearanceToggle.jsx');
  const view = mount(t, AppearanceToggle);

  assert.equal(elementsOf(view.tree).find((each) => each.props.role === 'radiogroup').props['aria-label'], 'Appearance');
  assert.deepEqual(state(view.tree), [['Light', 'Light', false], ['Dark', 'Dark', true]], 'two segments, no System, dark checked');
  assert.equal(disk.has('windmill:appearance'), false, 'nothing was stored by reading');

  const unsubscribe = subscribeAppearance(() => {});
  query.matches = false;
  query.handlers.forEach((fn) => fn());
  view.redraw();
  assert.deepEqual(state(view.tree), [['Light', 'Light', true], ['Dark', 'Dark', false]]);
  assert.equal(disk.has('windmill:appearance'), false, 'a device flip is still not a choice');
  unsubscribe();
});

test('picking a segment stores it, even the one already checked', async (t) => {
  const { setAppearance } = await loadScreen('shell/appearance.js');
  const { AppearanceToggle } = await loadScreen('shell/marketing/AppearanceToggle.jsx');
  setAppearance('system');
  disk.clear();
  const view = mount(t, AppearanceToggle);
  const pick = (word) => { radios(view.tree).find((each) => textOf(each) === word).props.onClick(); view.redraw(); };

  assert.deepEqual(state(view.tree), [['Light', 'Light', true], ['Dark', 'Dark', false]]);
  pick('Light');
  assert.equal(disk.get('windmill:appearance'), 'light', 'the checked segment, picked, becomes an explicit choice');
  assert.deepEqual(state(view.tree), [['Light', 'Light', true], ['Dark', 'Dark', false]]);
  pick('Dark');
  assert.equal(disk.get('windmill:appearance'), 'dark');
  assert.deepEqual(state(view.tree), [['Light', 'Light', false], ['Dark', 'Dark', true]]);
  setAppearance('system');
});

test('under 480px the word hides and aria-label keeps it', async (t) => {
  const { AppearanceToggle } = await loadScreen('shell/marketing/AppearanceToggle.jsx');
  const view = mount(t, AppearanceToggle);
  const words = elementsOf(view.tree).filter((each) => each.props.className === 'landing-appearance-word').map(textOf);
  assert.deepEqual(words, ['Light', 'Dark']);
  assert.deepEqual(radios(view.tree).map((each) => each.props['aria-label']), ['Light', 'Dark']);

  const css = fs.readFileSync(path.join(MARKETING, 'landing.css'), 'utf8');
  const narrow = /@media \(max-width: 479px\) \{([^}]*\}[^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(narrow, /\.landing-appearance-word \{ display: none; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('.landing-appearance')), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'the toggle names no colour of its own');
});
