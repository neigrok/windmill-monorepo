import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CreateRoadmap, CreateSubtree } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { DeleteStep, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { InadmissibleGuide } from '../../../../src/products/roadmap/guide/GuideDraft.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';
import { ReplicaSession, inverseOutcome } from '../../../../src/products/roadmap/room/ReplicaSession.js';
import { BoundaryFailure } from '../../../../src/products/roadmap/reportFailure.js';

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
  reading.follow({ onTree() {}, onProgress() {}, onWorkspace() {}, onGuides() {}, onLanding() {}, onActivity() {} });
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
  const reports = [];
  const session = new ReplicaSession({ treeId: tree, runner: a.runner, roadmap: () => reading.roadmap(),
    say: (words) => told.said.push(words), onStatus: () => { told.statuses += 1; }, track: (name, props) => told.events.push([name, props]),
    report: (operation, error, tags) => reports.push([operation, tags]) });
  const shown = () => Object.fromEntries(reading.roadmap().seed.nodes.map((step) => [step.label, step.prerequisites.map((id) => reading.roadmap().seed.nodes.find((each) => each.id === id)?.label ?? id)]));
  return { a, tree, steps, reading, session, told, reports, shown };
}

test('a gesture is the domain’s acts under one receipt: a step made under the room’s id, an edit of its words and prerequisites, and each toast’s Undo', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    const made = session.dispatch({ kind: 'CreateNode', id: 'f0c1e9d0-1111-4c5e-8000-000000000001', label: 'Tie a bowline', color: 'sky', prerequisites: [steps.wind] });
    assert.equal(typeof await made.act, 'string');
    assert.deepEqual(reading.roadmap().seed.nodes.find((step) => step.label === 'Tie a bowline').id, 'f0c1e9d0-1111-4c5e-8000-000000000001');
    const edited = session.dispatch({ kind: 'EditNode', id: steps.solo, label: 'Sail alone', addPrerequisites: [steps.dock] });
    assert.equal(typeof await edited.act, 'string');
    assert.deepEqual(shown(), { 'Tie a bowline': ['Read the wind'], 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail alone': ['Leave the dock'] });
    assert.ok(session.revert(made) instanceof Promise, 'its Undo, once the engine settles it');
    assert.equal(session.revert(made), false);
    await until(() => !('Tie a bowline' in shown()), 1000);
    assert.ok(session.revert(edited) instanceof Promise);
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
    await session.dispatch({ kind: 'EditNode', id: steps.solo, label: 'Sail alone', addPrerequisites: [steps.dock] }).act;
    await session.dispatch({ kind: 'BulkDelete', nodeIds: [steps.dock], edges: [] }).act;
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
    await session.dispatch({ kind: 'RenameNode', id: steps.wind, label: 'Watch the wind' }).act;
    session.redo();
    let held = 0;
    session.holdAct(() => { held += 1; });
    session.undo();
    session.endHeldAct();
    await a.sync();
    session.followInverses();
    assert.deepEqual({ shown: shown(), held, receipts: session.receiptVersion, told }, {
      shown: { 'Watch the wind': [], 'Leave the dock': ['Watch the wind'], 'Sail solo': [] }, held: 1, receipts: 4,
      told: { said: [], statuses: 4, events: ['undo', 'undo', 'redo', 'undo'].map((action) => ['roadmap_undo', { action, outcome: 'applied' }]) },
    });
    session.close();
    await until(() => journaled(a) === before, 1000);
  } finally {
    reading.close();
    a.close();
  }
});

test('INV-1: the room’s edit of a step another device deleted, which the device knows only by its spent id, brings it back; its Undo deletes it again and its Redo brings it back with the edit', async () => {
  const { a, tree, steps, reading, session, told } = await gestures();
  try {
    const b = await a.device();
    await a.sync();
    committed(await b.runner.runAct(new DeleteStep(tree, steps.dock)));
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    const dock = (/** @type {Harness} */ phone) => phone.drawn(RoadmapStep, RoadmapScopes.tree(tree)).filter((step) => step.id.record === steps.dock)
      .map((step) => [step.label, step.description]);
    assert.deepEqual(dock(a), []);
    const described = session.dispatch({ kind: 'DescribeNode', id: steps.dock, description: 'Cast off the lines' });
    assert.notEqual(await described.landed, null);
    await a.sync();
    const landed = reading.landing().map((line) => line.key);
    const afterEdit = [dock(a), dock(b)];
    const synced = async (/** @type {() => boolean} */ seen) => {
      for (let turn = 0; turn < 20 && !seen(); turn++) await a.sync();
      return seen();
    };
    const asked = () => until(() => a.engine.device.activeReplica.entries().some((/** @type {any} */ entry) => entry.state === 'ready'), 1000);
    session.undo();
    await asked();
    const undone = await synced(() => dock(a).length === 0 && dock(b).length === 0);
    session.redo();
    await asked();
    const redone = await synced(() => dock(a).length === 1 && dock(b).length === 1);
    assert.deepEqual({ landed, afterEdit, undone, redone, afterRedo: [dock(a), dock(b)], said: told.said }, {
      landed: [`cameBack:${steps.dock}`],
      undone: true,
      redone: true,
      afterEdit: [[['Leave the dock', 'Cast off the lines']], [['Leave the dock', 'Cast off the lines']]],
      afterRedo: [[['Leave the dock', 'Cast off the lines']], [['Leave the dock', 'Cast off the lines']]],
      said: [],
    });
    session.close();
  } finally {
    reading.close();
    a.close();
  }
});

test('links, a reorder and a paste: a link moved to another step, a link that would close a loop refused in today’s words, a paste under a step', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    await session.dispatch({ kind: 'ReconnectEdge', oldFrom: steps.wind, oldTo: steps.dock, newFrom: steps.wind, newTo: steps.solo }).act;
    assert.deepEqual(shown(), { 'Read the wind': [], 'Leave the dock': [], 'Sail solo': ['Read the wind'] });
    assert.equal(session.dispatch({ kind: 'AddEdge', from: steps.solo, to: steps.wind }), null);
    const roots = reading.roadmap().seed.nodes.filter((step) => step.prerequisites.length === 0).map((step) => step.id);
    assert.deepEqual(roots, [steps.wind, steps.dock]);
    await session.dispatch({ kind: 'SetNodeOrder', id: steps.dock, order: 'Zz', below: null, siblings: [steps.wind] }).act;
    await session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots', color: 'gold' }, { id: 'bowline', label: 'Bowline', color: 'gold' }],
      edges: [{ from: steps.dock, to: 'knots' }, { from: 'knots', to: 'bowline' }], kinds: [] }).act;
    await session.dispatch({ kind: 'BulkDelete', nodeIds: [], edges: [{ from: steps.wind, to: steps.solo }] }).act;
    const reordered = reading.roadmap().seed.nodes.filter((step) => ['Leave the dock', 'Read the wind'].includes(step.label));
    assert.deepEqual({ order: reordered.map((step) => step.label), shown: shown(), told }, {
      order: ['Leave the dock', 'Read the wind'],
      shown: { 'Leave the dock': [], 'Read the wind': [], 'Sail solo': [], Knots: ['Leave the dock'], Bowline: ['Knots'] },
      told: { said: ['This would create a loop'], events: [['roadmap_write_refused', { write: 'AddEdge', refusal: 'invalid' }]], statuses: 0 },
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('a pasted plan names a web link by its bare address, as the paste grammar reads one: it lands as that address with no label, and one with no address carries nothing', async () => {
  const { a, reading, session, told } = await gestures();
  try {
    const pasted = session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots', color: 'gold', links: ['https://example.com/knots', ' '] },
      { id: 'bowline', label: 'Bowline', color: 'gold', links: [{ url: 'https://example.com/bowline', label: 'How to' }] }], edges: [{ from: 'knots', to: 'bowline' }], kinds: [] });
    await pasted.act;
    const links = Object.fromEntries(reading.roadmap().seed.nodes.filter((step) => ['Knots', 'Bowline'].includes(step.label)).map((step) => [step.label, step.links]));
    assert.deepEqual({ links, told }, {
      links: { Knots: [{ url: 'https://example.com/knots', label: '' }], Bowline: [{ url: 'https://example.com/bowline', label: 'How to' }] },
      told: { said: [], events: [], statuses: 0 },
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('R-15: a pasted plan’s done steps arrive done, and its one Undo takes back the steps and their marks', async () => {
  const { a, steps, reading, session, told, shown } = await gestures();
  try {
    const marked = () => [...reading.roadmap().marks.completed].map((id) => reading.roadmap().seed.nodes.find((step) => step.id === id)?.label ?? id).sort();
    const pasted = session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots', color: 'gold', status: 'complete' }, { id: 'bowline', label: 'Bowline', color: 'gold' }],
      edges: [{ from: steps.dock, to: 'knots' }, { from: 'knots', to: 'bowline' }], kinds: [] });
    await pasted.act;
    await until(() => 'Bowline' in shown() && marked().length === 1, 1000);
    const landed = { shown: shown(), marked: marked() };
    session.undo();
    await session.redoStack.at(-1).inverse;
    await until(() => !('Knots' in shown()) && marked().length === 0, 1000);
    assert.deepEqual({ landed, undone: { shown: shown(), marked: marked() }, told }, {
      landed: { shown: { 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail solo': [], Knots: ['Leave the dock'], Bowline: ['Knots'] }, marked: ['Knots'] },
      undone: { shown: { 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail solo': [] }, marked: [] },
      told: { said: [], events: [], statuses: 1 },
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
    await session.dispatch({ kind: 'AddKind', id: 'legend-made', hue: 'sky' }).act;
    const made = reading.roadmap().account.trees.get(tree).kinds.find((kind) => kind.hue === 'sky').id;
    await session.dispatch({ kind: 'RenameKind', id: made, label: 'Sea' }).act;
    await session.dispatch({ kind: 'DescribeKind', id: made, description: 'Time on the water' }).act;
    await session.dispatch({ kind: 'RecolorKind', id: 'build', hue: 'plum' }).act;
    assert.deepEqual({ legend: legend(), colours: colours() }, {
      legend: [
        { hue: 'plum', label: 'Build', description: 'Things you make' }, { hue: 'olive', label: 'Learn', description: 'Things you figure out' },
        { hue: 'gold', label: 'Milestone', description: 'Moments that matter' }, { hue: 'sky', label: 'Sea', description: 'Time on the water' },
      ],
      colours: ['plum', 'plum', 'plum'],
    });
    await session.dispatch({ kind: 'RemoveKind', id: made }).act;
    const attached = session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: other.tree });
    await attached.act;
    const opening = () => reading.roadmap().seed.nodes.find((step) => step.id === steps.dock).opening;
    assert.deepEqual({ kinds: legend().length, opens: opening()?.treeId, title: opening()?.title, card: reading.card(other.tree) },
      { kinds: 3, opens: other.tree, title: 'Learn to knot', card: { id: other.tree, title: 'Learn to knot', author: null, steps: 1, mine: true } });
    session.revert(attached);
    await until(() => opening() === undefined, 1000);
    await session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: other.tree }).act;
    await session.dispatch({ kind: 'SetNodeTree', id: steps.dock, opens: '' }).act;
    assert.deepEqual({ opening: opening(), told }, { opening: undefined, told: { said: [], events: [], statuses: 0 } });
  } finally {
    reading.close();
    a.close();
  }
});

test('a removed kind’s Undo brings nothing back while a kind made since wears its hue, and is told unavailable; with the hue free it brings the kind back', async () => {
  const { a, tree, reading, session, told } = await gestures();
  try {
    const { CreateKind } = await import('../../../../src/products/roadmap/domain/kinds.js');
    const legend = () => reading.roadmap().account.trees.get(tree).kinds.filter((kind) => kind.present).map(({ hue, label }) => `${label} ${hue}`);
    const undo = async () => { session.undo(); await session.redoStack.at(-1).inverse; };
    await session.dispatch({ kind: 'AddKind', id: 'legend-sea', hue: 'sky' }).act;
    const sea = reading.roadmap().account.trees.get(tree).kinds.find((kind) => kind.hue === 'sky').id;
    await session.dispatch({ kind: 'RenameKind', id: sea, label: 'Sea' }).act;
    await session.dispatch({ kind: 'RemoveKind', id: sea }).act;
    committed(await a.runner.runAct(new CreateKind(tree, { hue: 'sky', label: 'Weather' })));
    await undo();
    assert.deepEqual(legend(), ['Build terracotta', 'Learn olive', 'Milestone gold', 'Weather sky']);

    await session.dispatch({ kind: 'RemoveKind', id: 'milestone' }).act;
    await undo();
    await until(() => legend().length === 4, 1000);
    assert.deepEqual({ legend: legend(), events: told.events }, {
      legend: ['Build terracotta', 'Learn olive', 'Milestone gold', 'Weather sky'],
      events: [['roadmap_undo', { action: 'undo', outcome: 'unavailable' }]],
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('the Undo of a Redo is checked as the gesture’s own: a kind removed, brought back and removed again comes back no more once a kind made since wears its hue; a recolour’s Undo is checked the same way', async () => {
  const { a, tree, reading, session, told } = await gestures();
  try {
    const { CreateKind } = await import('../../../../src/products/roadmap/domain/kinds.js');
    const legend = () => reading.roadmap().account.trees.get(tree).kinds.filter((kind) => kind.present).map(({ hue, label }) => `${label} ${hue}`);
    const undo = async () => { session.undo(); await session.redoStack.at(-1).inverse; };
    const redo = async () => { session.redo(); await session.undoStack.at(-1).undo; };
    await session.dispatch({ kind: 'AddKind', id: 'legend-sea', hue: 'sky' }).act;
    const sea = reading.roadmap().account.trees.get(tree).kinds.find((kind) => kind.hue === 'sky').id;
    await session.dispatch({ kind: 'RenameKind', id: sea, label: 'Sea' }).act;
    await session.dispatch({ kind: 'RemoveKind', id: sea }).act;
    await undo();
    await a.sync();
    await redo();
    await a.sync();
    committed(await a.runner.runAct(new CreateKind(tree, { hue: 'sky', label: 'Weather' })));
    await undo();
    assert.deepEqual(legend(), ['Build terracotta', 'Learn olive', 'Milestone gold', 'Weather sky']);

    await session.dispatch({ kind: 'RecolorKind', id: 'learn', hue: 'plum' }).act;
    committed(await a.runner.runAct(new CreateKind(tree, { hue: 'olive', label: 'Wind' })));
    await undo();
    assert.deepEqual({ legend: legend(), undone: told.events.filter(([, props]) => props.action === 'undo').map(([, props]) => props.outcome) }, {
      legend: ['Build terracotta', 'Learn plum', 'Milestone gold', 'Weather sky', 'Wind olive'],
      undone: ['unavailable', 'unavailable'],
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('a receipt’s own Undo, the door Roadmap Coach’s Undo takes (`revert`), is checked as ⌘Z’s is, its receipt on the stack or kept out of it: a removed kind comes back not while a kind made since wears its hue, and answers refused; with the hue free it comes back', async () => {
  const { a, tree, reading, session, told, reports } = await gestures();
  try {
    const { CreateKind } = await import('../../../../src/products/roadmap/domain/kinds.js');
    const kinds = () => reading.roadmap().account.trees.get(tree).kinds.filter((kind) => kind.present);
    const legend = () => kinds().map(({ hue, label }) => `${label} ${hue}`);
    const reverted = async (receipt) => {
      const asked = session.revert(receipt);
      let settled = false;
      asked.then(() => { settled = true; });
      for (let round = 0; round < 5 && !settled; round += 1) {
        await a.sync();
        session.followInverses();
      }
      assert.ok(settled, 'the Undo settled');
      return asked;
    };
    const stacked = session.dispatch({ kind: 'RemoveKind', id: 'learn' });
    const kept = session.keepUndoably({ kind: 'RemoveKind', id: 'milestone' });
    await Promise.all([stacked.act, kept.act]);
    committed(await a.runner.runAct(new CreateKind(tree, { hue: 'olive', label: 'Wind' })));
    committed(await a.runner.runAct(new CreateKind(tree, { hue: 'gold', label: 'Sun' })));
    const onTakenHues = { answers: [await reverted(stacked), await reverted(kept)], legend: legend() };

    const build = session.dispatch({ kind: 'RemoveKind', id: 'build' });
    const sun = session.keepUndoably({ kind: 'RemoveKind', id: kinds().find((kind) => kind.label === 'Sun').id });
    await Promise.all([build.act, sun.act]);
    const onFreeHues = { outcomes: [inverseOutcome(await reverted(build)), inverseOutcome(await reverted(sun))], legend: legend() };
    assert.deepEqual({ onTakenHues, onFreeHues, held: { stacked: session.undoStack, kept: session.kept }, events: told.events, reports }, {
      onTakenHues: { answers: [{ kind: 'unavailable', requestId: null, reason: 'refused' }, { kind: 'unavailable', requestId: null, reason: 'refused' }],
        legend: ['Build terracotta', 'Wind olive', 'Sun gold'] },
      onFreeHues: { outcomes: ['applied', 'applied'], legend: ['Build terracotta', 'Wind olive', 'Sun gold'] },
      held: { stacked: [], kept: [] },
      events: ['unavailable', 'unavailable', 'applied', 'applied'].map((outcome) => ['roadmap_undo', { action: 'undo', outcome }]),
      reports: [],
    });
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

test('a room whose roadmap stops standing while it is open keeps its last picture in its session, as the room does', async () => {
  const { a, tree } = await sailing();
  try {
    const { reading, session } = await openRoom(a, tree);
    const before = session.treeData();
    await session.deleteRoadmap(tree);
    assert.deepEqual({ standing: reading.roadmap().seed, shown: session.treeData(), steps: session.treeData()?.nodes.map((step) => step.label) },
      { standing: null, shown: before, steps: ['Read the wind', 'Leave the dock', 'Sail solo'] });
    reading.close();
  } finally {
    a.close();
  }
});

test('a gesture the domain refuses is decided before anything is written; one it takes says it landed, with its acts’ results', async () => {
  const { a, steps, reading, session, told, reports, shown } = await gestures();
  try {
    const before = journaled(a);
    assert.equal(session.dispatch({ kind: 'CreateNode', id: 'f0c1e9d0-1111-4c5e-8000-000000000002', label: 'x'.repeat(201), prerequisites: [] }), null);
    assert.equal(session.markProgress([steps.solo], 'complete'), false);
    const pasted = session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots' }], edges: [{ from: steps.dock, to: 'knots' }], kinds: [] });
    const [imported] = await pasted.landed;
    assert.deepEqual({ shown: shown(), minted: /^[0-9a-z]{16}$/.test(imported.knots), present: reading.roadmap().seed.nodes.some((step) => step.id === imported.knots),
      told, reports, journaled: journaled(a) - before }, {
      shown: { 'Read the wind': [], 'Leave the dock': ['Read the wind'], 'Sail solo': [], Knots: ['Leave the dock'] },
      minted: true, present: true,
      told: { said: [], events: [['roadmap_write_refused', { write: 'CreateNode', refusal: 'invalid' }], ['roadmap_write_refused', { write: 'mark', refusal: 'invalid' }]], statuses: 0 },
      reports: [], journaled: 1,
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('a write the store does not take is reported once, by the write door; the doors above it hear a failure already reported', async () => {
  const { a, tree, reading, session, reports } = await gestures();
  try {
    a.failNextCommit();
    const renamed = await session.renameRoadmap(tree, 'Learn to sail fast');
    a.failNextCommit();
    const shared = await session.setVisibility('public').catch((error) => error instanceof BoundaryFailure);
    a.failNextCommit();
    const deleted = await session.deleteRoadmap(tree).catch((error) => error instanceof BoundaryFailure);
    a.failNextCommit();
    const landed = await session.dispatch({ kind: 'RenameNode', id: reading.roadmap().seed.nodes[0].id, label: 'Watch the wind' }).landed;
    assert.deepEqual({ renamed, shared, deleted, landed, reports }, {
      renamed: false, shared: true, deleted: true, landed: null,
      reports: [['roadmap-replica-write', { write: 'title' }], ['roadmap-replica-write', { write: 'visibility' }],
        ['roadmap-replica-write', { write: 'deleteRoadmap' }], ['roadmap-replica-write', { write: 'RenameNode' }]],
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('a gesture of several acts is one composed act: a part refused partway writes nothing, and one Undo takes back every part', async () => {
  const { a, tree, steps, reading, session, told, shown } = await gestures();
  try {
    const kinds = () => reading.roadmap().account.trees.get(tree).kinds.filter((kind) => kind.present).map((kind) => kind.hue);
    const before = { shown: shown(), kinds: kinds() };
    const pasted = session.dispatch({ kind: 'ImportSubgraph', nodes: [{ id: 'knots', label: 'Knots', color: 'sky' }], edges: [],
      kinds: [{ id: 'sea', hue: 'sky', label: 'Sea' }, { id: 'swell', hue: 'sky', label: 'Swell' }] });
    assert.notEqual(pasted, null);
    const refused = { landed: await pasted.landed, act: await pasted.act, shown: shown(), kinds: kinds() };
    const recoloured = session.dispatch({ kind: 'BulkRecolor', nodeIds: [steps.wind, steps.dock], color: 'plum' });
    await recoloured.landed;
    const colours = () => reading.roadmap().seed.nodes.filter((step) => [steps.wind, steps.dock].includes(step.id)).map((step) => step.color);
    const painted = colours();
    session.undo();
    await until(() => colours().every((colour) => colour === 'terracotta'), 1000);
    assert.deepEqual({ refused, painted, told }, {
      refused: { landed: null, act: null, shown: before.shown, kinds: before.kinds },
      painted: ['plum', 'plum'],
      told: { said: [], events: [['roadmap_write_refused', { write: 'ImportSubgraph', refusal: 'invalid' }]], statuses: 1 },
    });
  } finally {
    reading.close();
    a.close();
  }
});

test('each Undo and Redo is told to the intake by what it came to: applied, skipped where another device changed the step since, and unavailable where the gesture wrote nothing', async () => {
  const { a, tree, steps, reading, session, told } = await gestures();
  try {
    const b = await a.device();
    await a.sync();
    // Each Undo and Redo asked, then settled on the server and followed.
    const undo = async () => { session.undo(); await session.redoStack.at(-1).inverse; };
    const redo = async () => { session.redo(); await session.undoStack.at(-1).act; };
    const settle = async () => { await a.sync(); session.followInverses(); };
    await session.dispatch({ kind: 'RenameNode', id: steps.wind, label: 'Watch the wind' }).landed;
    await a.sync();
    const { ChangeStep } = await import('../../../../src/products/roadmap/domain/steps.js');
    committed(await b.runner.runAct(new ChangeStep(tree, steps.wind, { label: 'Feel the wind' })));
    await a.sync();
    await undo();
    await settle();
    await redo();
    await settle();
    a.failNextCommit();
    await session.dispatch({ kind: 'RenameNode', id: steps.dock, label: 'Cast off' }).landed;
    await undo();
    await redo();
    await session.dispatch({ kind: 'RenameNode', id: steps.solo, label: 'Sail alone' }).landed;
    await undo();
    await settle();
    assert.deepEqual(told.events, [
      ['roadmap_undo', { action: 'undo', outcome: 'skipped' }],
      ['roadmap_undo', { action: 'redo', outcome: 'skipped' }],
      ['roadmap_undo', { action: 'undo', outcome: 'unavailable' }],
      ['roadmap_undo', { action: 'redo', outcome: 'unavailable' }],
      ['roadmap_undo', { action: 'undo', outcome: 'applied' }],
    ]);
  } finally {
    reading.close();
    a.close();
  }
});
