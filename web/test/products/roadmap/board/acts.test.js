import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { Board, BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { HeldDelete, StepSelection, deletable, editGesture, completionOutcome, creationOutcome } from '../../../../src/products/roadmap/board/acts.js';
import { domainReading, readEffects } from '../../../../src/products/roadmap/model/domainReads.js';
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

test('held delete projection equals committed BulkDelete and its cost names the surviving steps that follow it', () => {
  const lattice = new TreeLattice('sail', 'Learn to sail');
  const clock = new HlcClock('tester');
  lattice.join(materialize({ kind: 'ImportSubgraph', nodes: [wind, dock, { id: 'solo', label: 'Solo' }, { id: 'other', label: 'Other' }],
    edges: [{ from: 'wind', to: 'dock' }, { from: 'dock', to: 'solo' }, { from: 'dock', to: 'other' }, { from: 'wind', to: 'other' }] }, lattice, clock));
  const tree = new SkillTree(lattice.toTreeData());
  const held = new HeldDelete(['dock', 'dock'], 'Leave the dock');
  assert.deepEqual(held.ids, ['dock']);
  assert.equal(held.message, 'Leave the dock deleted');
  assert.deepEqual([held.ids, ['wind'], ['wind', 'dock'], ['solo']].map((ids) => readEffects(tree, ids).follow),
    [['solo', 'other'], ['dock', 'other'], ['solo', 'other'], []]);
  const projected = held.projected(tree);
  lattice.join(materialize({ kind: 'BulkDelete', nodeIds: held.ids }, lattice, clock));
  assert.deepEqual(projected.nodes, lattice.toTreeData().nodes, 'where each follower of the held step followed nothing else, the hold reads as the delete commits');
  assert.equal(new HeldDelete(['wind', 'dock'], 'unused').message, '2 steps deleted');
  assert.ok(Object.isFrozen(held));
  assert.ok(Object.isFrozen(held.ids));
});

test('a held delete is read through, as the domain reads a delete (D-5): a step following it beside another step still owes what it followed', () => {
  const tree = treeOf([{ id: 'plan', label: 'Plan', prerequisites: [] }, { id: 'rig', label: 'Rig the boat', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['rig'] }, { id: 'race', label: 'Enter a race', prerequisites: ['plan', 'sail'] }]);
  const projected = new HeldDelete(['sail'], 'Learn to sail').projected(tree);
  const marks = { completed: new Set(['plan']), completedAt: {} };
  assert.deepEqual(projected.nodesById.get('race').prerequisites, ['plan', 'rig']);
  assert.deepEqual([new Board(projected, marks).columnOf('race'), domainReading(projected, marks).states.get('rig')], ['locked', 'available']);
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
