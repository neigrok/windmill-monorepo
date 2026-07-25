// The portrait's highlight seam (brief #20). Two things matter here: the veil dims exactly the
// complement of the highlight set, and NOT highlighting is byte-identical to the portrait every
// other share surface already draws — the OG card's fit test and the share clip's loop seam both
// pin that markup, so the seam has to be invisible when nobody opens it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { treePortraitSvg } from '../../../src/skilltree/share/TreePortrait.js';
import { SHARE_PALETTE } from '../../../src/skilltree/share/palette.js';

const PAL = SHARE_PALETTE.light;
const BOX = { w: 1200, h: 630 };

const MODEL = {
  nodes: [
    { id: 'root', x: 0, y: 0, color: 'terracotta', state: 'complete', emphasis: 1 },
    { id: 'a', x: 160, y: 90, color: 'olive', state: 'complete', emphasis: 0 },
    { id: 'b', x: -160, y: 90, color: 'gold', state: 'available', emphasis: 0 },
    { id: 'c', x: 300, y: 200, color: 'sky', state: 'locked', emphasis: 0 },
  ],
  edges: [
    { from: 'root', to: 'a', kind: 'branch' },
    { from: 'root', to: 'b', kind: 'branch' },
    { from: 'a', to: 'c', kind: 'branch' },
  ],
  bounds: { minX: -160, minY: 0, maxX: 300, maxY: 200 },
};

// Each call mints a fresh filter id so many portraits on one page never collide — that counter is
// the only thing that legitimately differs between two renders of the same model.
function stable(svg) {
  return svg.replace(/wm-glow-\d+/g, 'wm-glow');
}

test('omitting options renders byte-identically to today’s portrait', () => {
  const base = stable(treePortraitSvg(MODEL, PAL, BOX));
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, undefined)), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, {})), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, { highlight: null, dim: 0.28 })), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, { highlight: new Set(), dim: 0.28 })), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, { highlight: new Set(['root']) })), base);
});

test('a highlight veils exactly the complement — every other node group carries the dim', () => {
  const svg = treePortraitSvg(MODEL, PAL, BOX, undefined, { highlight: new Set(['root', 'a']), dim: 0.28 });

  assert.equal((svg.match(/class="wm-node"/g) || []).length, MODEL.nodes.length);
  assert.equal((svg.match(/<g class="wm-node" opacity="0\.28">/g) || []).length, 2); // b and c
  assert.equal((svg.match(/<g class="wm-node">/g) || []).length, 2);                 // root and a
});

test('an edge keeps its opacity only when BOTH endpoints are highlighted', () => {
  const plain = treePortraitSvg(MODEL, PAL, BOX);
  const veiled = treePortraitSvg(MODEL, PAL, BOX, undefined, { highlight: new Set(['root', 'a']), dim: 0.28 });

  // All three edges leave a lit source (root and a are complete), so each draws at 0.92 unveiled.
  assert.deepEqual([...plain.matchAll(/opacity="([\d.]+)"\/>/g)].map((m) => m[1]), ['0.92', '0.92', '0.92']);
  // root→a survives whole; root→b and a→c drop to 0.92 × 0.28.
  assert.deepEqual([...veiled.matchAll(/opacity="([\d.]+)"\/>/g)].map((m) => m[1]), ['0.92', '0.26', '0.26']);
});
