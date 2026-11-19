import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CreateRoadmap, CreateSubtree } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { InadmissibleGuide } from '../../../../src/products/roadmap/guide/GuideDraft.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';
import { ReplicaSession } from '../../../../src/products/roadmap/room/ReplicaSession.js';

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

// A room opened on the device's copy of `treeId`, following it, with its session where the room's writes reach for it.
async function openRoom(a, treeId) {
  const said = [];
  const room = { sessionRef: { current: null } };
  const snapshot = { engine: a.engine, ready: true, online: true, error: false };
  const reading = new ReplicaReading({ treeId, room, say: (words) => said.push(words), timers: a.env.timers,
    session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
  assert.notEqual(await reading.read({ signal: new AbortController().signal }), null);
  reading.follow({ onTree() {}, onProgress() {}, onWorkspace() {}, onGuides() {}, onActivity() {} });
  return { reading, session: room.sessionRef.current, said };
}

// Each act the engine still journals for an Undo the room's stacks may ask.
const journaled = (a) => a.engine.device.activeReplica.journal.filter((act) => act.retained).length;

async function sailing() {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
    { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock' }, { key: 'solo', label: 'Sail solo' },
  ], links: [['wind', 'dock']] })));
  const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.solo)));
  for (const id of [tree, subtree]) for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) a.observe(scope);
  await a.sync();
  return { a, tree, subtree, steps };
}

test('the owner’s marks, a roadmap’s name, its guide and its visibility land on the device’s copy, and the engine keeps no Undo of them', async () => {
  const { a, tree, subtree, steps } = await sailing();
  try {
    const { reading, session, said } = await openRoom(a, tree);
    const before = journaled(a);
    session.markProgress([steps.wind, steps.dock], 'complete');
    assert.equal(session.renameTree('  Learn to sail fast '), true);
    assert.equal(session.setGuide('Go slowly'), true);
    await session.setVisibility('public');
    const shown = () => {
      const roadmap = reading.roadmap();
      return { title: roadmap.seed.title, guide: roadmap.seed.guide, visibility: roadmap.seed.visibility, completed: [...roadmap.marks.completed].sort() };
    };
    await until(() => shown().completed.length === 2 && shown().title === 'Learn to sail fast' && shown().guide === 'Go slowly', 1000);
    session.markProgress(steps.dock, 'none');
    await until(() => shown().completed.length === 1, 1000);
    assert.deepEqual(shown(), { title: 'Learn to sail fast', guide: 'Go slowly', visibility: 'public', completed: [steps.wind] });
    assert.throws(() => session.setGuide(' '), InadmissibleGuide);

    const inside = await openRoom(a, subtree);
    inside.session.renameTree('Sail alone');
    await until(() => reading.roadmap().seed.nodes.find((step) => step.id === steps.solo).label === 'Sail alone', 1000);
    assert.equal(await session.renameRoadmap(tree, 'Learn to sail'), true);
    await until(() => shown().title === 'Learn to sail', 1000);
    assert.deepEqual({ journaled: journaled(a) - before, said }, { journaled: 0, said: [] });
    inside.reading.close();
    reading.close();
  } finally {
    a.close();
  }
});

test('a step’s workspace is written through its door: subtasks and links by the domain’s actions, the note through its one draft', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const { reading, session } = await openRoom(a, tree);
    const before = journaled(a);
    const door = session.workspace;
    const workspace = () => reading.roadmap().workspace[steps.wind] ?? { subtasks: [], note: '', links: [] };
    door.addSubtask(steps.wind, '  Check the forecast ');
    door.addSubtask(steps.wind, '   ');
    door.addLink(steps.wind, 'www.example.com/wind');
    door.addLink(steps.wind, { url: 'https://example.org/tides', title: ' Tide tables ' });
    await door.setNote(steps.wind, 'Calm day');
    await until(() => workspace().subtasks.length === 1 && workspace().links.length === 2, 1000);
    const [forecast] = workspace().subtasks;
    door.toggleSubtask(steps.wind, forecast.id);
    door.editSubtask(steps.wind, forecast.id, 'Check the marine forecast');
    await door.setNote(steps.wind, 'Rough day');
    await until(() => workspace().subtasks[0].done && workspace().subtasks[0].label === 'Check the marine forecast', 1000);
    assert.deepEqual(workspace(), {
      subtasks: [{ id: forecast.id, label: 'Check the marine forecast', done: true }],
      note: 'Rough day',
      links: [
        { id: workspace().links[0].id, url: 'https://www.example.com/wind', title: 'example.com', domain: 'example.com' },
        { id: workspace().links[1].id, url: 'https://example.org/tides', title: 'Tide tables', domain: 'example.org' },
      ],
    });
    door.deleteSubtask(steps.wind, forecast.id);
    door.deleteLink(steps.wind, workspace().links[0].id);
    await until(() => workspace().subtasks.length === 0 && workspace().links.length === 1, 1000);
    assert.equal(journaled(a) - before, 0);
    reading.close();
  } finally {
    a.close();
  }
});

// The room's session over the harness's runner, telling what it says and emits; the reading answers what the replica holds.
async function gestures() {
  const { a, tree, steps } = await sailing();
  const { reading } = await openRoom(a, tree);
  const told = { said: [], events: [], statuses: 0 };
  const session = new ReplicaSession({ treeId: tree, runner: a.runner, roadmap: () => reading.roadmap(),
    say: (words) => told.said.push(words), onStatus: () => { told.statuses += 1; }, track: (name, props) => told.events.push([name, props]) });
  const shown = () => Object.fromEntries(reading.roadmap().seed.nodes.map((step) => [step.label, step.prerequisites.map((id) => reading.roadmap().seed.nodes.find((each) => each.id === id)?.label ?? id)]));
  return { a, tree, steps, reading, session, told, shown };
}

test('a gesture is the domain’s acts under one receipt: a step made under the room’s id, an edit of its words and prerequisites, and each toast’s Undo', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    const made = session.dispatch({ kind: 'CreateNode', id: 'f0c1e9d0-1111-4c5e-8000-000000000001', label: 'Tie a bowline', color: 'sky', prerequisites: [steps.wind] });
    assert.equal((await made.acts).length, 1);
    assert.deepEqual(reading.roadmap().seed.nodes.find((step) => step.label === 'Tie a bowline').id, 'f0c1e9d0-1111-4c5e-8000-000000000001');
    const edited = session.dispatch({ kind: 'EditNode', id: steps.solo, label: 'Sail alone', addPrerequisites: [steps.dock] });
    assert.equal((await edited.acts).length, 2);
    assert.deepEqual(shown(), { 'Tie a bowline': ['Read the wind'], 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail alone': ['Leave the dock'] });
    assert.equal(session.revert(made), true);
    assert.equal(session.revert(made), false);
    await until(() => !('Tie a bowline' in shown()), 1000);
    assert.equal(session.revert(edited), true);
    await until(() => 'Sail solo' in shown() && shown()['Sail solo'].length === 0, 1000);
    assert.deepEqual({ shown: shown(), told, nothing: session.dispatch({ kind: 'BulkRecolor', nodeIds: [], color: 'sky' }) },
      { shown: { 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail solo': [] }, told: { said: [], events: [], statuses: 0 }, nothing: null });
  } finally {
    reading.close();
    a.close();
  }
});

test('the keyboard walks a stack of gestures: a held delete cancelled in place, an edit undone and redone, and a new gesture drops what Redo held', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    const before = journaled(a);
    await session.dispatch({ kind: 'EditNode', id: steps.solo, label: 'Sail alone', addPrerequisites: [steps.dock] }).acts;
    await session.dispatch({ kind: 'BulkDelete', nodeIds: [steps.dock], edges: [] }).acts;
    assert.deepEqual(shown(), { 'Read the wind': [], 'Sail alone': ['Read the wind'] });
    session.undo();
    await until(() => 'Leave the dock' in shown(), 1000);
    session.undo();
    await until(() => 'Sail solo' in shown(), 1000);
    assert.deepEqual(shown(), { 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail solo': [] });
    session.redo();
    await until(() => 'Sail alone' in shown() && shown()['Sail alone'].length === 1, 1000);
    session.undo();
    await until(() => 'Sail solo' in shown(), 1000);
    await session.dispatch({ kind: 'RenameNode', id: steps.wind, label: 'Watch the wind' }).acts;
    session.redo();
    let held = 0;
    session.holdAct(() => { held += 1; });
    session.undo();
    session.endHeldAct();
    assert.deepEqual({ shown: shown(), held, receipts: session.receiptVersion, told },
      { shown: { 'Watch the wind': [], 'Leave the dock': ['Watch the wind'], 'Sail solo': [] }, held: 1, receipts: 4, told: { said: [], events: [], statuses: 4 } });
    session.close();
    await until(() => journaled(a) === before, 1000);
  } finally {
    reading.close();
    a.close();
  }
});

test('links, a reorder and a paste: a link moved to another step, a link that would close a loop refused in today’s words, a paste under a step', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    await session.dispatch({ kind: 'ReconnectEdge', oldFrom: steps.wind, oldTo: steps.dock, newFrom: steps.wind, newTo: steps.solo }).acts;
    assert.deepEqual(shown(), { 'Read the wind': [], 'Leave the dock': [], 'Sail solo': ['Read the wind'] });
    const loop = session.dispatch({ kind: 'AddEdge', from: steps.solo, to: steps.wind });
    assert.deepEqual(await loop.acts, []);
    const roots = reading.roadmap().seed.nodes.filter((step) => step.prerequisites.length === 0).map((step) => step.id);
    assert.deepEqual(roots, [steps.wind, steps.dock]);
    await session.dispatch({ kind: 'SetNodeOrder', id: steps.dock, order: 'Zz', below: null, siblings: [steps.wind] }).acts;
    await session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots', color: 'gold' }, { id: 'bowline', label: 'Bowline', color: 'gold' }],
      edges: [{ from: steps.dock, to: 'knots' }, { from: 'knots', to: 'bowline' }], kinds: [] }).acts;
    await session.dispatch({ kind: 'BulkDelete', nodeIds: [], edges: [{ from: steps.wind, to: steps.solo }] }).acts;
    assert.deepEqual({ order: reading.roadmap().seed.nodes.map((step) => step.label), shown: shown(), told }, {
      order: ['Leave the dock', 'Read the wind', 'Knots', 'Bowline', 'Sail solo'],
      shown: { 'Leave the dock': [], 'Read the wind': [], 'Sail solo': [], Knots: ['Leave the dock'], Bowline: ['Knots'] },
      told: { said: ['This would create a loop'], events: [['roadmap_write_refused', { write: 'AddEdge', refusal: 'invalid' }]], statuses: 0 },
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('the legend’s gestures and a step’s pointer: a kind made, named, described and recoloured with the steps that wear it, removed, and a roadmap opened and closed', async () => {
  const { a, tree, steps, reading, session, told } = await gestures();
  try {
    const other = committed(await a.runner.runAct(new CreateRoadmap('Learn to knot', { steps: [{ key: 'bowline', label: 'Bowline' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(other.tree), RoadmapScopes.overlay(other.tree)]) a.observe(scope);
    await a.sync();
    const legend = () => reading.roadmap().account.trees.get(tree).kinds.filter((kind) => kind.present)
      .map(({ hue, label, description }) => ({ hue, label, description }));
    const colours = () => reading.roadmap().seed.nodes.map((step) => step.color);
    await session.dispatch({ kind: 'AddKind', id: 'legend-made', hue: 'sky' }).acts;
    const made = reading.roadmap().account.trees.get(tree).kinds.find((kind) => kind.hue === 'sky').id;
    await session.dispatch({ kind: 'RenameKind', id: made, label: 'Sea' }).acts;
    await session.dispatch({ kind: 'DescribeKind', id: made, description: 'Time on the water' }).acts;
    await session.dispatch({ kind: 'RecolorKind', id: 'build', hue: 'plum' }).acts;
    assert.deepEqual({ legend: legend(), colours: colours() }, {
      legend: [
        { hue: 'plum', label: 'Build', description: 'Things you make' }, { hue: 'olive', label: 'Learn', description: 'Things you figure out' },
        { hue: 'gold', label: 'Milestone', description: 'Moments that matter' }, { hue: 'sky', label: 'Sea', description: 'Time on the water' },
      ],
      colours: ['plum', 'plum', 'plum'],
    });
    await session.dispatch({ kind: 'RemoveKind', id: made }).acts;
    const attached = session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: other.tree });
    await attached.acts;
    const opening = () => reading.roadmap().seed.nodes.find((step) => step.id === steps.dock).opening;
    assert.deepEqual({ kinds: legend().length, opens: opening()?.treeId, title: opening()?.title, card: reading.card(other.tree) },
      { kinds: 3, opens: other.tree, title: 'Learn to knot', card: { id: other.tree, title: 'Learn to knot', author: null, steps: 1, mine: true } });
    session.revert(attached);
    await until(() => opening() === undefined, 1000);
    await session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: other.tree }).acts;
    await session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: '' }).acts;
    assert.deepEqual({ opening: opening(), told }, { opening: undefined, told: { said: [], events: [], statuses: 0 } });
  } finally {
    reading.close();
    a.close();
  }
});

test('a roadmap’s deletion is held nine seconds: hidden from the person’s list at once, taken back within the hold, and permanent once it ends', async () => {
  const { a, tree } = await sailing();
  try {
    const other = committed(await a.runner.runAct(new CreateRoadmap('Learn to knot', { steps: [{ key: 'bowline', label: 'Bowline' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(other.tree), RoadmapScopes.overlay(other.tree)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const page = new ReplicaReading({ treeId: null, timers: a.env.timers, session: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
    const lists = [];
    assert.equal(await page.readRoadmaps({ signal: new AbortController().signal, onList: (list) => lists.push(list.map((row) => row.title)) }), true);
    const held = await page.writes.deleteRoadmap(tree);
    assert.deepEqual({ treeId: held.treeId, holding: held.remainingAt(a.world.now), listed: page.list().map((row) => row.title) },
      { treeId: tree, holding: CONSTANTS.HOLD_MS, listed: ['Learn to knot'] });
    assert.equal(await page.writes.undeleteRoadmap(held), true);
    await until(() => page.list().length === 2, 1000);
    const again = await page.writes.deleteRoadmap(tree);
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    assert.deepEqual({ undone: await page.writes.undeleteRoadmap(again), listed: page.list().map((row) => row.title), first: lists[0].sort() },
      { undone: false, listed: ['Learn to knot'], first: ['Learn to knot', 'Learn to sail'] });
    page.close();
  } finally {
    a.close();
  }
});
