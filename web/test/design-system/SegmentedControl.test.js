import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../products/gym/harness.mjs';

const DS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/design-system');

const OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

const radios = (tree) => elementsOf(tree).filter((each) => each.props.role === 'radio');
const group = (tree) => elementsOf(tree).find((each) => each.props.role === 'radiogroup');
const thumb = (tree) => elementsOf(tree).find((each) => each.props.className === 'wm-segmented-thumb');

test('the bar is a radiogroup with one tab stop, on the chosen segment', async (t) => {
  browserWith();
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const view = renderHook(t, () => SegmentedControl({ label: 'Appearance', options: OPTIONS, value: 'dark', onChange: () => {} }));

  assert.equal(group(view.tree).props['aria-label'], 'Appearance');
  assert.equal(group(view.tree).props['aria-labelledby'], undefined);
  assert.deepEqual(radios(view.tree).map((each) => [textOf(each), each.props['aria-checked'], each.props.tabIndex]), [
    ['Light', false, -1],
    ['Dark', true, 0],
    ['System', false, -1],
  ]);
});

test('named by an element instead, the bar carries aria-labelledby and no aria-label', async (t) => {
  browserWith();
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const view = renderHook(t, () => SegmentedControl({ labelledBy: 'appearance-label', options: OPTIONS, value: 'dark', onChange: () => {} }));
  assert.equal(group(view.tree).props['aria-labelledby'], 'appearance-label');
  assert.equal(group(view.tree).props['aria-label'], undefined);
});

test('a click and an arrow both name the next choice, and the arrows wrap', async (t) => {
  browserWith();
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const chosen = [];
  const view = renderHook(t, () => SegmentedControl({ label: 'Appearance', options: OPTIONS, value: 'system', onChange: (next) => chosen.push(next) }));
  const key = (name) => ({ key: name, preventDefault: () => {} });

  radios(view.tree)[0].props.onClick();
  radios(view.tree)[2].props.onKeyDown(key('ArrowRight'));
  radios(view.tree)[0].props.onKeyDown(key('ArrowLeft'));
  radios(view.tree)[2].props.onKeyDown(key('Home'));
  radios(view.tree)[0].props.onKeyDown(key('End'));
  radios(view.tree)[1].props.onKeyDown(key('Tab'));
  assert.deepEqual(chosen, ['light', 'light', 'system', 'light', 'system']);
});

// Three equal columns that cannot grow past their share, and a card exactly one column wide slid
// across the columns and the gaps between them: the two rectangles coincide.
test('the chosen segment is the card thumb, slid one column and one gap per step', async (t) => {
  browserWith();
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const view = renderHook(t, () => SegmentedControl({ label: 'Appearance', options: OPTIONS, value: 'system', onChange: () => {} }));
  assert.equal(group(view.tree).props.style.gridTemplateColumns, 'repeat(3, minmax(0, 1fr))');
  assert.equal(thumb(view.tree).props['aria-hidden'], 'true');
  assert.equal(thumb(view.tree).props.style.width, 'calc((100% - 4px - 4px) / 3)');
  assert.equal(thumb(view.tree).props.style.transform, 'translateX(calc(200% + 4px))');
  assert.equal(thumb(view.tree).props.style.transition, 'transform var(--duration-fast) var(--ease-standard)');
  const sheet = elementsOf(view.tree).find((each) => each.type === 'style').props.children;
  for (const rule of [
    '.wm-segmented { position: relative; display: grid; gap: 2px; box-sizing: border-box; height: 28px; padding: 2px; border: none;',
    'background: var(--surface-sunken);',
    '.wm-segmented-thumb { position: absolute; top: 2px; left: 2px; height: 24px;',
    'background: var(--surface-card); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-xs); }',
    'height: 24px; padding: 0 10px 0 8px;',
    '.wm-segmented-segment:hover { background: var(--surface-hover); color: var(--text-secondary); }',
    '.wm-segmented-segment[aria-checked="true"] { color: var(--text-primary); }',
    '.wm-segmented-segment[aria-checked="true"] svg { color: var(--text-link); }',
    '.wm-segmented-segment:focus-visible { box-shadow: var(--focus-ring); }',
  ]) assert.ok(sheet.includes(rule), rule);
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(sheet), false, 'no hard-coded colour');
});

test('under reduced motion the thumb does not slide', async (t) => {
  browserWith();
  globalThis.window.matchMedia = () => ({ matches: true });
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const view = renderHook(t, () => SegmentedControl({ label: 'Appearance', options: OPTIONS, value: 'light', onChange: () => {} }));
  assert.equal(thumb(view.tree).props.style.transition, 'none');
});

// A value no option carries — a stored choice from an older build, say — checks nothing rather than
// lying about the first segment, and the bar keeps one tab stop so the keyboard can still reach it.
test('a value that matches no option checks no segment and draws no thumb', async (t) => {
  browserWith();
  const { SegmentedControl } = await loadScreen('design-system/forms/SegmentedControl.jsx');
  const view = renderHook(t, () => SegmentedControl({ label: 'Appearance', options: OPTIONS, value: 'sepia', onChange: () => {} }));
  assert.deepEqual(radios(view.tree).map((each) => [each.props['aria-checked'], each.props.tabIndex]), [[false, 0], [false, -1], [false, -1]]);
  assert.equal(thumb(view.tree), undefined);
});

test('the design system exports it, and the three appearance icons are registered', () => {
  assert.ok(fs.readFileSync(path.join(DS, 'index.js'), 'utf8').includes("export { SegmentedControl } from './forms/SegmentedControl.jsx';"));
  const icons = fs.readFileSync(path.join(DS, 'Icon.jsx'), 'utf8');
  for (const name of ['sun: Sun', 'moon: Moon', 'monitor: Monitor']) assert.ok(icons.includes(name), `${name} is not in the Icon registry`);
});
