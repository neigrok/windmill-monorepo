// Roadmap Coach's tool host over a room open on a real engine's copy: each direct write through the room's own door, what
// the door wrote and did not, the Undo of each kind of write and what it came to, and, under the platform's turn engine,
// who tells each call and reports what throws.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { TurnRunner } from '../../../../src/platform/agent/turn.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { BoardActs } from '../../../../src/products/roadmap/board/useBoardActs.js';
import { RoadmapToolHost, WriteReceipt } from '../../../../src/products/roadmap/coach/toolHost.js';
import { readStanding } from '../../../../src/products/roadmap/domain/abilities/standing.js';
import { CreateRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
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

// A room opened on the device's copy of `treeId`, following it, with its session where the room's writes reach for it and
// what the session tells kept.
async function openRoom(a, treeId) {
  const said = [];
  const room = { sessionRef: { current: null } };
  const snapshot = { engine: a.engine, ready: true, online: true, error: false };
  const reading = new ReplicaReading({ treeId, room, say: (words) => said.push(words), timers: a.env.timers,
    session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
  assert.notEqual(await reading.read({ signal: new AbortController().signal }), null);
  reading.follow({ onTree() {}, onProgress() {}, onWorkspace() {}, onGuides() {}, onLanding() {}, onActivity() {} });
  const session = room.sessionRef.current;
  const roomTold = [];
  session.track = (name, props) => roomTold.push([name, props]);
  return { reading, session, said, roomTold };
}

// The standing roadmap as the room shows it now (Roadmap Coach D-2).
function standingOf(reading) {
  const roadmap = reading.roadmap();
  return readStanding([...roadmap.held.values()].map((held) => held.copy(roadmapRegistry)), { listRead: roadmap.listRead });
}

// The tool host of a conversation about `about`, over the room's session and what the room shows, with what it tells and
// the rows it tells the room's Activity kept.
function coachOver({ session, reading }, about, collaborators = {}) {
  const told = [];
  const rows = [];
  const tools = new RoadmapToolHost({ session, standing: () => standingOf(reading), about, track: (name, props) => told.push([name, props]),
    activity: (row, options) => rows.push([row, options]), ...collaborators });
  return { tools, told, rows };
}

// The rows the room's own Board tells its Activity of one change, made by its own acts over the roadmap `sailing` holds.
function boardRows(steps, change) {
  const rows = [];
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: steps.dock, label: 'Leave the dock', prerequisites: [], color: 'terracotta' },
    { id: steps.knot, label: 'Tie a bowline', prerequisites: [], color: 'terracotta' },
    { id: steps.sail, label: 'Sail with an instructor', prerequisites: [steps.dock, steps.knot], color: 'terracotta' },
  ] });
  const acts = new BoardActs({ tree, treeId: tree.id, active: true, owner: true, progress: { completed: new Set(), completedAt: {} }, query: new BoardQuery(),
    now: () => 17, session: { ready: true, holdAct() {}, endHeldAct() {}, leavePage() {}, dispatch: () => ({}), revert: () => true },
    showToast() {}, setQuery() {}, onReveal() {}, onQuiet() {}, onHeld() {}, track() {}, report: (operation, error) => assert.fail(`${operation}: ${error}`),
    emit: (row, options) => rows.push([row, options]) });
  assert.deepEqual(change(acts), { ok: true });
  return rows;
}

// Each Undo asked, once the engine has settled it: the server settles an Undo, so the phone syncs until each has, a few
// rounds at most.
async function undone(a, tools, ...receipts) {
  const answers = Promise.all(receipts.map((receipt) => tools.undo(receipt)));
  let settled = false;
  answers.then(() => { settled = true; });
  for (let round = 0; round < 5 && !settled; round += 1) await a.sync();
  assert.ok(settled, 'every Undo settled');
  return answers;
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
      receipt: new WriteReceipt({ ability: 'create_node', treeId: tree, nodeId: minted, room: room.session.undoStack[0] }) });
    const runs = [
      await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      await tools.run('update_node', { treeId: tree, nodeId: steps.knot, description: 'Round the post.', links: [{ url: 'https://example.org/cleat' }] }),
      await tools.run('connect', { treeId: tree, nodeId: minted, prerequisiteId: steps.knot }),
      await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' }),
    ];
    assert.deepEqual(runs, [
      ...[['update_node', steps.knot], ['update_node', steps.knot], ['connect', minted]].map(([ability, nodeId], index) => ({ answer: { result: {} },
        receipt: new WriteReceipt({ ability, treeId: tree, nodeId, room: room.session.undoStack[index + 1] }) })),
      { answer: { result: {} }, receipt: new WriteReceipt({ ability: 'set_progress', treeId: tree, nodeId: steps.dock, room: room.session.kept[0] }) },
    ]);
    assert.deepEqual(drawn(room.reading), {
      'Leave the dock': { color: 'terracotta', description: '', links: [], after: [], done: true },
      'Tie a cleat hitch': { color: 'terracotta', description: 'Round the post.', links: [{ url: 'https://example.org/cleat', label: '' }], after: [], done: false },
      'Sail with an instructor': { color: 'terracotta', description: '', links: [], after: ['Leave the dock', 'Tie a cleat hitch'], done: false },
      'Hoist the sail': { color: 'olive', description: '', links: [], after: ['Leave the dock', 'Tie a cleat hitch'], done: false },
    });
    assert.deepEqual({ stacked: room.session.undoStack.length, kept: room.session.kept.length }, { stacked: 4, kept: 1 },
      'each structure act stands on the room\'s own stack, where its ⌘Z reaches it, and the mark out of it, as the room\'s marks are');
    assert.deepEqual({ told, said: room.said }, { told: [], said: [] }, 'the turn\'s engine tells each call; the host tells none');
    room.reading.close();
  } finally {
    a.close();
  }
});

test('a direct write tells the room\'s Activity the row the room\'s own Board tells of the same change, silently: a new name alone', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, rows } = coachOver(room, tree);
    const told = async (/** @type {string} */ name, /** @type {any} */ input) => {
      assert.ok('result' in (await tools.run(name, { treeId: tree, ...input })).answer);
      return rows.splice(0);
    };
    const coach = {
      renamed: await told('update_node', { nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      described: await told('update_node', { nodeId: steps.knot, description: 'Round the post.' }),
      created: await told('create_node', { label: 'Hoist the sail', prerequisites: [steps.dock] }),
      linked: await told('connect', { nodeId: steps.knot, prerequisiteId: steps.dock }),
      listed: await told('update_node', { nodeId: steps.knot, label: 'Tie a cleat hitch', subtasks: ['Check the shackle'] }),
    };
    assert.deepEqual(coach, {
      renamed: boardRows(steps, (acts) => acts.edit({ id: steps.knot, label: 'Tie a cleat hitch' })),
      described: boardRows(steps, (acts) => acts.edit({ id: steps.knot, description: 'Round the post.' })),
      created: boardRows(steps, (acts) => acts.create({ id: 'hoist', label: 'Hoist the sail', color: 'terracotta', prerequisites: [steps.dock] })),
      linked: boardRows(steps, (acts) => acts.edit({ id: steps.knot, prerequisites: [steps.dock] })),
      listed: [],
    });
    assert.deepEqual(coach, { renamed: [[{ verb: 'renamed', nodeId: steps.knot, label: 'Tie a cleat hitch', kind: 'terracotta' }, { silent: true }]],
      described: [], created: [], linked: [], listed: [] },
    'the person\'s own row, which names no actor, so the room says You; a title the step holds is no new name, and the room tells no row of a subtask');
    await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });
    assert.deepEqual(rows, [], 'a mark\'s rows come as the room adopts the copy\'s marks');
    room.reading.close();
  } finally {
    a.close();
  }
});

test('update_node writes a step\'s fields and the items it adds to its checklist as one structure act on the room\'s stack, read back as the person\'s own, and one Undo takes back all of it', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);
    room.session.workspace.addSubtask(steps.knot, 'Identify the halyard');
    await until(() => (room.reading.roadmap().workspace[steps.knot]?.subtasks.length ?? 0) === 1, 1000);
    const checklist = () => (room.reading.roadmap().workspace[steps.knot]?.subtasks ?? []).map(({ label, done }) => ({ label, done }));

    const { answer, receipt } = await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch', subtasks: ['Check the shackle', 'Coil the line'] });
    assert.deepEqual({ answer, stacked: room.session.undoStack, kept: room.session.kept.length }, { answer: { result: {} }, stacked: [receipt.room], kept: 0 }, 'one receipt');
    assert.equal(drawn(room.reading)['Tie a cleat hitch'].after.length, 0);
    assert.deepEqual(checklist(), [{ label: 'Identify the halyard', done: false }, { label: 'Check the shackle', done: false }, { label: 'Coil the line', done: false }]);
    assert.deepEqual(await tools.run('get_nodes', { treeId: tree, nodeIds: [steps.knot, steps.dock], fields: ['subtasks'] }), { answer: { result: { steps: [
      { id: steps.knot, subtasks: checklist() }, { id: steps.dock, subtasks: [] }] } }, receipt: null }, 'Coach reads the list before adding to it');

    assert.deepEqual(await undone(a, tools, receipt), ['undone']);
    assert.deepEqual({ label: room.reading.roadmap().seed.nodes.find((step) => step.id === steps.knot).label, checklist: checklist() },
      { label: 'Tie a bowline', checklist: [{ label: 'Identify the halyard', done: false }] }, 'the name and both items it added, and the person\'s own item stays');
    assert.deepEqual(told, [['roadmap_coach_write_undone', { ability: 'update_node', outcome: 'undone' }]]);
    room.reading.close();
  } finally {
    a.close();
  }
});

test('an update_node that only adds items keeps its Undo off the room\'s stack, as the room\'s own workspace edits do, so the person\'s next ⌘Z takes back their own act', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools } = coachOver(room, tree);
    const checklist = () => (room.reading.roadmap().workspace[steps.knot]?.subtasks ?? []).map(({ label }) => label);
    const label = () => room.reading.roadmap().seed.nodes.find((step) => step.id === steps.dock).label;
    const persons = room.session.dispatch({ kind: 'RenameNode', id: steps.dock, label: 'Cast off' });
    await persons.landed;

    const { answer, receipt } = await tools.run('update_node', { treeId: tree, nodeId: steps.knot, subtasks: ['Check the shackle', 'Coil the line'] });
    assert.deepEqual({ answer, stacked: room.session.undoStack, kept: room.session.kept }, { answer: { result: {} }, stacked: [persons], kept: [receipt.room] });
    assert.deepEqual(checklist(), ['Check the shackle', 'Coil the line']);

    room.session.undo();
    await until(() => label() === 'Leave the dock', 1000);
    assert.deepEqual({ label: label(), checklist: checklist() }, { label: 'Leave the dock', checklist: ['Check the shackle', 'Coil the line'] },
      'the person\'s ⌘Z took back their own rename, and Coach\'s items stand');
    assert.deepEqual(await undone(a, tools, receipt), ['undone']);
    assert.deepEqual({ checklist: checklist(), kept: room.session.kept }, { checklist: [], kept: [] }, 'its own Undo takes them back');
    room.reading.close();
  } finally {
    a.close();
  }
});

test('Undo takes back each kind of write by the room\'s Undo of its act, sparing what was written since, and is taken once', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);
    const { receipt: created } = await tools.run('create_node', { treeId: tree, label: 'Hoist the sail', prerequisites: [steps.dock] });
    const { receipt: renamed } = await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' });
    const { receipt: annotated } = await tools.run('update_node', { treeId: tree, nodeId: steps.knot, description: 'Round the post.' });
    const { receipt: linked } = await tools.run('connect', { treeId: tree, nodeId: steps.knot, prerequisiteId: steps.dock });
    const { receipt: completed } = await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });

    assert.deepEqual(await undone(a, tools, renamed, linked, created, completed), ['undone', 'undone', 'undone', 'undone']);
    assert.deepEqual(drawn(room.reading), {
      'Leave the dock': { color: 'terracotta', description: '', links: [], after: [], done: false },
      'Tie a bowline': { color: 'terracotta', description: 'Round the post.', links: [], after: [], done: false },
      'Sail with an instructor': { color: 'terracotta', description: '', links: [], after: ['Leave the dock', 'Tie a bowline'], done: false },
    }, 'the description written after the rename stands');
    assert.deepEqual(await undone(a, tools, annotated), ['undone']);
    assert.equal(drawn(room.reading)['Tie a bowline'].description, '');
    assert.deepEqual(await undone(a, tools, renamed, completed), ['unavailable', 'unavailable'], 'each is taken back once');

    await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });
    const { receipt: reset } = await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'none' });
    assert.deepEqual(await undone(a, tools, reset), ['undone']);
    assert.equal(drawn(room.reading)['Leave the dock'].done, true, 'a Reset taken back marks the step done again');
    assert.deepEqual(told, [...['update_node', 'connect', 'create_node', 'set_progress', 'update_node'].map((ability) => [ability, 'undone']),
      ['update_node', 'unavailable'], ['set_progress', 'unavailable'], ['set_progress', 'undone']]
      .map(([ability, outcome]) => ['roadmap_coach_write_undone', { ability, outcome }]));
    assert.deepEqual({ stacked: room.session.undoStack.length, kept: room.session.kept.length }, { stacked: 0, kept: 1 }, 'the Complete before the Reset still keeps its Undo');
    room.reading.close();
  } finally {
    a.close();
  }
});

test('an Undo a later write stands in the way of is skipped and says so: a title the person wrote since, and a mark they set since', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const { tools, told } = coachOver(room, tree);
    const { receipt: renamed } = await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Coach\'s title' });
    await room.session.dispatch({ kind: 'RenameNode', id: steps.knot, label: 'The person\'s title' }).landed;
    const { receipt: completed } = await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' });
    assert.equal(room.session.markProgress(steps.dock, 'none'), true);
    assert.equal(room.session.markProgress(steps.dock, 'complete'), true);
    await a.sync();

    assert.deepEqual(await undone(a, tools, renamed, completed), ['skipped', 'skipped']);
    const knot = room.reading.roadmap().seed.nodes.find((step) => step.id === steps.knot);
    assert.deepEqual({ label: knot.label, done: room.reading.roadmap().marks.completed.has(steps.dock) }, { label: 'The person\'s title', done: true });
    assert.deepEqual(told, [['update_node', 'skipped'], ['set_progress', 'skipped']].map(([ability, outcome]) => ['roadmap_coach_write_undone', { ability, outcome }]));
    assert.deepEqual(room.roomTold.filter(([name]) => name === 'roadmap_undo'), [['roadmap_undo', { action: 'undo', outcome: 'skipped' }], ['roadmap_undo', { action: 'undo', outcome: 'skipped' }]],
      'the room tells the same of each');
    room.reading.close();
  } finally {
    a.close();
  }
});

test('a door that wrote nothing is no-change or roadmap-not-ready, never a success, and leaves nothing on the room\'s Undo stack', async () => {
  const { a, tree, steps } = await sailing();
  try {
    const room = await openRoom(a, tree);
    const before = standingOf(room.reading);
    const { tools } = coachOver(room, tree, { standing: () => before });
    await room.session.dispatch({ kind: 'RenameNode', id: steps.knot, label: 'Tie a cleat hitch' }).landed;
    assert.equal(room.session.markProgress(steps.dock, 'complete'), true);
    await room.session.dispatch({ kind: 'AddEdge', from: steps.dock, to: steps.knot }).landed;
    await until(() => room.reading.roadmap().marks.completed.has(steps.dock), 1000);
    const persons = [...room.session.undoStack];

    assert.deepEqual([
      await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      await tools.run('set_progress', { treeId: tree, nodeId: steps.dock, status: 'complete' }),
      await tools.run('connect', { treeId: tree, nodeId: steps.dock, prerequisiteId: steps.knot }),
    ], [
      { answer: { refused: { code: 'no-change', id: steps.knot } }, receipt: null },
      { answer: { refused: { code: 'no-change', id: steps.dock } }, receipt: null },
      { answer: { refused: { code: 'roadmap-not-ready', id: steps.dock } }, receipt: null },
    ]);
    a.failNextCommit();
    assert.deepEqual(await tools.run('update_node', { treeId: tree, nodeId: steps.sail, description: 'With a skipper.' }),
      { answer: { refused: { code: 'roadmap-not-ready', id: steps.sail } }, receipt: null }, 'a write the device could not store');
    assert.equal(drawn(room.reading)['Sail with an instructor'].description, '');
    assert.deepEqual({ stacked: room.session.undoStack, kept: room.session.kept }, { stacked: persons, kept: [] });

    room.session.undo();
    await until(() => room.reading.roadmap().seed.nodes.find((step) => step.id === steps.knot).prerequisites.length === 0, 1000);
    assert.equal(drawn(room.reading)['Tie a cleat hitch'].after.length, 0, 'the person\'s next ⌘Z takes back their own link');
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
      await tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a \ud800 bowline' }),
      await tools.run('get_nodes', { treeId: tree, nodeIds: [steps.sail], fields: ['state'] }),
    ], [
      { answer: { refused: { code: 'invalid-input' } }, receipt: null },
      { answer: { refused: { code: 'step-locked', id: steps.sail } }, receipt: null },
      { answer: { refused: { code: 'invalid-input', id: steps.knot } }, receipt: null },
      { answer: { result: { steps: [{ id: steps.sail, state: 'locked' }] } }, receipt: null },
    ]);

    const roadmap = room.reading.roadmap();
    const pulling = [...roadmap.held.values()].map((held) => new HeldRoadmap({ id: held.id, record: held.record, tree: held.records, stored: held.stored,
      overlay: held.overlay, queued: held.queued, read: false }));
    const rebuilding = coachOver(room, tree, { standing: () => readStanding(pulling.map((held) => held.copy(roadmapRegistry))) });
    assert.deepEqual(await rebuilding.tools.run('update_node', { treeId: tree, nodeId: steps.knot, label: 'Tie a cleat hitch' }),
      { answer: { refused: { code: 'roadmap-unavailable', id: tree } }, receipt: null });
    assert.deepEqual({ entries: entries(), told: [...told, ...rebuilding.told], stacked: room.session.undoStack.length },
      { entries: queued, told: [], stacked: 0 }, 'nothing reached the engine');
    room.reading.close();
  } finally {
    a.close();
  }
});

// A turn of the platform's engine whose one round calls `name` with `input` through the tool host, as a roadmap turn's host
// hands a call over, with what the engine and the host tell and report kept.
async function turnOver(tools, name, input) {
  const story = JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/agent/turns/text.json', import.meta.url), 'utf8'));
  const told = [];
  const reported = [];
  let round = 0;
  const profile = { ...story.profile, groups: [], refusals: { ...story.profile.refusals, 'no-change': 'no-change.' },
    tools: [{ name, description: name, input: { type: 'object', additionalProperties: true }, countsAsWrite: true }] };
  const runner = new TurnRunner({
    ai: { clearPass() {}, connected: () => true, text: async () => (round++ === 0
      ? { event: 'ended', data: { stop: 'tool_calls', message: { role: 'assistant', parts: [{ toolCall: { id: 'c1', name, input } }], carry: 'c' } } }
      : { event: 'ended', data: { stop: 'completed', message: { role: 'assistant', parts: [{ text: 'Done' }], carry: 'c' } } }) },
    telemetry: { turn() {}, ability: (event) => told.push(['ability', event]), failure: (operation, error) => reported.push([operation, error]) },
    runtime: { now: () => 0, newId: () => `call-${round}`, withLock: (_, options, body) => body(true) },
    host: { open: async () => ({ ...story.host.open, lease: 'lease' }), beginRound: async () => {}, text: async () => {}, end: async () => {}, check: async () => null,
      execute: async (lease, identity, call) => {
        const { answer } = await tools.run(call.name, call.input);
        return 'refused' in answer ? { ok: false, code: answer.refused.code } : { ok: true, content: JSON.stringify(answer.result) };
      } },
  });
  const end = await runner.run(story.input, profile);
  return { end, told, reported };
}

test('the turn\'s engine tells each call once and reports a throw once, the ability\'s or the room\'s door\'s; the host tells and reports nothing of a call', async () => {
  const roadmap = { id: 't_0000000000000001', own: true, meta: { title: 'Learn to sail' }, nodes: [{ id: 'a', label: 'Leave the dock' }] };
  const told = [];
  const host = (collaborators) => new RoadmapToolHost({ session: { treeId: roadmap.id }, standing: () => ({ trees: [roadmap] }), about: roadmap.id,
    track: (name, props) => told.push([name, props]), activity: (row) => told.push(['activity', row]), ...collaborators });
  const thrown = new TypeError('an input the host should never send');
  const broken = new TypeError('the door broke');

  const refused = await turnOver(host({}), 'update_node', { treeId: roadmap.id, nodeId: 'a', label: 'Leave the dock' });
  const throwing = await turnOver(host({ abilities: { update_node: () => { throw thrown; } } }), 'update_node', { treeId: roadmap.id, nodeId: 'a', label: 'Cast off' });
  const door = await turnOver(host({ session: { treeId: roadmap.id, dispatch: () => { throw broken; } } }), 'update_node', { treeId: roadmap.id, nodeId: 'a', label: 'Cast off' });
  assert.deepEqual([refused, throwing, door].map(({ end, told: engine, reported }) => ({ state: end.state, code: end.code, engine, reported })), [
    { state: 'completed', code: null, engine: [['ability', { name: 'update_node', outcome: 'refused', code: 'no-change' }]], reported: [] },
    { state: 'failed', code: 'host-fault', engine: [], reported: [['agent-host', thrown]] },
    { state: 'failed', code: 'host-fault', engine: [], reported: [['agent-host', broken]] },
  ]);
  assert.deepEqual(told, []);
});
