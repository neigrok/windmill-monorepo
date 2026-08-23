import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

const treeOf = (nodes) => new SkillTree({ id: 't', title: 'T', nodes });

test('a duplicate node id is refused, naming the id', () => {
  assert.throws(
    () => treeOf([
      { id: 'root', label: 'Root', prerequisites: [] },
      { id: 'x', label: 'First', prerequisites: ['root'] },
      { id: 'x', label: 'Second', prerequisites: ['root'] },
    ]),
    { message: 'Duplicate node id "x"' },
  );
});

test('a prerequisite pointing at nothing is refused, naming both ends', () => {
  assert.throws(
    () => treeOf([
      { id: 'a', label: 'A', prerequisites: [] },
      { id: 'b', label: 'B', prerequisites: ['a', 'ghost'] },
    ]),
    { message: 'Node "b" lists unknown prerequisite "ghost"' },
  );
});

test('a node that is its own prerequisite is a cycle', () => {
  assert.throws(
    () => treeOf([{ id: 'a', label: 'A', prerequisites: ['a'] }]),
    { message: 'Tree "t" has a cycle among: a' },
  );
});

test('a two-node cycle is refused, naming both nodes', () => {
  assert.throws(
    () => treeOf([
      { id: 'a', label: 'A', prerequisites: ['b'] },
      { id: 'b', label: 'B', prerequisites: ['a'] },
    ]),
    { message: 'Tree "t" has a cycle among: a, b' },
  );
});

test('a cycle names only the nodes stuck in it, not the healthy ones around it', () => {
  assert.throws(
    () => new SkillTree({
      id: 't_bakery',
      title: 'Bakery',
      nodes: [
        { id: 'root', label: 'Root', prerequisites: [] },
        { id: 'ok', label: 'Fine', prerequisites: ['root'] },
        { id: 'a', label: 'A', prerequisites: ['root', 'c'] },
        { id: 'b', label: 'B', prerequisites: ['a'] },
        { id: 'c', label: 'C', prerequisites: ['b'] },
      ],
    }),
    { message: 'Tree "t_bakery" has a cycle among: a, b, c' },
  );
});

test('a diamond is a legal DAG — two prerequisites on one node is not a cycle', () => {
  const tree = treeOf([
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'x', label: 'X', prerequisites: ['root'] },
    { id: 'y', label: 'Y', prerequisites: ['root'] },
    { id: 'z', label: 'Z', prerequisites: ['x', 'y'] },
  ]);

  assert.deepEqual(tree.topoOrder(), ['root', 'x', 'y', 'z']);
  assert.deepEqual([...tree.ranks()], [['root', 0], ['x', 1], ['y', 1], ['z', 2]]);
  assert.deepEqual(tree.roots().map((node) => node.id), ['root']);
  assert.deepEqual(tree.ancestorsOf('z').map((node) => node.id), ['x', 'y', 'root']);
});

test('a forest of disconnected roots is legal', () => {
  const tree = treeOf([
    { id: 'a', label: 'A', prerequisites: [] },
    { id: 'b', label: 'B', prerequisites: [] },
    { id: 'c', label: 'C', prerequisites: ['b'] },
  ]);

  assert.deepEqual(tree.topoOrder(), ['a', 'b', 'c']);
  assert.deepEqual(tree.roots().map((node) => node.id), ['a', 'b']);
});

test('every read of an unknown id throws by that id', () => {
  const tree = treeOf([{ id: 'a', label: 'A', prerequisites: [] }]);

  assert.throws(() => tree.nodeOrThrow('ghost'), { message: 'Unknown node id "ghost"' });
  assert.throws(() => tree.parentsOf('ghost'), { message: 'Unknown node id "ghost"' });
  assert.throws(() => tree.childrenOf('ghost'), { message: 'Unknown node id "ghost"' });
  assert.throws(() => tree.ancestorsOf('ghost'), { message: 'Unknown node id "ghost"' });
  assert.deepEqual(tree.nodeOrThrow('a'), { id: 'a', label: 'A', prerequisites: [] });
});

test('toRenderModel refuses to render a node the layout gave no position', () => {
  const tree = treeOf([
    { id: 'a', label: 'A', prerequisites: [] },
    { id: 'b', label: 'B', prerequisites: ['a'] },
  ]);
  const positions = new Map([['a', { x: 0, y: 0 }]]);

  assert.throws(
    () => tree.toRenderModel(positions, new Map()),
    { message: 'Missing position for node "b"' },
  );
});
