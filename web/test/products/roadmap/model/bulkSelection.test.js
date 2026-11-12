import test from 'node:test';
import assert from 'node:assert/strict';

import { bulkKindChoice, isGrouped, markDoneTargets, sharedKind } from '../../../../src/products/roadmap/model/bulkSelection.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { NODE_COLOR_NAMES } from '../../../../src/products/roadmap/theme.js';

test('isGrouped — a single selection is not grouped (keeps the loud terracotta look)', () => {
  assert.equal(isGrouped(0), false);
  assert.equal(isGrouped(1), false);
});

test('isGrouped — two or more is grouped (the quiet bark treatment)', () => {
  assert.equal(isGrouped(2), true);
  assert.equal(isGrouped(5), true);
});

const steps = (...extra) => new SkillTree({ id: 'abc', title: 'ABC', nodes: [
  { id: 'a', label: 'A', prerequisites: [] }, { id: 'b', label: 'B', prerequisites: [] }, { id: 'c', label: 'C', prerequisites: [] }, ...extra,
] });

test('markDoneTargets — an empty selection completes nothing', () => {
  assert.deepEqual(markDoneTargets(steps(), new Set(), new Set()), []);
});

test('markDoneTargets — a set with none complete marks every member', () => {
  assert.deepEqual(markDoneTargets(steps(), new Set(['a', 'b', 'c']), new Set()), ['a', 'b', 'c']);
});

test('markDoneTargets — already-complete members are skipped (no completion replays)', () => {
  assert.deepEqual(markDoneTargets(steps(), new Set(['a', 'b', 'c']), new Set(['b'])), ['a', 'c']);
});

test('markDoneTargets — a fully-complete set marks nothing', () => {
  assert.deepEqual(markDoneTargets(steps(), new Set(['a', 'b']), new Set(['a', 'b', 'z'])), []);
});

test('markDoneTargets — a step that opens a tree is left out, and a step the roadmap dropped is marked as before', () => {
  const tree = steps({ id: 'sail', label: 'Learn to sail', prerequisites: [], opens: 't_sail', opening: Opening.unread('t_sail') });

  assert.deepEqual(markDoneTargets(tree, new Set(['a', 'sail', 'gone']), new Set()), ['a', 'gone']);
});

const tree = new SkillTree({ id: 'sail', title: 'Sail', nodes: [
  { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' },
  { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'sky' },
  { id: 'solo', label: 'Sail solo', prerequisites: ['dock'] },
] });

test('sharedKind — a selection shares a kind only when every step wears it and the tree still has them all', () => {
  assert.equal(sharedKind(tree, []), null);
  assert.equal(sharedKind(null, ['wind']), null);
  assert.equal(sharedKind(tree, ['wind']), 'sky');
  assert.equal(sharedKind(tree, ['wind', 'dock']), 'sky');
  assert.equal(sharedKind(tree, ['solo']), 'terracotta');
  assert.equal(sharedKind(tree, ['dock', 'solo']), null);
  assert.equal(sharedKind(tree, ['wind', 'missing']), null);
});

test('bulkKindChoice — every bar offers the six choices: what the legend names first, then the unnamed hues in palette order, wherever a worn hue was derived', () => {
  const legend = [{ id: 'k-learn', hue: 'sky', label: 'Learn' }, { id: 'k-ship', hue: 'gold', label: '' }, { id: 'k-twin', hue: 'sky', label: 'Twin' }];
  const choice = bulkKindChoice(tree, ['wind', 'dock'], legend);
  assert.deepEqual(choice, {
    shared: 'sky',
    kinds: [
      { id: 'k-learn', hue: 'sky', label: 'Learn' },
      ...NODE_COLOR_NAMES.filter((hue) => hue !== 'sky').map((hue) => ({ id: hue, hue, label: `${hue[0].toUpperCase()}${hue.slice(1)}` })),
    ],
  });
  assert.equal(bulkKindChoice(tree, [], []).shared, null);
  assert.deepEqual(bulkKindChoice(tree, [], []).kinds.map((kind) => kind.hue), NODE_COLOR_NAMES);
});
