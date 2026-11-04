import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { Board, BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { HeldDelete, StepSelection, deletable, takesEveryRoot, editGesture, completionOutcome, creationOutcome, deletionCost, countBucket } from '../../../../src/products/roadmap/board/acts.js';
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

test('StepSelection toggles immutably and prunes to the pane order after filtering or regrouping', () => {
  const tree = treeOf([wind, { ...dock, color: 'sky' }, { id: 'solo', label: 'Solo', color: 'gold', prerequisites: ['wind'] }]);
  const board = new Board(tree, progress);
  const empty = new StepSelection();
  const selected = empty.toggle('solo', board, 'locked').toggle('dock', board, 'locked');
  assert.deepEqual(empty.ids, []);
  assert.deepEqual(selected.ids, ['dock', 'solo']);
  assert.equal(selected.count, 2);
  assert.equal(selected.prune(board, 'locked'), selected);
  assert.deepEqual(selected.toggle('dock', board, 'locked').ids, ['solo']);
  assert.deepEqual(selected.prune(new Board(tree, progress, new BoardQuery({ kinds: ['sky'] })), 'locked').ids, ['dock']);
  assert.deepEqual(selected.prune(new Board(tree, advanceProgress(progress, ['wind'], 'complete', 1)), 'locked').ids, []);
  assert.deepEqual(selected.prune(board, 'upNext').ids, []);
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.ids));
});

test('takesEveryRoot asks only whether the ids take every root a roadmap has', () => {
  const sole = new SkillTree({ id: 'sole', title: 'Sole', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'leaf', label: 'Leaf', prerequisites: ['root'] },
  ] });
  const twoRoots = new SkillTree({ id: 'two', title: 'Two', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'other', label: 'Other', prerequisites: [] },
  ] });
  assert.deepEqual([
    takesEveryRoot(sole, ['root']), takesEveryRoot(sole, ['leaf', 'root']), takesEveryRoot(sole, ['leaf']), takesEveryRoot(sole, []),
    takesEveryRoot(sole, ['gone']), takesEveryRoot(twoRoots, ['root']), takesEveryRoot(null, ['root']),
    takesEveryRoot(twoRoots, ['root', 'other']),
  ], [true, true, false, false, false, false, false, true]);
});

test('deletable excludes the sole root, absent ids and empty selections', () => {
  const tree = treeOf([wind, dock]);
  assert.equal(deletable(tree, ['wind']), false);
  assert.equal(deletable(tree, ['wind', 'dock']), false);
  assert.equal(deletable(tree, ['dock']), true);
  assert.equal(deletable(tree, []), false);
  assert.equal(deletable(tree, ['missing']), false);
  assert.equal(deletable(null, ['dock']), false);
  assert.equal(deletable(treeOf([wind, { ...dock, prerequisites: [] }]), ['wind']), true);
  assert.equal(deletable(treeOf([wind, { ...dock, prerequisites: [] }]), ['wind', 'dock']), false);
});

test('under a hold the rule reads what the hold leaves: the last root standing is the sole root', () => {
  const tree = treeOf([wind, { ...dock, prerequisites: [] }]);
  assert.equal(deletable(tree, ['wind']), true);
  assert.equal(deletable(new HeldDelete(['dock'], 'Leave').projected(tree), ['wind']), false);
});

test('editGesture diffs each field and prerequisite membership without treating order as a write', () => {
  const tree = treeOf([wind, dock, { id: 'rig', label: 'Rig', prerequisites: [] }]);
  const request = { id: 'dock', label: 'Leave the dock', description: '', color: 'terracotta', prerequisites: ['wind'] };
  assert.equal(editGesture(tree, request), null);
  assert.equal(editGesture(tree, { ...request, id: 'missing' }), null);
  for (const [field, value] of [['label', 'Sail'], ['description', 'A description'], ['color', 'gold']]) {
    assert.deepEqual(editGesture(tree, { ...request, [field]: value }), {
      kind: 'EditNode', id: 'dock', [field]: value, addPrerequisites: [], removePrerequisites: [],
    });
  }
  assert.deepEqual(editGesture(tree, { ...request, prerequisites: ['rig', 'rig'] }), {
    kind: 'EditNode', id: 'dock', addPrerequisites: ['rig'], removePrerequisites: ['wind'],
  });
  const withTwo = treeOf([wind, { id: 'rig', label: 'Rig', prerequisites: [] }, { ...dock, prerequisites: ['wind', 'rig'] }]);
  assert.equal(editGesture(withTwo, { ...request, prerequisites: ['rig', 'wind'] }), null);
});

test('editGesture refuses missing, self and transitive descendant prerequisites without mutating the tree', () => {
  const tree = treeOf([wind, dock, { id: 'solo', label: 'Solo', prerequisites: ['dock'] }]);
  const before = structuredClone(tree.nodes);
  for (const id of ['missing', 'wind', 'dock', 'solo']) {
    assert.equal(editGesture(tree, { id: 'wind', label: 'Wind', description: '', color: 'sky', prerequisites: [id] }), false);
  }
  assert.deepEqual(tree.nodes, before);
});

test('StepSelection prunes folded Done using the same shown-card limit as the pane', () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `done-${index}`, label: `Done ${index}`, prerequisites: [] }));
  const board = new Board(treeOf(nodes), {
    completed: new Set(nodes.map(({ id }) => id)),
    completedAt: Object.fromEntries(nodes.map(({ id }, index) => [id, index + 1])),
  });
  const selected = new StepSelection(['done-0', 'done-1', 'done-2', 'done-13']);
  assert.deepEqual(selected.prune(board, 'done', { doneExpanded: false }).ids, ['done-13', 'done-2']);
  assert.deepEqual(selected.prune(board, 'done', { doneExpanded: true }).ids, ['done-13', 'done-2', 'done-1', 'done-0']);
  assert.deepEqual(new StepSelection(['done-13']).toggle('done-0', board, 'done', { doneExpanded: false }).ids, ['done-13']);
});
