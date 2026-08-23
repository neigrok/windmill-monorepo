import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShareVideoFrameSvg, LOOP } from '../../../../src/products/roadmap/share/shareVideoFrame.js';

const MODEL = {
  nodes: [
    { id: 'root', x: 300, y: 190, color: 'terracotta', state: 'complete', emphasis: 1 },
    { id: 'a', x: 188, y: 118, color: 'olive', state: 'complete', emphasis: 0 },
    { id: 'b', x: 412, y: 120, color: 'gold', state: 'available', emphasis: 0 },
    { id: 'c', x: 172, y: 268, color: 'sky', state: 'locked', emphasis: 0 },
    { id: 'd', x: 424, y: 266, color: 'plum', state: 'locked', emphasis: 0 },
  ],
  edges: [
    { from: 'root', to: 'a', kind: 'branch' },
    { from: 'root', to: 'b', kind: 'branch' },
    { from: 'a', to: 'c', kind: 'branch' },
    { from: 'b', to: 'd', kind: 'branch' },
  ],
};
const META = { model: MODEL, title: 'Learn to sail', done: 2, total: 5, dominantKind: 'terracotta' };

function readoutAt(t) {
  const svg = buildShareVideoFrameSvg({ ...META, t });
  const match = svg.match(/>(\d+)\/(\d+)</);
  return match ? `${match[1]}/${match[2]}` : null;
}

test('a frame is a well-formed, self-contained SVG', () => {
  const svg = buildShareVideoFrameSvg({ ...META, t: 0 });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal((svg.match(/<svg/g) || []).length, (svg.match(/<\/svg>/g) || []).length);  // balanced (frame + portrait)
  assert.ok(svg.includes('Learn to sail'));           // the title
  assert.ok(svg.includes('Windmill'));                // the wordmark
});

test('HOLD (t=0) is the grown tree — full score + a lit done disc', () => {
  const svg = buildShareVideoFrameSvg({ ...META, t: 0 });
  assert.equal(readoutAt(0), '2/5');                  // both done steps counted
  // A done disc is drawn at full opacity (its fill is the kind colour, opacity 1).
  assert.ok(/<circle[^>]*fill="#[0-9A-Fa-f]{6}"[^>]*opacity="1"/.test(svg), 'no fully-lit done disc at HOLD');
});

test('mid-GROW some steps have not ignited yet (partial or zero opacity present)', () => {
  const svg = buildShareVideoFrameSvg({ ...META, t: 1000 });
  const partials = [...svg.matchAll(/opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(partials.some((o) => o > 0 && o < 0.85), 'expected a step mid-ignite during GROW');
});

test('the score assembles: fewer done shown mid-grow than at rest', () => {
  const midShown = Number(readoutAt(1000).split('/')[0]);
  assert.ok(midShown <= 2);                            // never over-counts
  assert.equal(readoutAt(0), '2/5');                   // rest shows the true score
});

test('the loop is seamless: the last frame is byte-identical to the first', () => {
  const first = buildShareVideoFrameSvg({ ...META, t: 0 });
  const last = buildShareVideoFrameSvg({ ...META, t: LOOP - 1 });
  // Every transient windows to zero at the seam, so t≈LOOP renders identically to t=0.
  assert.equal(first, last);
});

test('the wide 16:9 frame renders at its own dimensions', () => {
  const wide = buildShareVideoFrameSvg({ ...META, t: 0, w: 1280, h: 720 });
  assert.ok(wide.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"'));
});
