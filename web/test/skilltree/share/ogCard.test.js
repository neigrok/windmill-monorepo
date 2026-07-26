// The OG card builder (brief #12) is pure — it takes a RenderModel + score and returns the
// unfurl SVG string. These pin the fit (glow-inclusive box + 8% pad, the clamp that keeps a
// sparse tree sane) and the frame's contract (2400×1260, title, n/m readout, watermark, one
// element per node, dominant-kind tint) so a refactor can't quietly drop a piece.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOgCardSvg, paddedGlowBox, clampViewBox } from '../../../src/skilltree/share/ogCard.js';
import { nodeGlowRadius } from '../../../src/skilltree/share/TreePortrait.js';

function modelOf(nodes, edges = []) {
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  return {
    nodes,
    edges,
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
  };
}

test('paddedGlowBox grows the tree by each node’s glow/crown footprint, then pads 8%', () => {
  const root = { id: 'a', x: 0, y: 0, emphasis: 1, state: 'complete', color: 'terracotta' };
  const leaf = { id: 'b', x: 200, y: 100, emphasis: 0, state: 'locked', color: 'olive' };
  const model = modelOf([root, leaf]);

  const gRoot = nodeGlowRadius(root);
  const gLeaf = nodeGlowRadius(leaf);
  const minX = Math.min(0 - gRoot, 200 - gLeaf);
  const minY = Math.min(0 - gRoot, 100 - gLeaf);
  const maxX = Math.max(0 + gRoot, 200 + gLeaf);
  const maxY = Math.max(0 + gRoot, 100 + gLeaf);
  const width = maxX - minX;
  const height = maxY - minY;
  const padX = width * 0.08;
  const padY = height * 0.08;

  assert.deepEqual(paddedGlowBox(model), {
    minX: minX - padX,
    minY: minY - padY,
    width: width + padX * 2,
    height: height + padY * 2,
  });
});

test('the steady box measures every node as if lit, so progress can never move a frame', () => {
  const plan = [
    { id: 'a', x: 0, y: 0, emphasis: 1, color: 'terracotta' },
    { id: 'b', x: 200, y: 100, emphasis: 0, color: 'olive' },
    { id: 'c', x: -200, y: 100, emphasis: 0, color: 'gold' },
  ];
  const at = (doneCount) => modelOf(plan.map((node, i) => ({ ...node, state: i < doneCount ? 'complete' : 'locked' })));

  // The as-drawn box swells as the tree fills — right for a one-off unfurl, fatal for a series.
  assert.notDeepEqual(paddedGlowBox(at(1)), paddedGlowBox(at(3)));
  // The steady box is the same box at every point in the plan.
  assert.deepEqual(paddedGlowBox(at(0), { steady: true }), paddedGlowBox(at(3), { steady: true }));
  assert.deepEqual(paddedGlowBox(at(1), { steady: true }), paddedGlowBox(at(3), { steady: true }));
  // …and it is exactly the footprint of the finished tree, which contains every earlier one.
  assert.deepEqual(paddedGlowBox(at(1), { steady: true }), paddedGlowBox(at(3)));
});

test('clampViewBox expands a too-small window to the floor, re-centered on the tree', () => {
  assert.deepEqual(
    clampViewBox({ minX: -100, minY: -50, width: 200, height: 100 }, 1000, 500),
    { minX: -500, minY: -250, width: 1000, height: 500 },
  );
});

test('clampViewBox clamps each axis independently and leaves a large window untouched', () => {
  assert.deepEqual(
    clampViewBox({ minX: 0, minY: 0, width: 2000, height: 100 }, 1000, 500),
    { minX: 0, minY: -200, width: 2000, height: 500 },
  );
  assert.deepEqual(
    clampViewBox({ minX: 10, minY: 20, width: 2000, height: 1500 }, 1000, 500),
    { minX: 10, minY: 20, width: 2000, height: 1500 },
  );
});

test('buildOgCardSvg emits a 2400×1260 card with title, n/m readout, watermark, one element per node', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, emphasis: 1, state: 'complete', color: 'olive' },
    { id: 'b', x: 160, y: 0, emphasis: 0, state: 'complete', color: 'olive' },
    { id: 'c', x: -160, y: 0, emphasis: 0, state: 'available', color: 'gold' },
  ];
  const svg = buildOgCardSvg({ model: modelOf(nodes), title: 'Learn to sail', done: 2, total: 3, dominantKind: 'olive' });

  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('width="2400" height="1260"'));
  assert.ok(svg.includes('Learn to sail'));
  assert.ok(svg.includes('>2/3</text>'));
  assert.ok(svg.includes('Made with <tspan'));
  assert.ok(svg.includes('>Windmill</tspan>'));
  assert.equal((svg.match(/class="wm-node"/g) || []).length, nodes.length);
});

test('the dominant kind tints the rule + dot + panel border; Windmill stays terracotta', () => {
  const nodes = [{ id: 'a', x: 0, y: 0, emphasis: 1, state: 'complete', color: 'olive' }];
  const svg = buildOgCardSvg({ model: modelOf(nodes), title: 'Sea legs', done: 1, total: 1, dominantKind: 'olive' });

  assert.ok(svg.includes('#7D8C43')); // olive base — rule + title dot
  assert.ok(svg.includes('stroke="#D2DAA5"')); // olive soft — panel border
  assert.ok(svg.includes('fill="#BC6C42"')); // terracotta — the Windmill wordmark, whatever the dominant kind
});

test('buildOgCardSvg guards the title to one ellipsized line when it overflows the strip', () => {
  const nodes = [{ id: 'a', x: 0, y: 0, emphasis: 1, state: 'available', color: 'terracotta' }];
  const longTitle = 'A roadmap title so absurdly long that it could never fit inside the postcard strip without being cut short';
  const svg = buildOgCardSvg({ model: modelOf(nodes), title: longTitle, done: 0, total: 1, dominantKind: 'terracotta' });

  assert.ok(svg.includes('…'));
  assert.ok(!svg.includes(longTitle));
});
