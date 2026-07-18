// BulkDelete (desktop multi-select bulk delete): the one gesture that tombstones many nodes at
// once and TRANSITIVELY splices any orphaned survivor up to its nearest live ancestor. These
// pin the splice rule against the projected tree — build a lattice, join the materialized
// writes, and assert the whole resulting topology (every node, prerequisites sorted). The
// single-node case must stay byte-equal to DeleteNode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeLattice, HlcClock } from '../../../src/skilltree/sync/lattice.js';
import { materialize } from '../../../src/skilltree/sync/materialize.js';

function newTree() {
  const lattice = new TreeLattice('t_0000000000000000', 'Bulk');
  const clock = new HlcClock('tester');
  const play = (gesture) => lattice.join(materialize(gesture, lattice, clock));
  return { lattice, play };
}

// The projected topology: every live node with its prerequisites, both lists sorted so the
// assertion is a full structural equality independent of edge/insertion order.
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
  play({ kind: 'AddEdge', from: 'p2', to: 'c' }); // c now depends on both m and p2

  play({ kind: 'BulkDelete', nodeIds: ['m'], edges: [] });

  // m dies; c keeps its live parent p2 and is NOT re-tethered to m's parent p1.
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

  // The gap closes all the way up to R — never onto the doomed b.
  assert.deepStrictEqual(project(lattice), [
    { id: 'R', prerequisites: [] },
    { id: 'c', prerequisites: ['R'] },
  ]);
});

test('chain a→b→c where a was a root, both doomed: c becomes a root (no live ancestor to splice to)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'a', label: 'A' }); // a is a root
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
  play({ kind: 'AddEdge', from: 'b', to: 'c' }); // c depends on both a and b (both doomed)

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
