import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularInsertionIndex, reorderSlot, reorderPlan } from '../../../../../src/products/roadmap/scene/input/reorderGeometry.js';
import { nKeysBetween } from '../../../../../src/products/roadmap/sync/fractionalIndex.js';


test('circularInsertionIndex: empty and single', () => {
  assert.equal(circularInsertionIndex([], 1.2), 0);
  assert.equal(circularInsertionIndex([0], 0.2), 1); // just CCW of the lone sibling → after
  assert.equal(circularInsertionIndex([0], -0.2), 0); // just CW → before
});

test('circularInsertionIndex: full even ring, every gap', () => {
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  assert.equal(circularInsertionIndex(ring, 0), 0); // at the seam (between last and first) → prepend
  assert.equal(circularInsertionIndex(ring, Math.PI / 2), 1); // between 0 and 1
  assert.equal(circularInsertionIndex(ring, Math.PI), 2); // between 1 and 2
  assert.equal(circularInsertionIndex(ring, (3 * Math.PI) / 2), 3); // between 2 and 3
  assert.equal(circularInsertionIndex(ring, (7 * Math.PI) / 4 + 0.1), 4); // just past the last → append
});

test('circularInsertionIndex: partial wedge maps before/within/after', () => {
  const wedge = [0.2, 0.4, 0.6]; // a narrow arc; the rest of the circle is the seam gap
  assert.equal(circularInsertionIndex(wedge, 0.1), 0); // before the first
  assert.equal(circularInsertionIndex(wedge, 0.3), 1); // between 0 and 1
  assert.equal(circularInsertionIndex(wedge, 0.5), 2); // between 1 and 2
  assert.equal(circularInsertionIndex(wedge, 0.7), 3); // after the last
});

test('circularInsertionIndex: a wedge straddling the ±π atan2 seam', () => {
  const wedge = [2.9, 3.1, -3.0]; // sort order = increasing sweep angle across π
  assert.equal(circularInsertionIndex(wedge, 3.14), 2); // between 3.1 and the wrapped -3.0
  assert.equal(circularInsertionIndex(wedge, 2.8), 0); // before the first
});

test('reorderPlan: key lands strictly between the slot neighbours', () => {
  const k = nKeysBetween(null, null, 4);
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const sibs = k.map((o, i) => sib(o, ring[i]));
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // between 1 and 2
  assert.equal(plan.index, 2);
  assert.ok(k[1] < plan.key && plan.key < k[2], `expected ${k[1]} < ${plan.key} < ${k[2]}`);
});

test('reorderPlan: prepend and append produce keys outside the ends', () => {
  const k = nKeysBetween(null, null, 4);
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const sibs = k.map((o, i) => sib(o, ring[i]));
  const prepend = reorderPlan(sibs, { x: Math.cos(0), y: Math.sin(0) });
  assert.equal(prepend.index, 0);
  assert.ok(prepend.key < k[0], `expected ${prepend.key} < ${k[0]}`);
  const append = reorderPlan(sibs, { x: Math.cos(1.9 * Math.PI), y: Math.sin(1.9 * Math.PI) });
  assert.equal(append.index, 4);
  assert.ok(append.key > k[3], `expected ${append.key} > ${k[3]}`);
});

test('reorderPlan: null when there is nothing to reorder against', () => {
  assert.equal(reorderPlan([], { x: 1, y: 0 }), null);
});

// An equal-key run would make keyBetween throw, so the plan lands just past the run.
test('reorderPlan: an equal-key run is stepped over, never split', () => {
  const k = nKeysBetween(null, null, 4);
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const sibs = [sib(k[0], ring[0]), sib(k[1], ring[1]), { id: 'dup', order: k[1], x: Math.cos(ring[2]), y: Math.sin(ring[2]) }, sib(k[3], ring[3])];
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // lands between the two equal keys
  assert.equal(plan.index, 2);
  assert.ok(k[1] < plan.key && plan.key < k[3], `expected ${k[1]} < ${plan.key} < ${k[3]}, got ${plan.key}`);
});

test('reorderPlan: an equal-key run at the tail appends past it without throwing', () => {
  const k = nKeysBetween(null, null, 4);
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const sibs = [sib(k[0], 0.2), { id: 'm1', order: k[1], x: Math.cos(0.4), y: Math.sin(0.4) }, { id: 'm2', order: k[1], x: Math.cos(0.6), y: Math.sin(0.6) }];
  const plan = reorderPlan(sibs, { x: Math.cos(0.7), y: Math.sin(0.7) }); // just past the tail equal-key run
  assert.ok(plan.key > k[1], `expected ${plan.key} > ${k[1]}`);
});

// Order '' is not a valid fractional key, so reorderPlan treats it as an open bound.

test('reorderPlan: an all-empty sibling ring never throws and mints a valid key', () => {
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const valid = (key) => typeof key === 'string' && key.length > 0;
  const sibs = ['', '', '', ''].map((o, i) => sib(o, ring[i])).map((s, i) => ({ ...s, id: `e${i}` }));
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) });
  assert.ok(valid(plan.key), `expected a valid key, got ${JSON.stringify(plan.key)}`);
});

test('reorderPlan: at the empty/keyed boundary the key lands before the first real key', () => {
  const k = nKeysBetween(null, null, 4);
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const valid = (key) => typeof key === 'string' && key.length > 0;
  // sort order: two empties, then two real keys — the layout sweeps them in this order.
  const sibs = [
    { id: 'e0', order: '', x: Math.cos(ring[0]), y: Math.sin(ring[0]) },
    { id: 'e1', order: '', x: Math.cos(ring[1]), y: Math.sin(ring[1]) },
    { id: 'r0', order: k[2], x: Math.cos(ring[2]), y: Math.sin(ring[2]) },
    { id: 'r1', order: k[3], x: Math.cos(ring[3]), y: Math.sin(ring[3]) },
  ];
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // between e1 and r0
  assert.equal(plan.index, 2);
  assert.ok(valid(plan.key) && plan.key < k[2], `expected a valid key < ${k[2]}, got ${plan.key}`);
});

test('reorderPlan: prepend before an empty front never throws', () => {
  const k = nKeysBetween(null, null, 4);
  const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });
  const valid = (key) => typeof key === 'string' && key.length > 0;
  const sibs = [{ id: 'e0', order: '', x: Math.cos(0.2), y: Math.sin(0.2) }, sib(k[1], 0.5)];
  const plan = reorderPlan(sibs, { x: Math.cos(0.05), y: Math.sin(0.05) }); // before the empty
  assert.ok(valid(plan.key), `expected a valid key, got ${JSON.stringify(plan.key)}`);
});


test('reorder across wrapped rows selects the radial row and returns a global sibling index', () => {
  const keys = nKeysBetween(null, null, 6);
  const siblings = keys.map((order, i) => ({ id: `n${i}`, order,
    x: (i < 3 ? 300 : 540) * Math.cos(0.2 + (i % 3) * 0.2),
    y: (i < 3 ? 300 : 540) * Math.sin(0.2 + (i % 3) * 0.2) }));
  const point = { x: 540 * Math.cos(0.3), y: 540 * Math.sin(0.3) };
  const plan = reorderPlan(siblings, point);
  assert.equal(plan.index, 4);
  assert.ok(keys[3] < plan.key && plan.key < keys[4]);
  assert.ok(Math.abs(plan.radius - 540) < 0.001);
  assert.ok(Math.abs(plan.angle - 0.3) < 0.001);
  assert.deepEqual(reorderSlot(siblings, point), { index: plan.index, radius: plan.radius, angle: plan.angle, x: plan.x, y: plan.y });
  const inner = reorderPlan(siblings, { x: 310 * Math.cos(0.3), y: 310 * Math.sin(0.3) });
  assert.equal(inner.index, 1);
  assert.ok(keys[0] < inner.key && inner.key < keys[1]);
});

test('row boundary slots map to adjacent authored keys, with markers near that row', () => {
  const keys = nKeysBetween(null, null, 4);
  const siblings = keys.map((order, i) => ({ id: `n${i}`, order,
    x: (i < 2 ? 300 : 540) * Math.cos(i % 2 === 0 ? 0.2 : 0.4),
    y: (i < 2 ? 300 : 540) * Math.sin(i % 2 === 0 ? 0.2 : 0.4) }));
  for (const [radius, angle] of [[300, 0.5], [540, 0.1]]) {
    const plan = reorderPlan(siblings, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    assert.equal(plan.index, 2);
    assert.ok(keys[1] < plan.key && plan.key < keys[2]);
    assert.ok(Math.abs(plan.radius - radius) < 0.001);
    assert.ok(Math.abs(plan.angle - angle) < 0.001);
  }
});
