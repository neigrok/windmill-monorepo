import test from 'node:test';
import assert from 'node:assert/strict';

import { bendOf } from '../../../../src/products/roadmap/scene/ConnectorBatch.js';

test('an edge bows by the same amount wherever its ends are', () => {
  assert.equal(bendOf('root', 'child'), bendOf('root', 'child'));
});

test('different edges bow differently', () => {
  const bends = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => bendOf('root', id)));
  assert.ok(bends.size >= 6, `only ${bends.size} distinct bows across 8 edges`);
});

test('the bow stays within half a span either way', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const bend = bendOf('root', id);
    assert.ok(bend >= -0.5 && bend < 0.5, `${id} bows ${bend}`);
  }
});

// An edge keeps its shape when an end moves, measured as deviation from its own chord (scale-free).
import { writeEdgePositions } from '../../../../src/products/roadmap/scene/ConnectorBatch.js';

function bowRatio(fx, fy, tx, ty, sway) {
  const positions = new Float32Array(4096);
  writeEdgePositions(positions, 0, fx, fy, tx, ty, 4, sway);
  const at = (v) => ({ x: (positions[v * 4] + positions[v * 4 + 2]) / 2, y: (positions[v * 4 + 1] + positions[v * 4 + 3]) / 2 });
  const first = at(0), last = at(24), mid = at(12);
  const chord = Math.hypot(last.x - first.x, last.y - first.y) || 1;
  const ux = (last.x - first.x) / chord, uy = (last.y - first.y) / chord;
  const offset = (mid.x - first.x) * -uy + (mid.y - first.y) * ux;  // perpendicular deviation
  return offset / chord;
}

test('an edge keeps its shape when one end is dragged', () => {
  const sway = bendOf('root', 'child');
  const home = bowRatio(0, 0, 400, 0, sway);
  for (const [x, y] of [[380, 120], [260, 300], [0, 400], [-300, 260], [-400, 20]]) {
    const moved = bowRatio(0, 0, x, y, sway);
    assert.ok(Math.abs(moved - home) < 0.02, `bow changed from ${home.toFixed(3)} to ${moved.toFixed(3)}`);
  }
});

test('two edges of the same length still bow differently', () => {
  const a = bowRatio(0, 0, 400, 0, bendOf('root', 'one'));
  const b = bowRatio(0, 0, 400, 0, bendOf('root', 'two'));
  assert.ok(Math.abs(a - b) > 0.01, 'edges should not all bow alike');
});
