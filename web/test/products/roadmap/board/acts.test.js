import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { HeldDelete, completionOutcome, creationOutcome, deletionCost, countBucket } from '../../../../src/products/roadmap/board/acts.js';
import { TreeLattice, HlcClock } from '../../../../src/products/roadmap/sync/lattice.js';
import { materialize } from '../../../../src/products/roadmap/sync/materialize.js';

const progress = { completed: new Set(), completedAt: {} };
const wind = { id: 'wind', label: 'Read the wind', prerequisites: [], color: 'sky' };
const dock = { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'] };
const treeOf = (nodes) => new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });

test('completion outcomes pin zero, one and many unlocked with the reveal target', () => {
  const after = advanceProgress(progress, ['wind'], 'complete', 100);
  assert.deepEqual(completionOutcome(treeOf([wind]), progress, after, 'wind'), {
    message: 'Read the wind done', reveal: 'wind',
  });
  assert.deepEqual(completionOutcome(treeOf([wind, dock]), progress, after, 'wind'), {
    message: 'Read the wind done · Leave the dock up next', reveal: 'dock',
  });
  assert.deepEqual(completionOutcome(treeOf([wind, dock, { id: 'solo', label: 'Sail solo', prerequisites: ['wind'] }]), progress, after, 'wind'), {
    message: 'Read the wind done · 2 up next', reveal: 'wind',
  });
});

test('creation outcome derives placement and clears exactly hiding filters', () => {
  const tree = treeOf([wind, dock]);
  const query = new BoardQuery({ sort: 'newest' });
  assert.deepEqual(creationOutcome(tree, progress, query, 'dock'), {
    message: 'Leave the dock added · Locked', reveal: 'dock', column: 'locked', query, filterCleared: false,
  });
  assert.deepEqual(creationOutcome(tree, progress, query.searchingFor('astronomy'), 'wind'), {
    message: 'Read the wind added · filter cleared', reveal: 'wind', column: 'upNext', query, filterCleared: true,
  });
  assert.deepEqual(creationOutcome(tree, advanceProgress(progress, ['wind'], 'complete', 100), query, 'dock'), {
    message: 'Leave the dock added · Up next', reveal: 'dock', column: 'upNext', query, filterCleared: false,
  });
});

test('held delete projection equals committed BulkDelete and its cost counts surviving direct children', () => {
  const lattice = new TreeLattice('sail', 'Learn to sail');
  const clock = new HlcClock('tester');
  lattice.join(materialize({ kind: 'ImportSubgraph', nodes: [wind, dock, { id: 'solo', label: 'Solo' }, { id: 'other', label: 'Other' }],
    edges: [{ from: 'wind', to: 'dock' }, { from: 'dock', to: 'solo' }, { from: 'dock', to: 'other' }, { from: 'wind', to: 'other' }] }, lattice, clock));
  const tree = new SkillTree(lattice.toTreeData());
  const held = new HeldDelete(['dock', 'dock'], 'Leave the dock');
  assert.deepEqual(held.ids, ['dock']);
  assert.equal(held.message, 'Leave the dock deleted');
  assert.equal(deletionCost(tree, held.ids), 2);
  assert.equal(deletionCost(tree, ['wind']), 2);
  assert.equal(deletionCost(tree, ['wind', 'dock']), 2);
  assert.equal(deletionCost(tree, ['solo']), 0);
  const projected = held.projected(tree);
  lattice.join(materialize({ kind: 'BulkDelete', nodeIds: held.ids }, lattice, clock));
  assert.deepEqual(projected.nodes, lattice.toTreeData().nodes);
  assert.equal(new HeldDelete(['wind', 'dock'], 'unused').message, '2 steps deleted');
  assert.ok(Object.isFrozen(held));
  assert.ok(Object.isFrozen(held.ids));
});

test('event counts are bounded buckets', () => {
  assert.deepEqual([0, 1, 2, 5, 6, 20, 21, 5000].map(countBucket), ['0', '1', '2-5', '2-5', '6-20', '6-20', '21+', '21+']);
});

test('delete cost includes a child retaining another parent and counts shared children only once', () => {
  const tree = treeOf([
    wind,
    { id: 'rig', label: 'Rig the boat', prerequisites: [] },
    { ...dock, prerequisites: ['wind', 'rig'] },
    { id: 'solo', label: 'Sail solo', prerequisites: ['dock'] },
  ]);
  assert.equal(deletionCost(tree, ['wind']), 1);
  assert.equal(deletionCost(tree, ['rig']), 1);
  assert.equal(deletionCost(tree, ['wind', 'rig', 'rig']), 1);
  assert.equal(deletionCost(tree, ['wind', 'rig', 'dock']), 1);
  assert.equal(deletionCost(tree, []), 0);
});
