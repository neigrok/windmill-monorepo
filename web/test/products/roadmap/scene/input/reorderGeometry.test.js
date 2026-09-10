import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularInsertionIndex, reorderPlan } from '../../../../../src/products/roadmap/scene/input/reorderGeometry.js';
import { nKeysBetween } from '../../../../../src/products/roadmap/sync/fractionalIndex.js';

// Four valid ascending fractional keys, k[0] < k[1] < k[2] < k[3].
const k = nKeysBetween(null, null, 4);
// A full root ring: four siblings evenly at π/4, 3π/4, 5π/4, 7π/4 in sort order.
const ring = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
const sib = (order, angle) => ({ id: order, order, x: Math.cos(angle), y: Math.sin(angle) });

test('circularInsertionIndex: empty and single', () => {
  assert.equal(circularInsertionIndex([], 1.2), 0);
  assert.equal(circularInsertionIndex([0], 0.2), 1); // just CCW of the lone sibling → after
  assert.equal(circularInsertionIndex([0], -0.2), 0); // just CW → before
});

test('circularInsertionIndex: full even ring, every gap', () => {
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
  const sibs = k.map((o, i) => sib(o, ring[i]));
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // between 1 and 2
  assert.equal(plan.index, 2);
  assert.ok(k[1] < plan.key && plan.key < k[2], `expected ${k[1]} < ${plan.key} < ${k[2]}`);
});

test('reorderPlan: prepend and append produce keys outside the ends', () => {
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
  const sibs = [sib(k[0], ring[0]), sib(k[1], ring[1]), { id: 'dup', order: k[1], x: Math.cos(ring[2]), y: Math.sin(ring[2]) }, sib(k[3], ring[3])];
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // lands between the two equal keys
  assert.equal(plan.index, 3);
  assert.ok(Math.abs(plan.slotAngle - (ring[2] + ring[3]) / 2) < 1e-9);
  assert.ok(k[1] < plan.key && plan.key < k[3], `expected ${k[1]} < ${plan.key} < ${k[3]}, got ${plan.key}`);
});

test('reorderPlan: an equal-key run at the tail appends past it without throwing', () => {
  const sibs = [sib(k[0], 0.2), { id: 'm1', order: k[1], x: Math.cos(0.4), y: Math.sin(0.4) }, { id: 'm2', order: k[1], x: Math.cos(0.6), y: Math.sin(0.6) }];
  const plan = reorderPlan(sibs, { x: Math.cos(0.7), y: Math.sin(0.7) }); // just past the tail equal-key run
  assert.ok(plan.key > k[1], `expected ${plan.key} > ${k[1]}`);
});

// Order '' is not a valid fractional key, so reorderPlan treats it as an open bound.
const valid = (key) => typeof key === 'string' && key.length > 0;

test('reorderPlan: an all-empty sibling ring never throws and mints a valid key', () => {
  const sibs = ['', '', '', ''].map((o, i) => sib(o, ring[i])).map((s, i) => ({ ...s, id: `e${i}` }));
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) });
  assert.equal(plan.index, 4);
  assert.ok(valid(plan.key), `expected a valid key, got ${JSON.stringify(plan.key)}`);
});

test('reorderPlan: at the empty/keyed boundary the key lands before the first real key', () => {
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

test('reorderPlan: an empty front moves the displayed slot to the first writable gap', () => {
  const sibs = [{ id: 'e0', order: '', x: Math.cos(0.2), y: Math.sin(0.2) }, sib(k[1], 0.5)];
  const plan = reorderPlan(sibs, { x: Math.cos(0.05), y: Math.sin(0.05) }); // before the empty
  assert.equal(plan.index, 1);
  assert.ok(Math.abs(plan.slotAngle - 0.35) < 1e-9);
  assert.ok(valid(plan.key), `expected a valid key, got ${JSON.stringify(plan.key)}`);
});

const round = (angle) => Math.round(angle * 1e6) / 1e6;
const norm = (angle) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
// A seat on an arc about `centre`. Under a bubble the tuck leaves every sibling its own distance from the parent,
// so each one here sits at a radius of its own and only the angle may decide anything.
const seatAt = (centre, radius, angle) => ({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });

test('reorderPlan: the ring slot sits in the middle of its gap, the ends borrowing half the wrap gap', () => {
  const sibs = k.map((o, i) => sib(o, ring[i]));
  const slots = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, (7 * Math.PI) / 4 + 0.1]
    .map((angle) => round(reorderPlan(sibs, { x: Math.cos(angle), y: Math.sin(angle) }).slotAngle));
  assert.deepEqual(slots, [0, round(Math.PI / 2), round(Math.PI), round((3 * Math.PI) / 2), 0]);
  const lone = [sib(k[0], 0)];
  assert.equal(round(reorderPlan(lone, { x: Math.cos(0.2), y: Math.sin(0.2) }).slotAngle), 0.3);
  assert.equal(round(reorderPlan(lone, { x: Math.cos(-0.2), y: Math.sin(-0.2) }).slotAngle), round(norm(-0.3)));
});

// A parent arc: the siblings sweep an arc about their parent's seat, in trunk order, and the dragged node's own
// seat ends that arc. Past either end by more than a step there is no gap to drop into.
test('reorderPlan on a parent arc: every gap, both ends, and the drops that fall off the arc', () => {
  const parent = { x: 100, y: -40 };
  const angles = [0.2, 0.6, 1.0, 1.4];
  const radii = [30, 55, 42, 61];
  const siblings = k.map((order, i) => ({ id: order, order, ...seatAt(parent, radii[i], angles[i]) }));
  const home = 0.8; // the dragged node sat between the second and the third sibling
  const indexAt = (angle) => {
    const plan = reorderPlan(siblings, seatAt(parent, 47, angle), { centre: parent, homeAngle: home });
    return plan === null ? null : plan.index;
  };
  // the arc spans 0.2…1.4 and a drop may overshoot either end by π/8, so the live band is -0.193…1.793
  assert.deepEqual([-0.25, -0.15, 0.1, 0.4, 0.8, 1.2, 1.5, 1.79, 1.8, home + Math.PI].map(indexAt),
    [null, 0, 0, 1, 2, 3, 4, 4, null, null]);
});

test('reorderPlan on a parent arc: the slot sits in the gap, and a step past the last seat at the ends', () => {
  const parent = { x: 100, y: -40 };
  const angles = [0.2, 0.6, 1.0, 1.4];
  const siblings = k.map((order, i) => ({ id: order, order, ...seatAt(parent, 30 + 10 * i, angles[i]) }));
  const slots = [-0.15, 0.4, 0.8, 1.2, 1.5]
    .map((angle) => round(reorderPlan(siblings, seatAt(parent, 47, angle), { centre: parent, homeAngle: 0.8 }).slotAngle));
  assert.deepEqual(slots, [round(norm(0.2 - Math.PI / 8)), 0.4, 0.8, 1.2, round(1.4 + Math.PI / 8)]);
});

test('reorderPlan on a parent arc: the keys the four gaps write', () => {
  const parent = { x: -12, y: 300 };
  const siblings = k.map((order, i) => ({ id: order, order, ...seatAt(parent, 40, [0.2, 0.6, 1.0, 1.4][i]) }));
  const keyAt = (angle) => reorderPlan(siblings, seatAt(parent, 40, angle), { centre: parent, homeAngle: 0.8 }).key;
  assert.ok(keyAt(0.1) < k[0], `expected ${keyAt(0.1)} < ${k[0]}`);
  assert.ok(k[0] < keyAt(0.4) && keyAt(0.4) < k[1], `expected ${k[0]} < ${keyAt(0.4)} < ${k[1]}`);
  assert.ok(k[1] < keyAt(0.8) && keyAt(0.8) < k[2], `expected ${k[1]} < ${keyAt(0.8)} < ${k[2]}`);
  assert.ok(k[3] < keyAt(1.5), `expected ${keyAt(1.5)} > ${k[3]}`);
});

test('reorderPlan on a parent arc: a fan straddling the ±π seam, the dragged node past its end', () => {
  const parent = { x: -250, y: 12 };
  const siblings = k.slice(0, 3).map((order, i) => ({ id: order, order, ...seatAt(parent, 33 + 7 * i, [2.9, 3.1, -3.0][i]) }));
  const indexAt = (angle) => {
    const plan = reorderPlan(siblings, seatAt(parent, 36, angle), { centre: parent, homeAngle: -2.8 });
    return plan === null ? null : plan.index;
  };
  // the fan runs 2.9 → 3.483 across π, so the live band is 2.507…3.876
  assert.deepEqual([2.5, 2.8, 2.95, 3.14, 3.4, 3.9].map(indexAt), [null, 0, 1, 2, 3, null]);
});

test('reorderPlan on a parent arc: two children swap either way, and the back of the parent is off the arc', () => {
  const parent = { x: 8, y: 8 };
  const siblings = [{ id: 'b', order: k[1], ...seatAt(parent, 44, 0.5) }];
  const planAt = (angle) => reorderPlan(siblings, seatAt(parent, 44, angle), { centre: parent, homeAngle: -0.5 });
  assert.deepEqual([-0.9, -0.3, 0.7, 0.85, 0.9, Math.PI].map((a) => (planAt(a) === null ? null : planAt(a).index)),
    [null, 0, 1, 1, null, null]);
  assert.ok(planAt(-0.3).key < k[1], `expected ${planAt(-0.3).key} < ${k[1]}`);
  assert.ok(planAt(0.7).key > k[1], `expected ${planAt(0.7).key} > ${k[1]}`);
});

test('reorderPlan on a parent arc: a parent with one child has no sibling to sweep past', () => {
  assert.equal(reorderPlan([], { x: 5, y: 5 }, { centre: { x: 1, y: 1 }, homeAngle: 0.4 }), null);
});

test('reorderPlan: the centre decides the order — the same seats read differently about the world origin', () => {
  const parent = { x: -400, y: 0 };
  const siblings = k.slice(0, 3).map((order, i) => ({ id: order, order, ...seatAt(parent, 50, [-0.4, 0, 0.4][i]) }));
  const drop = seatAt(parent, 50, 0.2);
  assert.equal(reorderPlan(siblings, drop, { centre: parent, homeAngle: -0.2 }).index, 2);
  assert.equal(reorderPlan(siblings, drop).index, 3); // about the origin the arc reads as a wedge across ±π
});
