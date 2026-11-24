// Roadmap Coach's tool host over a room open on a real engine's copy: each direct write through the room's own door, what
// the door wrote and did not, the Undo of each kind of write, and what the host tells and reports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { RoadmapToolHost, WriteReceipt } from '../../../../src/products/roadmap/coach/toolHost.js';
import { readStanding } from '../../../../src/products/roadmap/domain/abilities/standing.js';
import { CreateRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { BoundaryFailure } from '../../../../src/products/roadmap/reportFailure.js';
import { HeldRoadmap } from '../../../../src/products/roadmap/room/ReplicaRoadmap.js';
import { ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

// The person's roadmap on the phone, synced: `dock` and `knot` lead to `sail`.
async function sailing() {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
    { key: 'dock', label: 'Leave the dock' }, { key: 'knot', label: 'Tie a bowline' }, { key: 'sail', label: 'Sail with an instructor' },
  ], links: [['dock', 'sail'], ['knot', 'sail']] })));
  for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
  await a.sync();
  return { a, tree, steps };
}

// A room opened on the device's copy of `treeId`, following it, with its session where the room's writes reach for it.
async function openRoom(a, treeId) {
  const said = [];
  const room = { sessionRef: { current: null } };
  const snapshot = { engine: a.engine, ready: true, online: true, error: false };
  const reading = new ReplicaReading({ treeId, room, say: (words) => said.push(words), timers: a.env.timers,
    session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
  assert.notEqual(await reading.read({ signal: new AbortController().signal }), null);
  reading.follow({ onTree() {}, onProgress() {}, onWorkspace() {}, onGuides() {}, onLanding() {}, onActivity() {} });
  return { reading, session: room.sessionRef.current, said };
}

// The standing roadmap as the room shows it now (Roadmap Coach D-2).
function standingOf(reading) {
  const roadmap = reading.roadmap();
  return readStanding([...roadmap.held.values()].map((held) => held.copy(roadmapRegistry)), { listRead: roadmap.listRead });
}

// The tool host of a conversation about `about`, over the room's session and what the room shows, with what it tells and
// reports kept.
function coachOver({ session, reading }, about, collaborators = {}) {
  const told = [];
  const reported = [];
  const tools = new RoadmapToolHost({ session, standing: () => standingOf(reading), about, track: (name, props) => told.push([name, props]),
    report: (...failure) => reported.push(failure), ...collaborators });
  return { tools, told, reported };
}

// The room's steps as it draws them, by label: each step's colour, words, web links and prerequisites, by label too.
function drawn(reading) {
  const roadmap = reading.roadmap();
  const labels = new Map(roadmap.seed.nodes.map((step) => [step.id, step.label]));
  return Object.fromEntries(roadmap.seed.nodes.map((step) => [step.label, { color: step.color, description: step.description ?? '', links: step.links ?? [],
    after: step.prerequisites.map((id) => labels.get(id)).sort(), done: roadmap.marks.completed.has(step.id) }]));
}

test('each direct write lands through the room\'s own door, as the person\'s would, answers what its ability answers and leaves a receipt', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);

    const created = await tools.run('create_node', { treeId: tree, label: 'Hoist the sail', kind: 'learn', prerequisites: [steps.dock] });
    const minted = created.answer.result.nodeId;
    assert.match(minted, /^[0-9a-z]{16}$/);
    assert.deepEqual(created, { answer: { result: { nodeId: minted } },
      receipt: new WriteReceipt({ ability: 'create_node', treeId: tree, nodeId: minted, undo: { act: created.receipt.undo.act } }) });
    const runs = [
      await tools.run('rename_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      await tools.run('annotate_node', { treeId: tree, nodeId: steps.knot, description: 'Round the post.', links: [{ url: 'https://example.org/cleat' }] }),
      await tools.run('connect', { treeId: tree, nodeId: minted, prerequisiteId: steps.knot }),
      await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' }),
    ];
    assert.deepEqual(runs.map(({ answer, receipt }) => ({ answer, receipt: { ...receipt, undo: 'act' in receipt.undo ? 'act' : receipt.undo } })), [
      { answer: { result: {} }, receipt: { ability: 'rename_node', treeId: tree, nodeId: steps.knot, undo: 'act' } },
      { answer: { result: {} }, receipt: { ability: 'annotate_node', treeId: tree, nodeId: steps.knot, undo: 'act' } },
      { answer: { result: {} }, receipt: { ability: 'connect', treeId: tree, nodeId: minted, undo: 'act' } },
      { answer: { result: {} }, receipt: { ability: 'set_progress', treeId: tree, nodeId: steps.dock, undo: { mark: 'none' } } },
    ]);
    assert.deepEqual(drawn(room.reading), {
      'Leave the dock': { color: 'terracotta', description: '', links: [], after: [], done: true },
      'Tie a cleat hitch': { color: 'terracotta', description: 'Round the post.', links: [{ url: 'https://example.org/cleat', label: '' }], after: [], done: false },
      'Sail with an instructor': { color: 'terracotta', description: '', links: [], after: ['Leave the dock', 'Tie a cleat hitch'], done: false },
      'Hoist the sail': { color: 'olive', description: '', links: [], after: ['Leave the dock', 'Tie a cleat hitch'], done: false },
    });
    assert.equal(room.session.undoStack.length, 4, 'each structure act stands on the room\'s own stack, where its ⌘Z reaches it');
    assert.deepEqual(told, ['create_node', 'rename_node', 'annotate_node', 'connect', 'set_progress']
      .map((ability) => ['roadmap_coach_ability', { ability, outcome: 'ok' }]));
    assert.deepEqual(room.said, []);
    room.reading.close();
  } finally {
    a.close();
  }
});

test('Undo takes back each kind of write: a structure act reverted, sparing what was written since, and a mark marked back', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);
    const { receipt: created } = await tools.run('create_node', { treeId: tree, label: 'Hoist the sail', prerequisites: [steps.dock] });
    const { receipt: renamed } = await tools.run('rename_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' });
    const { receipt: annotated } = await tools.run('annotate_node', { treeId: tree, nodeId: steps.knot, description: 'Round the post.' });
    const { receipt: linked } = await tools.run('connect', { treeId: tree, nodeId: steps.knot, prerequisiteId: steps.dock });
    const { receipt: completed } = await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });
    told.length = 0;

    assert.equal(await tools.undo(renamed), true);
    assert.equal(await tools.undo(linked), true);
    assert.equal(await tools.undo(created), true);
    assert.equal(await tools.undo(completed), true);
    const settled = () => {
      const shown = drawn(room.reading);
      return 'Tie a bowline' in shown && !('Hoist the sail' in shown) && shown['Tie a bowline'].after.length === 0 && !shown['Leave the dock'].done;
    };
    await until(settled, 1000);
    assert.deepEqual(drawn(room.reading), {
      'Leave the dock': { color: 'terracotta', description: '', links: [], after: [], done: false },
      'Tie a bowline': { color: 'terracotta', description: 'Round the post.', links: [], after: [], done: false },
      'Sail with an instructor': { color: 'terracotta', description: '', links: [], after: ['Leave the dock', 'Tie a bowline'], done: false },
    }, 'the description written after the rename stands');

    assert.equal(await tools.undo(annotated), true);
    await until(() => drawn(room.reading)['Tie a bowline'].description === '', 1000);
    assert.equal(await tools.undo(renamed), false, 'a structure act is taken back once');

    await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });
    const { receipt: reset } = await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'none' });
    assert.deepEqual(reset.undo, { mark: 'complete' });
    assert.equal(await tools.undo(reset), true);
    assert.equal(drawn(room.reading)['Leave the dock'].done, true, 'a mark marked back');
    assert.equal(await tools.undo(reset), false, 'a mark that already stands is not written again');
    assert.deepEqual(told.filter(([event]) => event === 'roadmap_coach_write_undone'), [
      ...['rename_node', 'connect', 'create_node', 'set_progress', 'annotate_node'].map((ability) => [ability, 'undone']),
      ['rename_node', 'unavailable'], ['set_progress', 'undone'], ['set_progress', 'unavailable'],
    ].map(([ability, outcome]) => ['roadmap_coach_write_undone', { ability, outcome }]));
    room.reading.close();
  } finally {
    a.close();
  }
});

test('a door that wrote nothing is no-change or roadmap-not-ready, never a success, and leaves no receipt', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const before = standingOf(room.reading);
    const { tools, told } = coachOver(room, tree, { standing: () => before });
    await room.session.dispatch({ kind: 'RenameNode', id: steps.knot, label: 'Tie a cleat hitch' }).landed;
    await room.session.markProgress(steps.dock, 'complete');
    await room.session.dispatch({ kind: 'AddEdge', from: steps.dock, to: steps.knot }).landed;

    assert.deepEqual([
      await tools.run('rename_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' }),
      await tools.run('connect', { treeId: tree, nodeId: steps.dock, prerequisiteId: steps.knot }),
    ], [
      { answer: { refused: { code: 'no-change', id: steps.knot } }, receipt: null },
      { answer: { refused: { code: 'no-change', id: steps.dock } }, receipt: null },
      { answer: { refused: { code: 'roadmap-not-ready', id: steps.dock } }, receipt: null },
    ]);
    a.failNextCommit();
    assert.deepEqual(await tools.run('annotate_node', { treeId: tree, nodeId: steps.sail, description: 'With a skipper.' }),
      { answer: { refused: { code: 'roadmap-not-ready', id: steps.sail } }, receipt: null }, 'a write the device could not store');
    assert.equal(drawn(room.reading)['Sail with an instructor'].description, '');
    assert.deepEqual(told, [['rename_node', 'no-change'], ['set_progress', 'no-change'], ['connect', 'roadmap-not-ready'], ['annotate_node', 'roadmap-not-ready']]
      .map(([ability, outcome]) => ['roadmap_coach_ability', { ability, outcome }]));
    room.reading.close();
  } finally {
    a.close();
  }
});

test('a refusal writes nothing: an input outside the ability\'s schema never reaches it, a write the ability refuses is never sent, and a roadmap part of which is being brought again takes none', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);
    const entries = () => a.engine.device.activeReplica.entries().length;
    const queued = entries();
    assert.deepEqual([
      await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'done' }),
      await tools.run('set_progress', { treeId: tree, nodeId: steps.sail, status: 'complete' }),
      await tools.run('get_nodes', { treeId: tree, nodeIds: [steps.sail], fields: ['state'] }),
    ], [
      { answer: { refused: { code: 'invalid-input' } }, receipt: null },
      { answer: { refused: { code: 'step-locked', id: steps.sail } }, receipt: null },
      { answer: { result: { steps: [{ id: steps.sail, state: 'locked' }] } }, receipt: null },
    ]);

    const roadmap = room.reading.roadmap();
    const pulling = [...roadmap.held.values()].map((held) => new HeldRoadmap({ id: held.id, record: held.record, tree: held.records, stored: held.stored,
      overlay: held.overlay, queued: held.queued, read: false }));
    const rebuilding = coachOver(room, tree, { standing: () => readStanding(pulling.map((held) => held.copy(roadmapRegistry))) });
    assert.deepEqual(await rebuilding.tools.run('rename_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      { answer: { refused: { code: 'roadmap-unavailable', id: tree } }, receipt: null });
    assert.equal(entries(), queued, 'nothing reached the engine');
    assert.deepEqual([...told, ...rebuilding.told], [['set_progress', 'invalid-input'], ['set_progress', 'step-locked'], ['get_nodes', 'ok'], ['rename_node', 'roadmap-unavailable']]
      .map(([ability, outcome]) => ['roadmap_coach_ability', { ability, outcome }]));
    room.reading.close();
  } finally {
    a.close();
  }
});

test('an ability that throws on what it was handed reports once under its static name, is told as failed, and throws on judged', async () => {
  const thrown = new TypeError('an input the host should never send');
  const { tools, told, reported } = coachOver({ session: { treeId: 't_0000000000000001' }, reading: null }, 't_0000000000000001', {
    standing: () => ({ trees: [] }), abilities: { set_progress: () => { throw thrown; } } });
  await assert.rejects(tools.run('set_progress', { treeId: 't_0000000000000001', nodeId: 'a', status: 'complete' }),
    (error) => error instanceof BoundaryFailure && error.cause === thrown);
  assert.deepEqual(reported, [['roadmap-coach-ability', thrown, { ability: 'set_progress' }]]);
  assert.deepEqual(told, [['roadmap_coach_ability', { ability: 'set_progress', outcome: 'failed' }]]);
});
