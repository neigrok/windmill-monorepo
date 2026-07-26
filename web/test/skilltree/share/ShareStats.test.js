// The share "score" and its dominant kind — the tint the OG card (brief #12) carries. The
// dominant kind is the most common kind among DONE nodes, ties resolving to terracotta so the
// frame never picks an arbitrary winner. These pin exactly that rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareStats } from '../../../src/skilltree/share/ShareStats.js';

function treeOf(colors) {
  return { nodes: colors.map((color, index) => ({ id: `n${index}`, color })) };
}

function statesOf(states) {
  return new Map(states.map((state, index) => [`n${index}`, state]));
}

test('ShareStats.from counts done/total and elects the most common done kind', () => {
  const tree = treeOf(['olive', 'olive', 'gold', 'sky']);
  const states = statesOf(['complete', 'complete', 'complete', 'locked']);

  const stats = ShareStats.from(tree, states);
  assert.equal(stats.done, 3);
  assert.equal(stats.total, 4);
  assert.equal(stats.percent, 75);
  assert.equal(stats.dominantKind, 'olive');
});

test('a shared maximum among done kinds ties to terracotta, the brand hue', () => {
  const tree = treeOf(['olive', 'gold', 'sky']);
  const states = statesOf(['complete', 'complete', 'locked']);

  assert.equal(ShareStats.from(tree, states).dominantKind, 'terracotta');
});

test('no done nodes elects terracotta with a zero score', () => {
  const tree = treeOf(['olive', 'gold']);
  const states = statesOf(['available', 'locked']);

  const stats = ShareStats.from(tree, states);
  assert.equal(stats.done, 0);
  assert.equal(stats.percent, 0);
  assert.equal(stats.dominantKind, 'terracotta');
});

test('ShareStats.dominant reads a tally directly: sole leader wins, a tie falls to terracotta', () => {
  assert.equal(ShareStats.dominant(new Map([['sky', 5], ['gold', 2]])), 'sky');
  assert.equal(ShareStats.dominant(new Map([['olive', 3], ['gold', 3]])), 'terracotta');
  assert.equal(ShareStats.dominant(new Map()), 'terracotta');
});
