import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintOf, footprintRect } from '../../../../src/products/roadmap/model/footprint.js';
import { WORKING_ZOOM } from '../../../../src/products/roadmap/theme.js';

const px = (footprint) => ({ w: footprint.widthWu * WORKING_ZOOM, h: footprint.heightWu * WORKING_ZOOM, lines: footprint.lines });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('the reserved box is the 52 px disc, an 8 px gap and 20 px per caption line, from the label length alone', () => {
  const short = px(footprintOf('Plan'));               // 4 chars × 6.65 = 26.6 px of text
  assert.ok(near(short.w, 52) && near(short.h, 80) && short.lines === 1, JSON.stringify(short));

  const medium = px(footprintOf('Ship the caption system')); // 23 chars → 8 + 152.95 = 160.95 px, one line
  assert.ok(near(medium.w, 160.95) && near(medium.h, 80) && medium.lines === 1, JSON.stringify(medium));

  const atEdge = px(footprintOf('x'.repeat(24)));      // 159.6 px of text still fits one 160 px line
  assert.ok(near(atEdge.w, 167.6) && atEdge.lines === 1, JSON.stringify(atEdge));

  const wrapped = px(footprintOf('x'.repeat(25)));     // 166.25 px of text wraps; the box caps at 168 px
  assert.ok(near(wrapped.w, 168) && near(wrapped.h, 100) && wrapped.lines === 2, JSON.stringify(wrapped));

  const long = px(footprintOf('Shell · the capsule keeps the account seat and the product switcher together on every surface'));
  assert.ok(near(long.w, 168) && near(long.h, 100) && long.lines === 2, JSON.stringify(long));
});

test('a crowned root reserves its 80.6 px body; an unnamed bud reserves a one-line seat', () => {
  const root = px(footprintOf('Windmill', { root: true }));
  assert.ok(near(root.w, 80.6) && near(root.h, 108.6) && root.lines === 1, JSON.stringify(root));
  const bud = px(footprintOf(''));
  assert.ok(near(bud.w, 52) && near(bud.h, 80) && bud.lines === 1, JSON.stringify(bud));
  assert.deepEqual(footprintOf(undefined), footprintOf(''));
});

test('the rect hangs the caption below the disc centred at the node', () => {
  const footprint = footprintOf('x'.repeat(25));
  const rect = footprintRect(100, 200, footprint);
  const bodyWu = 52 / WORKING_ZOOM;
  assert.ok(near(rect.minX, 100 - 84 / WORKING_ZOOM) && near(rect.maxX, 100 + 84 / WORKING_ZOOM));
  assert.ok(near(rect.minY, 200 - bodyWu / 2) && near(rect.maxY, 200 - bodyWu / 2 + 100 / WORKING_ZOOM));
});
