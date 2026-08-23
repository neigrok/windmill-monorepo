import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeLattice, HlcClock } from '../../../../src/products/roadmap/sync/lattice.js';
import { materialize } from '../../../../src/products/roadmap/sync/materialize.js';
import { keyBetween } from '../../../../src/products/roadmap/sync/fractionalIndex.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

function newTree() {
  const lattice = new TreeLattice('t_0000000000000000', 'Reorder');
  const clock = new HlcClock('tester');
  const frames = [];
  const play = (gesture) => {
    const writes = materialize(gesture, lattice, clock);
    frames.push(writes);
    lattice.join(writes);
    return writes;
  };
  return { lattice, play, frames };
}

function renderedChildren(lattice, parentId) {
  const tree = new SkillTree(lattice.toTreeData());
  return tree.trunk.trunkChildrenOf(parentId);
}

function orderOf(lattice, id) {
  return lattice.toTreeData().nodes.find((n) => n.id === id).order;
}

test('created siblings render in creation order via appended keys', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'root' });

  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['a', 'b', 'c']);
  assert.ok(orderOf(lattice, 'a') < orderOf(lattice, 'b'));
  assert.ok(orderOf(lattice, 'b') < orderOf(lattice, 'c'));
});

test('SetNodeOrder moves one sibling to the front and leaves the others untouched', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'root' });

  const before = { a: orderOf(lattice, 'a'), b: orderOf(lattice, 'b') };
  const front = keyBetween(null, orderOf(lattice, 'a'));
  play({ kind: 'SetNodeOrder', id: 'c', order: front });

  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['c', 'a', 'b']);
  assert.equal(orderOf(lattice, 'a'), before.a);
  assert.equal(orderOf(lattice, 'b'), before.b);
  assert.equal(orderOf(lattice, 'c'), front);
});

test('SetNodeOrder into the middle re-sorts around the moved node', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'root' });

  const between = keyBetween(orderOf(lattice, 'a'), orderOf(lattice, 'b'));
  play({ kind: 'SetNodeOrder', id: 'c', order: between });

  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['a', 'c', 'b']);
});

test('roots reorder by the same register (their virtual parent is the canvas center)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'r1', label: 'R1' });
  play({ kind: 'CreateNode', id: 'r2', label: 'R2' });
  play({ kind: 'CreateNode', id: 'r3', label: 'R3' });

  const tree = new SkillTree(lattice.toTreeData());
  assert.deepStrictEqual([...tree.roots()].map((n) => n.id).sort(), ['r1', 'r2', 'r3']);

  const front = keyBetween(null, orderOf(lattice, 'r1'));
  play({ kind: 'SetNodeOrder', id: 'r3', order: front });
  const reordered = new SkillTree(lattice.toTreeData());
  const rootsInOrder = [...reordered.roots()].sort((a, b) =>
    (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  assert.deepStrictEqual(rootsInOrder.map((n) => n.id), ['r3', 'r1', 'r2']);
});

test('the reorder converges: the same writes replayed in any order land identically', () => {
  const source = newTree();
  source.play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  source.play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  source.play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });
  source.play({ kind: 'CreateNode', id: 'c', label: 'C', parentId: 'root' });
  const front = keyBetween(null, orderOf(source.lattice, 'a'));
  source.play({ kind: 'SetNodeOrder', id: 'c', order: front });

  const shuffled = [...source.frames].reverse();
  const peer = new TreeLattice('t_0000000000000000', 'Reorder');
  for (const frame of shuffled) peer.join(frame);

  const byId = (data) => ({ ...data, nodes: [...data.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)) });
  assert.deepStrictEqual(byId(peer.toTreeData()), byId(source.lattice.toTreeData()));
  assert.deepStrictEqual(renderedChildren(peer, 'root'), ['c', 'a', 'b']);
  assert.deepStrictEqual(renderedChildren(peer, 'root'), renderedChildren(source.lattice, 'root'));
});

test('a later SetNodeOrder wins over an earlier one by HLC (last-writer-wins)', () => {
  const { lattice, play } = newTree();
  play({ kind: 'CreateNode', id: 'root', label: 'Root' });
  play({ kind: 'CreateNode', id: 'a', label: 'A', parentId: 'root' });
  play({ kind: 'CreateNode', id: 'b', label: 'B', parentId: 'root' });

  const front = keyBetween(null, orderOf(lattice, 'a'));
  play({ kind: 'SetNodeOrder', id: 'b', order: front });
  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['b', 'a']);

  const back = keyBetween(orderOf(lattice, 'a'), null);
  play({ kind: 'SetNodeOrder', id: 'b', order: back });
  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['a', 'b']);
});

test('un-ordered (migration) siblings sort by creation stamp, ahead of a keyed node', () => {
  const genesis = '1:0:genesis';
  const lattice = new TreeLattice('t_0000000000000000', 'Legacy');
  lattice.join({
    nodes: [
      { id: 'root', createdAt: genesis, label: 'Root', labelAt: genesis },
      { id: 'x', createdAt: '5:0:u', label: 'X', labelAt: '5:0:u' },
      { id: 'y', createdAt: '7:0:u', label: 'Y', labelAt: '7:0:u' },
      { id: 'z', createdAt: '3:0:u', label: 'Z', labelAt: '3:0:u' },
    ],
    edges: [
      { from: 'root', to: 'x', addedAt: genesis },
      { from: 'root', to: 'y', addedAt: genesis },
      { from: 'root', to: 'z', addedAt: genesis },
    ],
    kinds: [],
  });

  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['z', 'x', 'y']);

  // An empty order sorts ahead of any assigned key.
  const clock = new HlcClock('tester');
  lattice.join(materialize({ kind: 'SetNodeOrder', id: 'y', order: keyBetween(null, null) }, lattice, clock));
  assert.deepStrictEqual(renderedChildren(lattice, 'root'), ['z', 'x', 'y']);
});
