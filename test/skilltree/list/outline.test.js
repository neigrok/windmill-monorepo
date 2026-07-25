import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../src/skilltree/model/SkillTree.js';
import { buildOutline, nextUp, treatmentOf, indentPx, progressOf } from '../../../src/skilltree/list/outline.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

test('buildOutline — root above sections, heads carry the DFS walk BENEATH them, from depth 2', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('b', ['r'], { order: 'b' }),
    node('a1', ['a']),
    node('a2', ['a']),
    node('a1x', ['a1']),
  ]);

  assert.deepEqual(buildOutline(t), {
    rootId: 'r',
    sections: [
      { head: 'a', rows: [{ id: 'a1', depth: 2 }, { id: 'a1x', depth: 3 }, { id: 'a2', depth: 2 }] },
      { head: 'b', rows: [] },
    ],
  });
});

// The head IS the section (canon §2), so it is rendered once — as the section's own row. A head
// that also sat in its rows would render twice: a fold header and a step, same node, two hit
// targets, different affordances.
test('buildOutline — a section head never appears among its own rows', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('b', ['r'], { order: 'b' }),
    node('a1', ['a']),
  ]);

  for (const section of buildOutline(t).sections) {
    assert.equal(section.rows.some((row) => row.id === section.head), false);
  }
  assert.deepEqual(buildOutline(t).sections, [
    { head: 'a', rows: [{ id: 'a1', depth: 2 }] },
    { head: 'b', rows: [] },
  ]);
});

test('buildOutline — section order follows the order register, not the node-list order', () => {
  const t = tree([
    node('r', []),
    node('late', ['r'], { order: 'z' }),
    node('early', ['r'], { order: 'a' }),
    node('mid', ['r'], { order: 'm' }),
  ]);

  assert.deepEqual(buildOutline(t).sections.map((section) => section.head), ['early', 'mid', 'late']);
});

test('buildOutline — a multi-parent step lands once, under the first parent the walk reaches', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('b', ['r'], { order: 'b' }),
    node('shared', ['a', 'b']),
  ]);

  const outline = buildOutline(t);
  assert.deepEqual(outline.sections, [
    { head: 'a', rows: [{ id: 'shared', depth: 2 }] },
    { head: 'b', rows: [] },
  ]);
});

test('buildOutline — a root child already placed under an earlier section keeps no section of its own', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { order: 'a' }),
    node('c', ['r', 'a'], { order: 'c' }),
  ]);

  const outline = buildOutline(t);
  assert.deepEqual(outline.sections, [
    { head: 'a', rows: [{ id: 'c', depth: 2 }] },
  ]);
});

test('buildOutline — indent-cap-worthy depths are reported raw (rendering caps, the model does not)', () => {
  const t = tree([
    node('r', []),
    node('a', ['r']),
    node('a1', ['a']),
    node('a2', ['a1']),
    node('a3', ['a2']),
    node('a4', ['a3']),
  ]);

  assert.deepEqual(buildOutline(t).sections[0].rows, [
    { id: 'a1', depth: 2 },
    { id: 'a2', depth: 3 },
    { id: 'a3', depth: 4 },
    { id: 'a4', depth: 5 },
  ]);
});

test('buildOutline — a multi-root tree has no root row and each root is a section head', () => {
  const t = tree([
    node('p', [], { order: 'p' }),
    node('q', [], { order: 'q' }),
    node('p1', ['p']),
  ]);

  assert.deepEqual(buildOutline(t), {
    rootId: null,
    sections: [
      { head: 'p', rows: [{ id: 'p1', depth: 2 }] },
      { head: 'q', rows: [] },
    ],
  });
});

test('nextUp — the shared whats-next ranking (unlocks desc → id), kind-capped at two, limit honored, each entry carrying its consequence', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { color: 'terracotta' }),
    node('b', ['r'], { color: 'terracotta' }),
    node('c', ['r'], { color: 'terracotta' }),
    node('d', ['r'], { color: 'olive' }),
    node('x', ['a']),
    node('y', ['b']),
    node('z', ['b']),
  ]);
  const states = new Map([
    ['r', 'complete'],
    ['a', 'available'], ['b', 'available'], ['c', 'available'], ['d', 'available'],
    ['x', 'locked'], ['y', 'locked'], ['z', 'locked'],
  ]);

  // b unlocks 2 (y,z), a unlocks 1 (x), c and d unlock 0. The third terracotta (c) is dropped by
  // the two-per-kind cap; the olive d fills the third slot.
  assert.deepEqual(nextUp(t, states, 3), {
    entries: [{ id: 'b', unlocks: 2 }, { id: 'a', unlocks: 1 }, { id: 'd', unlocks: 0 }],
    readyCount: 4,
  });
  assert.deepEqual(nextUp(t, states, 2), {
    entries: [{ id: 'b', unlocks: 2 }, { id: 'a', unlocks: 1 }],
    readyCount: 4,
  });
});

// Under the lens the two-per-kind mix cap means nothing — every offer is that kind — so the shelf
// ranks the whole ready set of it, and the readout counts that kind alone.
test('nextUp — the lens ranks within one kind, past the plan mix cap', () => {
  const t = tree([
    node('r', []),
    node('a', ['r'], { color: 'terracotta' }),
    node('b', ['r'], { color: 'terracotta' }),
    node('c', ['r'], { color: 'terracotta' }),
    node('d', ['r'], { color: 'olive' }),
    node('x', ['a']),
    node('y', ['b']),
    node('z', ['b']),
  ]);
  const states = new Map([
    ['r', 'complete'],
    ['a', 'available'], ['b', 'available'], ['c', 'available'], ['d', 'available'],
    ['x', 'locked'], ['y', 'locked'], ['z', 'locked'],
  ]);

  assert.deepEqual(nextUp(t, states, 3, 'terracotta'), {
    entries: [{ id: 'b', unlocks: 2 }, { id: 'a', unlocks: 1 }, { id: 'c', unlocks: 0 }],
    readyCount: 3,
  });
  assert.deepEqual(nextUp(t, states, 3, 'olive'), {
    entries: [{ id: 'd', unlocks: 0 }],
    readyCount: 1,
  });
  assert.deepEqual(nextUp(t, states, 3, 'plum'), { entries: [], readyCount: 0 });
});

// The readout counts what the shelf would offer, never a step it just refused: a root with no
// prerequisites is available on nearly every incomplete tree, so counting it read "1 ready" over
// an empty shelf — and "4 ready" over three rows on every tree with one.
test('nextUp — a single root is excluded from the offer AND from the readout', () => {
  const t = tree([
    node('r', []),
    node('a', ['r']),
  ]);
  const states = new Map([['r', 'available'], ['a', 'locked']]);

  assert.deepEqual(nextUp(t, states, 3), { entries: [], readyCount: 0 });
});

test('nextUp — a complete root was never in the ready count, so the readout is untouched', () => {
  const t = tree([
    node('r', []),
    node('a', ['r']),
    node('b', ['r']),
  ]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['b', 'available']]);

  assert.deepEqual(nextUp(t, states, 3), {
    entries: [{ id: 'a', unlocks: 0 }, { id: 'b', unlocks: 0 }],
    readyCount: 2,
  });
});

test('nextUp — a multi-root tree keeps its available roots in the shelf', () => {
  const t = tree([
    node('p', [], { order: 'p', color: 'terracotta' }),
    node('q', [], { order: 'q', color: 'olive' }),
    node('p1', ['p']),
  ]);
  const states = new Map([['p', 'available'], ['q', 'available'], ['p1', 'locked']]);

  assert.deepEqual(nextUp(t, states, 3), {
    entries: [{ id: 'p', unlocks: 1 }, { id: 'q', unlocks: 0 }],
    readyCount: 2,
  });
});

test('nextUp — no featured offer (blocked, all done, lone bud) yields an empty shelf', () => {
  const pair = tree([node('r', []), node('a', ['r'])]);
  assert.deepEqual(nextUp(pair, new Map([['r', 'active'], ['a', 'locked']])), { entries: [], readyCount: 0 });
  assert.deepEqual(nextUp(pair, new Map([['r', 'complete'], ['a', 'complete']])), { entries: [], readyCount: 0 });
  assert.deepEqual(nextUp(tree([node('r', [])]), new Map([['r', 'available']])), { entries: [], readyCount: 0 });
});

test('treatmentOf — every state maps to its fruit treatment, unknown falls to locked', () => {
  assert.equal(treatmentOf('complete'), 'done');
  assert.equal(treatmentOf('available'), 'ready');
  assert.equal(treatmentOf('active'), 'active');
  assert.equal(treatmentOf('locked'), 'locked');
  assert.equal(treatmentOf(undefined), 'locked');
});

test('indentPx — 16px per ring below the head, capped at three', () => {
  assert.equal(indentPx(0), 0);
  assert.equal(indentPx(1), 0);
  assert.equal(indentPx(2), 16);
  assert.equal(indentPx(3), 32);
  assert.equal(indentPx(4), 48);
  assert.equal(indentPx(5), 48);
});

test('progressOf — done tally and the crown predicate (all done, at least two)', () => {
  const pair = tree([node('r', []), node('a', ['r'])]);
  assert.deepEqual(progressOf(pair, new Map([['r', 'complete'], ['a', 'complete']])), { done: 2, total: 2, crowned: true });
  assert.deepEqual(progressOf(pair, new Map([['r', 'complete'], ['a', 'available']])), { done: 1, total: 2, crowned: false });
  assert.deepEqual(progressOf(tree([node('r', [])]), new Map([['r', 'complete']])), { done: 1, total: 1, crowned: false });
});
