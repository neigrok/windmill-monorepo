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

test('no period renders byte-identically to today’s portrait', () => {
  const base = stable(treePortraitSvg(MODEL, PAL, BOX));
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, undefined)), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, {})), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, { lit: null })), base);
  assert.equal(stable(treePortraitSvg(MODEL, PAL, BOX, undefined, { lit: new Set() })), base);
});

test('the period ink is a four-tier ladder: only this period’s work keeps the in-app look', () => {
  const plain = treePortraitSvg(MODEL, PAL, BOX);
  const period = treePortraitSvg(MODEL, PAL, BOX, undefined, { lit: new Set(['a']) });

  assert.equal((period.match(/class="wm-node"/g) || []).length, MODEL.nodes.length);
  assert.equal((plain.match(/filter="url\(#wm-glow-\d+\)"/g) || []).length, 2);
  assert.equal((period.match(/filter="url\(#wm-glow-\d+\)"/g) || []).length, 1);

  // a (new): the app's own done look, borrowed whole — halo, ring at .55, full kind disc, specular.
  assert.ok(period.includes('<circle cx="160" cy="90" r="57.4" fill="rgba(125,140,67,0.42)"'));
  assert.ok(period.includes('<circle cx="160" cy="90" r="31.64" fill="none" stroke="rgba(125,140,67,.55)" stroke-width="2.52"/>'));
  assert.ok(period.includes('<circle cx="160" cy="90" r="28" fill="#7D8C43"/>'));
  assert.ok(period.includes('fill="rgba(255,255,255,.4)"'));

  // root (settled, done before): kind at 34%, ring at 50%, no halo, crown at 42%.
  assert.ok(period.includes('<circle cx="0" cy="0" r="42.71" fill="none" stroke="rgba(188,108,66,0.5)" stroke-width="3.4"/>'));
  assert.ok(period.includes('<circle cx="0" cy="0" r="37.8" fill="rgba(188,108,66,0.34)"/>'));
  assert.ok(period.includes('<g opacity="0.42"><path d="M-28.35 -43.47'));

  // b (available): white disc, kind ring at 55%.
  assert.ok(period.includes('<circle cx="-160" cy="90" r="28" fill="#FFFFFF" stroke="rgba(196,151,47,0.55)" stroke-width="2.02"/>'));

  // c (locked): kind at 12%, ring at 28%.
  assert.ok(period.includes('<circle cx="300" cy="200" r="24.64" fill="rgba(95,132,148,0.12)" stroke="rgba(95,132,148,0.28)" stroke-width="1.29"/>'));
});

test('the edge INTO a new step is that step’s kind at full alpha — the route, drawn', () => {
  const plain = treePortraitSvg(MODEL, PAL, BOX);
  const period = treePortraitSvg(MODEL, PAL, BOX, undefined, { lit: new Set(['a']) });

  assert.deepEqual(edgeInk(plain), [
    '#9C6B44 1.96 0.92',   // root → a
    '#9C6B44 1.96 0.92',   // root → b
    '#9C6B44 1.96 0.92',   // a → c
    '#D3C2A0 1.4 0.75',    // b → d  (b is available, so its branch is dormant)
  ]);

  assert.deepEqual(edgeInk(period), [
    '#7D8C43 2.18 1',      // root → a  — INTO the new step, in olive, thicker, full alpha
    '#9C6B44 1.96 0.34',   // root → b  — a lit edge that is not the route recedes to 34%
    '#9C6B44 1.96 0.34',   // a → c
    '#D3C2A0 1.4 0.5',     // b → d     — dormant edges sit at 50%, thin
  ]);
});

test('every step lighting at once lights every edge into one — the whole route home', () => {
  const period = treePortraitSvg(MODEL, PAL, BOX, undefined, { lit: new Set(['a', 'b', 'c', 'd']) });

  assert.deepEqual(edgeInk(period), [
    '#7D8C43 2.18 1',      // → a, olive
    '#C4972F 2.18 1',      // → b, gold
    '#5F8494 2.18 1',      // → c, sky
    '#8D4F83 2.18 1',      // → d, plum
  ]);
});
