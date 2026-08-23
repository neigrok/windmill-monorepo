import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeLattice, HlcClock } from '../../../../src/products/roadmap/sync/lattice.js';
import { materialize } from '../../../../src/products/roadmap/sync/materialize.js';

function newTree() {
  const lattice = new TreeLattice('t_0000000000000000', 'Bulk');
  const clock = new HlcClock('tester');
  const play = (gesture) => lattice.join(materialize(gesture, lattice, clock));
  return { lattice, play };
}

function project(lattice) {
  return lattice.toTreeData().nodes
    .map((n) => ({ id: n.id, prerequisites: [...n.prerequisites].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

test('two leaf siblings: both tombstoned, no stray edges left behind', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });

  play({ kind: 'BulkDelete', nodeIds: ['a', 'b'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'root', prerequisites: [] },
  ]);
});

test('middle node whose child keeps another live parent: child NOT spliced up', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'p1', label: 'P1' });
  play({ kind: 'CreateNode', id: 'p2', label: 'P2' });
  play({ kind: 'CreateNode', id: 'm', label: 'M', parentId: 'p1' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'm' });
  play({ kind: 'AddEdge', from: 'p2', to: 'c' });

  play({ kind: 'BulkDelete', nodeIds: ['m'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'c', prerequisites: ['p2'] },
    { id: 'p1', prerequisites: [] },
    { id: 'p2', prerequisites: [] },
  ]);
});

test('middle node whose child has only that parent: child re-tethered to the grandparent', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'gp', label: 'GP' });
  play({ kind: 'CreateNode', id: 'm', label: 'M', parentId: 'gp' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'm' });

  play({ kind: 'BulkDelete', nodeIds: ['m'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'c', prerequisites: ['gp'] },
    { id: 'gp', prerequisites: [] },
  ]);
});

test('chain a→b→c, both a and b doomed: c re-tethered TRANSITIVELY to a live grandparent, not to doomed b', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'R', label: 'R' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'R' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'b' });

  play({ kind: 'BulkDelete', nodeIds: ['a', 'b'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'R', prerequisites: [] },
    { id: 'c', prerequisites: ['R'] },
  ]);
});

test('chain a→b→c where a was a root, both doomed: c becomes a root (no live ancestor to splice to)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'a', label: 'A' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'b' });

  play({ kind: 'BulkDelete', nodeIds: ['a', 'b'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'c', prerequisites: [] },
  ]);
});

test('diamond: a child of two doomed nodes never re-tethers to a doomed node or to itself', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'R', label: 'R' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'R' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'a' });
  play({ kind: 'AddEdge', from: 'b', to: 'c' });

  play({ kind: 'BulkDelete', nodeIds: ['a', 'b'], edges: [] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'R', prerequisites: [] },
    { id: 'c', prerequisites: ['R'] },
  ]);
  const c = lattice.toTreeData().nodes.find((n) => n.id === 'c');
  assert.deepStrictEqual([...c.prerequisites].filter((p) => ['a', 'b', 'c'].includes(p)), []);
});

test('one-element BulkDelete is byte-equivalent to DeleteNode on the projected tree', () => {
  const seed = (play) => {
    play({ kind: 'CreateNode', id: 'gp', label: 'GP' });
    play({ kind: 'CreateNode', id: 'm', label: 'M', parentId: 'gp' });
    play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'm' });
  };

  const single = newTree();
  seed(single.play);
  single.play({ kind: 'DeleteNode', id: 'm' });

  const bulk = newTree();
  seed(bulk.play);
  bulk.play({ kind: 'BulkDelete', nodeIds: ['m'], edges: [] });

  const expected = [
    { id: 'c', prerequisites: ['gp'] },
    { id: 'gp', prerequisites: [] },
  ];
  assert.deepStrictEqual(project(single.lattice), expected);
  assert.deepStrictEqual(project(bulk.lattice), expected);
  assert.deepStrictEqual(project(single.lattice), project(bulk.lattice));
});

test('BulkDelete edges: an edge between survivors is removed alongside the doomed nodes', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'x', label: 'X', parentId: 'root' });
  play({ kind: 'AddEdge', from: 'a', to: 'b' });

  play({ kind: 'BulkDelete', nodeIds: ['x'], edges: [{ from: 'a', to: 'b' }] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'a', prerequisites: ['root'] },
    { id: 'b', prerequisites: ['root'] },
    { id: 'root', prerequisites: [] },
  ]);
});

test('BulkDelete edges: an edge touching a doomed node is a no-op (dies with the tombstone)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  play({ kind: 'AddEdge', from: 'a', to: 'b' });

  play({ kind: 'BulkDelete', nodeIds: ['a'], edges: [{ from: 'a', to: 'b' }] });

  assert.deepStrictEqual(project(lattice), [
    { id: 'b', prerequisites: ['root'] },
    { id: 'root', prerequisites: [] },
  ]);
});

function colors(lattice) {
  return lattice.toTreeData().nodes
    .map((n) => ({ id: n.id, color: n.color }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

test('BulkRecolor: three selected nodes all take the new hue', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'a', label: 'A' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'b' });

  play({ kind: 'BulkRecolor', nodeIds: ['a', 'b', 'c'], color: 'sky' });

  assert.deepStrictEqual(colors(lattice), [
    { id: 'a', color: 'sky' },
    { id: 'b', color: 'sky' },
    { id: 'c', color: 'sky' },
  ]);
});

test('BulkRecolor: a node outside the id list keeps its own hue', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'a', label: 'A', color: 'terracotta' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a', color: 'gold' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'b', color: 'terracotta' });

  play({ kind: 'BulkRecolor', nodeIds: ['a', 'c'], color: 'plum' });

  assert.deepStrictEqual(colors(lattice), [
    { id: 'a', color: 'plum' },
    { id: 'b', color: 'gold' },
    { id: 'c', color: 'plum' },
  ]);
});

test('BulkRecolor: an id absent from the projection is skipped (no phantom node)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'a', label: 'A' });

  play({ kind: 'BulkRecolor', nodeIds: ['a', 'ghost'], color: 'olive' });

  assert.deepStrictEqual(colors(lattice), [
    { id: 'a', color: 'olive' },
  ]);
});

test('one-element BulkRecolor is byte-equivalent to SetNodeColor on the projected tree', () => {
  const seed = (play) => {
    play({ kind: 'CreateNode', id: 'a', label: 'A' });
    play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'a' });
  };

  const single = newTree();
  seed(single.play);
  single.play({ kind: 'SetNodeColor', id: 'a', color: 'brick' });

  const bulk = newTree();
  seed(bulk.play);
  bulk.play({ kind: 'BulkRecolor', nodeIds: ['a'], color: 'brick' });

  const expected = [
    { id: 'a', color: 'brick' },
    { id: 'b', color: 'terracotta' },
  ];
  assert.deepStrictEqual(colors(single.lattice), expected);
  assert.deepStrictEqual(colors(bulk.lattice), expected);
  assert.deepStrictEqual(colors(single.lattice), colors(bulk.lattice));
});

const orderOf = (lattice, id) => lattice.toTreeData().nodes.find((n) => n.id === id).order;

test('ImportSubgraph append: pasted children land after the graft parent existing child', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'existing', label: 'E', parentId: 'root' });

  play({ kind: 'ImportSubgraph', nodes: [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }], edges: [{ from: 'root', to: 'p1' }, { from: 'root', to: 'p2' }] });

  const e = orderOf(lattice, 'existing');
  const p1 = orderOf(lattice, 'p1');
  const p2 = orderOf(lattice, 'p2');
  assert.ok(e < p1 && p1 < p2, `expected existing(${e}) < p1(${p1}) < p2(${p2})`);
});

test('ImportSubgraph: a pasted node that already carries an order keeps it (doc round-trip)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'ImportSubgraph', nodes: [{ id: 'x', label: 'X', order: 'Zz' }], edges: [] });
  assert.strictEqual(orderOf(lattice, 'x'), 'Zz');
});

test('ImportSubgraph: pasted roots get distinct ascending keys', () => {
  const { lattice, play } = newTree();
  play({ kind: 'ImportSubgraph', nodes: [{ id: 'r1', label: 'R1' }, { id: 'r2', label: 'R2' }, { id: 'r3', label: 'R3' }], edges: [] });
  const [r1, r2, r3] = ['r1', 'r2', 'r3'].map((id) => orderOf(lattice, id));
  assert.ok(r1 < r2 && r2 < r3, `expected ascending, got ${r1}, ${r2}, ${r3}`);
});

test('DescribeNode writes only the description register — no edges, no kinds, no other node fields', () => {
  const { lattice } = newTree();
  const clock = new HlcClock('tester');
  lattice.join(materialize({ kind: 'CreateNode', id: 'n1', label: 'Step' }, lattice, clock));

  const writes = materialize({ kind: 'DescribeNode', id: 'n1', description: 'A tidy summary' }, lattice, clock);

  assert.deepStrictEqual(writes.edges, []);
  assert.deepStrictEqual(writes.kinds, []);
  assert.strictEqual(writes.nodes.length, 1);
  const entry = writes.nodes[0];
  assert.deepStrictEqual(Object.keys(entry).sort(), ['description', 'descriptionAt', 'id']);
  assert.strictEqual(entry.id, 'n1');
  assert.strictEqual(entry.description, 'A tidy summary');
  assert.strictEqual(typeof entry.descriptionAt, 'string');
  assert.ok(entry.descriptionAt.length > 0);
});

test('DescribeNode projects onto the node and leaves label/color untouched; a later write wins', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'n1', label: 'Step', color: 'sky' });

  play({ kind: 'DescribeNode', id: 'n1', description: 'first' });
  const afterFirst = lattice.toTreeData().nodes.find((n) => n.id === 'n1');
  assert.strictEqual(afterFirst.description, 'first');
  assert.strictEqual(afterFirst.label, 'Step');
  assert.strictEqual(afterFirst.color, 'sky');

  play({ kind: 'DescribeNode', id: 'n1', description: 'second' });
  const afterSecond = lattice.toTreeData().nodes.find((n) => n.id === 'n1');
  assert.strictEqual(afterSecond.description, 'second');
  assert.strictEqual(afterSecond.label, 'Step');
  assert.strictEqual(afterSecond.color, 'sky');
});

test('DescribeNode clearing back to empty drops the description from the projection', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'n1', label: 'Step' });
  play({ kind: 'DescribeNode', id: 'n1', description: 'something' });
  assert.strictEqual(lattice.toTreeData().nodes.find((n) => n.id === 'n1').description, 'something');

  play({ kind: 'DescribeNode', id: 'n1', description: '' });
  assert.strictEqual(lattice.toTreeData().nodes.find((n) => n.id === 'n1').description, undefined);
});
