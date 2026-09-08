import test from 'node:test';
import assert from 'node:assert/strict';

import { treePortraitSvg } from '../../../../src/products/roadmap/share/TreePortrait.js';
import { SHARE_PALETTE } from '../../../../src/products/roadmap/share/palette.js';

const PAL = SHARE_PALETTE.light;
const BOX = { w: 1200, h: 630 };

const MODEL = {
  nodes: [
    { id: 'root', x: 0, y: 0, color: 'terracotta', state: 'complete', emphasis: 1 },
    { id: 'a', x: 160, y: 90, color: 'olive', state: 'complete', emphasis: 0 },
    { id: 'b', x: -160, y: 90, color: 'gold', state: 'available', emphasis: 0 },
    { id: 'c', x: 300, y: 200, color: 'sky', state: 'locked', emphasis: 0 },
    { id: 'd', x: -300, y: 200, color: 'plum', state: 'locked', emphasis: 0 },
  ],
  edges: [
    { from: 'root', to: 'a', kind: 'branch' },
    { from: 'root', to: 'b', kind: 'branch' },
    { from: 'a', to: 'c', kind: 'branch' },
    { from: 'b', to: 'd', kind: 'branch' },
  ],
  bounds: { minX: -300, minY: 0, maxX: 300, maxY: 200 },
};

function stable(svg) {
  return svg.replace(/wm-glow-\d+/g, 'wm-glow');
}

function edgeInk(svg) {
  return [...svg.matchAll(/stroke="([^"]+)" stroke-width="([\d.]+)" stroke-linecap="round" opacity="([\d.]+)"/g)]
    .map((m) => `${m[1]} ${m[2]} ${m[3]}`);
}

test('gallery portraits preserve node states, crown and branch ink', () => {
  const plain = treePortraitSvg(MODEL, PAL, BOX);
  assert.equal((plain.match(/class="wm-node"/g) || []).length, MODEL.nodes.length);
  assert.equal((plain.match(/filter="url\(#wm-glow-\d+\)"/g) || []).length, 2);
  assert.deepEqual(edgeInk(plain), [
    '#9C6B44 1.96 0.92',
    '#9C6B44 1.96 0.92',
    '#9C6B44 1.96 0.92',
    '#D3C2A0 1.4 0.75',
  ]);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX)), stable(plain));
});
