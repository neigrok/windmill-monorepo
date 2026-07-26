import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularInsertionIndex, reorderPlan } from '../../../../src/skilltree/scene/input/reorderGeometry.js';
import { nKeysBetween } from '../../../../src/skilltree/sync/fractionalIndex.js';

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

// An equal-key run (a concurrent-create collision) would make keyBetween throw; the plan must land
// the node just past the run instead of splitting it.
test('reorderPlan: an equal-key run is stepped over, never split', () => {
  const sibs = [sib(k[0], ring[0]), sib(k[1], ring[1]), { id: 'dup', order: k[1], x: Math.cos(ring[2]), y: Math.sin(ring[2]) }, sib(k[3], ring[3])];
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) }); // lands between the two equal keys
  assert.equal(plan.index, 2);
  assert.ok(k[1] < plan.key && plan.key < k[3], `expected ${k[1]} < ${plan.key} < ${k[3]}, got ${plan.key}`);
});

test('reorderPlan: an equal-key run at the tail appends past it without throwing', () => {
  const sibs = [sib(k[0], 0.2), { id: 'm1', order: k[1], x: Math.cos(0.4), y: Math.sin(0.4) }, { id: 'm2', order: k[1], x: Math.cos(0.6), y: Math.sin(0.6) }];
  const plan = reorderPlan(sibs, { x: Math.cos(0.7), y: Math.sin(0.7) }); // just past the tail equal-key run
  assert.ok(plan.key > k[1], `expected ${plan.key} > ${k[1]}`);
});

// Un-ordered siblings (order '', the lattice default for migrated / MCP / doc-seeded nodes) are not
// valid fractional keys — keyBetween throws on them directly. reorderPlan must treat '' as an open
// bound so the first reorder on such a tree never crashes.
const valid = (key) => typeof key === 'string' && key.length > 0;

test('reorderPlan: an all-empty sibling ring never throws and mints a valid key', () => {
  const sibs = ['', '', '', ''].map((o, i) => sib(o, ring[i])).map((s, i) => ({ ...s, id: `e${i}` }));
  const plan = reorderPlan(sibs, { x: Math.cos(Math.PI), y: Math.sin(Math.PI) });
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

test('reorderPlan: prepend before an empty front never throws', () => {
  const sibs = [{ id: 'e0', order: '', x: Math.cos(0.2), y: Math.sin(0.2) }, sib(k[1], 0.5)];
  const plan = reorderPlan(sibs, { x: Math.cos(0.05), y: Math.sin(0.05) }); // before the empty
  assert.ok(valid(plan.key), `expected a valid key, got ${JSON.stringify(plan.key)}`);
});
