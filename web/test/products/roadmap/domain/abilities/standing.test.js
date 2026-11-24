// @ts-check
// The standing roadmap (Roadmap Coach D-2) made from what the room holds of a real engine's replica, and read by the
// abilities as the room shows it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { compareText } from '../../../../../src/platform/domain-kit/entities.js';
import { RoadmapProduct } from '../../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { readStanding } from '../../../../../src/products/roadmap/domain/abilities/standing.js';
import { ReadAbilities } from '../../../../../src/products/roadmap/domain/abilities/reads.js';
import { Complete, SetPointer } from '../../../../../src/products/roadmap/domain/progress.js';
import { CreateRoadmap } from '../../../../../src/products/roadmap/domain/roadmaps.js';
import { GENESIS_KINDS, RoadmapScopes } from '../../../../../src/products/roadmap/domain/roadmapRules.js';
import { DeleteStep } from '../../../../../src/products/roadmap/domain/steps.js';
import { HeldRoadmap } from '../../../../../src/products/roadmap/room/ReplicaRoadmap.js';
import { Harness } from '../../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from '../vectors.js';

/** @param {import('../../../../../src/platform/domain-kit/acts.js').ActOutcome<any, any>} outcome */
function committed(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return /** @type {any} */ (outcome).result;
}

// What the room holds of a roadmap on the phone, as `ReplicaReading.holding` takes it from the engine: the person's own
// where `own` says its record in their list is read, someone else's (no record, no overlay) otherwise.
/** @param {Harness} phone @param {string} id @param {{ own?: boolean }} [options] */
function held(phone, id, { own = true } = {}) {
  const tree = phone.engine.observe(RoadmapScopes.tree(id)).getSnapshot();
  const overlay = phone.engine.observe(RoadmapScopes.overlay(id)).getSnapshot();
  const record = own ? phone.engine.observe(RoadmapScopes.account).getSnapshot().drawn.find((/** @type {any} */ row) => row.t === 'tree' && row.id === id) : null;
  return new HeldRoadmap({ id, record, tree: tree.drawn, stored: tree.stored, overlay: overlay.drawn, queued: overlay.pending });
}

test('a step under a delete the person can still undo is absent, what waited on it follows what it followed, and every register read keeps its stamp', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
      { key: 'dock', label: 'Leave the dock' }, { key: 'knot', label: 'Tie a bowline' }, { key: 'sail', label: 'Sail with an instructor' },
    ], links: [['dock', 'knot'], ['knot', 'sail']] })));
    committed(await a.runner.runAct(Complete(tree, steps.dock)));
    committed(await a.runner.runAct(new DeleteStep(tree, steps.knot)));
    const standing = readStanding([held(a, tree).copy(roadmapRegistry)]);

    assert.deepEqual(standing.held, [{ tree, step: steps.knot }]);
    assert.deepEqual(ReadAbilities.get_tree(standing, { treeId: tree, fields: ['label', 'state', 'prerequisites'] }, tree), { result: {
      tree: { title: 'Learn to sail', kinds: GENESIS_KINDS.map(({ id, label, hue, description }) => ({ id, label, hue, description })), guide: '', stepCount: 2 },
      steps: [
        { id: steps.dock, label: 'Leave the dock', state: 'complete', prerequisites: [] },
        { id: steps.sail, label: 'Sail with an instructor', state: 'available', prerequisites: [steps.dock] },
      ] } });
    assert.deepEqual(ReadAbilities.get_nodes(standing, { treeId: tree, nodeIds: [steps.knot] }, tree), { refused: { code: 'unknown-step', id: steps.knot } });

    const scopes = { tree: a.engine.observe(RoadmapScopes.tree(tree)).getSnapshot(), overlay: a.engine.observe(RoadmapScopes.overlay(tree)).getSnapshot() };
    const knot = (/** @type {'drawn' | 'stored'} */ view) => scopes.tree[view].find((/** @type {any} */ row) => row.t === 'node' && row.id === steps.knot);
    assert.deepEqual(standing.stamps.find((stamps) => stamps.t === 'node' && stamps.id === steps.knot), { scope: RoadmapScopes.tree(tree), t: 'node',
      id: steps.knot, life: knot('drawn').life[1], f: Object.fromEntries(Object.entries(knot('drawn').f).map(([name, [, stamp]]) => [name, stamp])) });
    assert.notEqual(knot('drawn').life[1], knot('stored').life[1], 'the step\'s life is stamped by the delete the room shows');
    assert.deepEqual(standing.stamps.map(({ scope, t }) => `${scope} ${t}`).sort(), [
      `${RoadmapScopes.account} tree`, `${RoadmapScopes.overlay(tree)} progress`, ...['edge', 'edge', 'kind', 'kind', 'kind', 'meta', 'node', 'node', 'node']
        .map((type) => `${RoadmapScopes.tree(tree)} ${type}`)].sort(), 'the list record, every record of the tree scope and the overlay\'s mark');
    assert.equal(standing.stamps.find((stamps) => stamps.t === 'progress')?.f.mark,
      scopes.overlay.drawn.find((/** @type {any} */ row) => row.t === 'progress').f.mark[1]);
  } finally {
    a.close();
  }
});

test('a roadmap the person only reads carries the owner\'s marks the room shows, and is read only in its own conversation', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
      { key: 'dock', label: 'Leave the dock' }, { key: 'sail', label: 'Sail with an instructor' },
    ], links: [['dock', 'sail']] })));
    committed(await a.runner.runAct(Complete(tree, steps.sail)));
    const reading = held(a, tree, { own: false }).copy(roadmapRegistry);
    const shown = { completed: new Set([steps.dock]), completedAt: { [steps.dock]: 1_800_000_500_000 } };
    const standing = readStanding([reading], { ownerMarks: new Map([[tree, shown]]) });

    assert.deepEqual(standing.trees.map((each) => ({ own: each.own, marks: each.marks })), [{ own: false, marks: [
      { node: steps.dock, status: 'complete', outOfOrder: false, recordedAt: 1_800_000_500_000, deviceAt: null, stamp: null }] }]);
    assert.deepEqual(standing.stamps.filter((stamps) => stamps.scope !== RoadmapScopes.tree(tree)), [], 'a reader\'s device holds no overlay of the owner\'s, nor a list record');
    assert.deepEqual(ReadAbilities.get_nodes(standing, { treeId: tree, nodeIds: [steps.dock, steps.sail], fields: ['state'] }, tree),
      { result: { steps: [{ id: steps.dock, state: 'complete' }, { id: steps.sail, state: 'available' }] } });
    assert.deepEqual(ReadAbilities.get_progress(standing, { treeId: tree }, tree), { result: { completed: [{ id: steps.dock, at: 1_800_000_500_000 }] } });
    assert.deepEqual(ReadAbilities.get_nodes(readStanding([reading]), { treeId: tree, nodeIds: [steps.dock, steps.sail], fields: ['state'] }, tree),
      { result: { steps: [{ id: steps.dock, state: 'available' }, { id: steps.sail, state: 'locked' }] } }, 'without the owner\'s marks the room shows none');
    assert.deepEqual(ReadAbilities.get_tree(standing, { treeId: tree }, null), { refused: { code: 'unknown-roadmap', id: tree } });
    assert.deepEqual(ReadAbilities.get_tree(readStanding([reading], { listRead: false }), { treeId: tree }, null), { refused: { code: 'roadmap-unavailable', id: tree } },
      'while the device has not read the person\'s list, a roadmap outside it may yet be theirs');
  } finally {
    a.close();
  }
});

test('a step that opens a roadmap the device has not finished bringing, or holds nothing of, is unknown, and so is every unfinished step that waits on it', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Cross the sea', { steps: [
      { key: 'charts', label: 'Read the charts' }, { key: 'plan', label: 'Plan the passage' }, { key: 'crew', label: 'Find a crew' },
      { key: 'log', label: 'Keep a log' }, { key: 'cross', label: 'Cross' }, { key: 'watch', label: 'Stand a night watch' },
    ], links: [['charts', 'plan'], ['plan', 'log'], ['plan', 'cross'], ['crew', 'cross']] })));
    const { tree: navigation } = committed(await a.runner.runAct(new CreateRoadmap('Navigation')));
    committed(await a.runner.runAct(SetPointer(tree, steps.charts, navigation)));
    committed(await a.runner.runAct(SetPointer(tree, steps.watch, 't_00000000000000ff')));
    committed(await a.runner.runAct(Complete(tree, steps.log)));
    const listed = held(a, navigation).record;
    const standing = readStanding([held(a, tree).copy(roadmapRegistry), new HeldRoadmap({ id: navigation, record: listed, read: false }).copy(roadmapRegistry)]);

    const order = ['charts', 'plan', 'crew', 'log', 'cross', 'watch'];
    assert.deepEqual(ReadAbilities.get_nodes(standing, { treeId: tree, nodeIds: order.map((key) => steps[key]), fields: ['state', 'opens'] }, tree), { result: { steps: [
      { id: steps.charts, state: 'unknown', opens: navigation },
      { id: steps.plan, state: 'unknown', opens: null },
      { id: steps.crew, state: 'available', opens: null },
      { id: steps.log, state: 'complete', opens: null },
      { id: steps.cross, state: 'unknown', opens: null },
      { id: steps.watch, state: 'unknown', opens: 't_00000000000000ff' },
    ] } });
    assert.deepEqual(ReadAbilities.find_nodes(standing, { treeId: tree, state: 'locked' }, tree), { result: { steps: [] } }, 'an unknown step matches no state');
    assert.deepEqual(ReadAbilities.list_trees(standing, {}), { result: { trees: [
      { id: tree, title: 'Cross the sea', counts: { total: 6, done: 1, available: 1, locked: 0, unknown: 4 }, frontier: ['Find a crew'], lastCompletedAt: 1_800_000_000_000 },
      { id: navigation, title: null, counts: null, frontier: null, lastCompletedAt: null },
    ].sort((x, y) => compareText(x.id, y.id)) } }, 'neither roadmap has reached the server, so the list holds them in id byte order');
    assert.deepEqual(ReadAbilities.get_tree(standing, { treeId: navigation }, null), { refused: { code: 'roadmap-unavailable', id: navigation } });
  } finally {
    a.close();
  }
});
