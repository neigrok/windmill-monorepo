// The grammar hands the composer values; the composer is where a person reads them. These hold the words, the glyphs
// and their order at the place that says them: each line's glyph and the liberty its title names, the readout, the
// chip, and the roadmap Plant hands on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, findByClass, loadScreen, renderHook, textOf } from '../../gym/harness.mjs';
import { parsePlan } from '../../../../src/products/roadmap/paste/planGrammar.js';

// The composer over `text`, its mirror measured as a browser's frame would, so every line that spoke shows its glyph.
async function composer(t, text, { kinds = [], append = false, budName = '' } = {}) {
  browserWith();
  const frames = [];
  globalThis.requestAnimationFrame = (run) => frames.push(run);
  globalThis.cancelAnimationFrame = () => {};
  const { PasteComposer } = await loadScreen('products/roadmap/paste/PasteComposer.jsx');
  const planted = [];
  const view = renderHook(t, () => PasteComposer({ text, onTextChange() {}, kinds, onKindsChange() {}, parse: parsePlan(text, kinds, { bindOnly: append }),
    budName, planting: false, onClose() {}, onPlant: (plan) => planted.push(plan), append }));
  findByClass(view.tree, 'pc-mirror')[0].ref.current = { children: text.split('\n').map((_, line) => ({ offsetTop: line * 20 })) };
  frames.splice(0).forEach((run) => run());
  return {
    gutter: () => findByClass(view.tree, 'pc-glyph').map((glyph) => [textOf(glyph), glyph.props.title ?? null, glyph.props.className]),
    foot: () => ({ readout: findByClass(view.tree, 'pc-readout').map(textOf), chip: findByClass(view.tree, 'pc-imperfect').map(textOf) }),
    nameField: () => findByClass(view.tree, 'pc-name').length,
    plant: () => { findByClass(view.tree, 'pc-plant')[0].props.onClick(); return planted; },
  };
}

test('every line that spoke shows its glyph, and a line kept as a note says so in its title and in the chip', async (t) => {
  const flagship = ['# Learn WebGL', '## Basics', '- [x] Read the spec', '- [ ] Draw a triangle', '  - Understand shaders', '## Projects', '1. Particle system', '2. Terrain renderer', 'Just a stray thought'].join('\n');
  const view = await composer(t, flagship);
  assert.deepEqual(view.gutter(), [
    ['◉', null, 'pc-glyph'], ['├', null, 'pc-glyph'], ['✓', null, 'pc-glyph pc-glyph--done'], ['·', null, 'pc-glyph'], ['·', null, 'pc-glyph'],
    ['├', null, 'pc-glyph'], ['·', null, 'pc-glyph'], ['·', null, 'pc-glyph'], ['¶', 'kept as a note', 'pc-glyph pc-glyph--note pc-glyph--liberty'],
  ]);
  assert.deepEqual(view.foot(), { readout: ['8 steps · 2 branches · 1 already done'], chip: ['1 line → note'] });
});

test('an indent off the document’s grid, a jump past the step above, a name cut to its bound and a renamed duplicate are each worded on their line', async (t) => {
  assert.deepEqual((await composer(t, 'Root\n- a\n    - b\n  - c')).gutter()[3], ['·', 'mixed indent clamped', 'pc-glyph pc-glyph--liberty']);
  assert.deepEqual((await composer(t, 'Root\n- a\n  - b\n        - deep')).gutter()[3], ['·', 'indent clamped', 'pc-glyph pc-glyph--liberty']);
  assert.deepEqual((await composer(t, `Root\n- ${'x'.repeat(250)}`)).gutter()[1], ['·', 'shortened to fit', 'pc-glyph pc-glyph--liberty']);
  const renamed = await composer(t, 'Plan\n- Foo\n- Foo\n- Foo (2)\n- Foo');
  assert.deepEqual(renamed.gutter().map(([, title]) => title), [null, null, 'renamed to "Foo (2)"', 'renamed to "Foo (2) (2)"', 'renamed to "Foo (3)"']);
  assert.deepEqual(renamed.foot(), { readout: ['5 steps'], chip: ['3 renamed'] });
});

test('a line that took several liberties words them in the order they were taken, and the chip counts each kind; an address that became a link took none', async (t) => {
  const view = await composer(t, 'Root\n- a\n  - b\n       - [x] a\nhalf a thought\nhttps://example.com/docs');
  assert.deepEqual(view.gutter().slice(3), [
    ['✓', 'mixed indent clamped · indent clamped · renamed to "a (2)"', 'pc-glyph pc-glyph--done pc-glyph--liberty'],
    ['¶', 'kept as a note', 'pc-glyph pc-glyph--note pc-glyph--liberty'],
    ['¶', null, 'pc-glyph pc-glyph--note'],
  ]);
  assert.deepEqual(view.foot(), { readout: ['4 steps · 1 already done'], chip: ['1 line → note · 2 clamped · 1 renamed'] });
});

test('Plant hands on the plan’s own name over a typed one, a typed name where the plan has none, and nothing while it has neither', async (t) => {
  const own = await composer(t, '# Learn to sail\n- Rig the boat', { budName: 'Typed name' });
  assert.equal(own.nameField(), 0);
  assert.deepEqual(own.plant(), [{ title: 'Learn to sail', kinds: [], nodes: [
    { id: 'learn-to-sail', label: 'Learn to sail', color: 'terracotta', prerequisites: [], icon: 'sparkles' },
    { id: 'rig-the-boat', label: 'Rig the boat', color: 'terracotta', prerequisites: ['learn-to-sail'] },
  ] }]);

  const typed = await composer(t, '- Rig the boat', { budName: `  ${'n'.repeat(250)}  ` });
  assert.equal(typed.nameField(), 1);
  assert.deepEqual(typed.plant(), [{ title: 'n'.repeat(200), kinds: [], nodes: [
    { id: 'root', label: 'n'.repeat(200), color: 'terracotta', prerequisites: [], icon: 'sparkles' },
    { id: 'rig-the-boat', label: 'Rig the boat', color: 'terracotta', prerequisites: ['root'] },
  ] }]);

  const unnamed = await composer(t, '- Rig the boat', { budName: '   ' });
  assert.equal(unnamed.nameField(), 1);
  assert.deepEqual(unnamed.plant(), []);
});

test('into an open roadmap the composer counts the steps a paste adds and hands the parse on as it read', async (t) => {
  const kinds = [{ id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' }];
  const view = await composer(t, '- Rig the boat\n- [x] Read the wind', { kinds, append: true });
  assert.deepEqual({ foot: view.foot(), nameField: view.nameField() }, { foot: { readout: ['2 steps · 1 already done'], chip: [] }, nameField: 0 });
  assert.deepEqual(view.plant(), [parsePlan('- Rig the boat\n- [x] Read the wind', kinds, { bindOnly: true })]);
});
