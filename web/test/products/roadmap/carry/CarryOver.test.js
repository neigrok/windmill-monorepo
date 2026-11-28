// The carry-over (roadmap-on-the-engine.md §8.2), tested from stores the last old bundle wrote: each fixture is written by
// the old bundle's own code (`bearImportedTree`, `SyncSession`, `WorkspaceStore` and the model it edits), and the new
// bundle's engine runs live over roadmap's binding of the reference model server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { FakeChannels, FakeLocks } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CarriedIds, CarriedRoadmap, CarryLedger, CarryRoadmap, carryLedgerOf } from '../../../../src/products/roadmap/domain/carry.js';
import { CoachMessage, CoachProposal, CoachThread, Conversation, EndTurn, MintProposal, OpenTurn } from '../../../../src/products/roadmap/domain/conversation.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { StepMark, StepPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { CreateRoadmap, DeleteRoadmap, Roadmap, RoadmapMeta, SetVisibility } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { ChangeStep, RoadmapLink, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { StepLink, StepNote, Subtask } from '../../../../src/products/roadmap/domain/workspace.js';
import { CarryOver } from '../../../../src/products/roadmap/carry/CarryOver.js';
import { OldStores } from '../../../../src/products/roadmap/carry/OldStores.js';
import { DEFAULT_KINDS } from '../../../../src/products/roadmap/model/Legend.js';
import { addLink, addSubtask, emptyWorkspace, setNote, toggleSubtask } from '../../../../src/products/roadmap/model/NodeWorkspace.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../../../../src/products/roadmap/persistence/ProgressStore.js';
import { WorkspaceStore } from '../../../../src/products/roadmap/persistence/WorkspaceStore.js';
import { bearImportedTree } from '../../../../src/products/roadmap/sync/localTrees.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';

// Roadmap's binding of the reference model server, one state every browser and device of a test reaches.
class Server {
  constructor() {
    this.state = ServerState.empty({ epoch: 'ep-carry', accounts: { A: { name: 'A' }, B: { name: 'B' } } });
    this.product = new RoadmapProduct();
    this.reachable = true;
  }

  answer(endpoint, request, account, reading) {
    if (!this.reachable) throw Object.assign(new TypeError('the server does not answer'), { kind: 'network' });
    const now = Date.now();
    let response;
    if (endpoint === 'hello') response = hello({ state: this.state, registry: roadmapRegistry, account, serverTime: now });
    else {
      const out = (endpoint === 'push' ? push : pull)({ state: this.state, registry: roadmapRegistry, product: this.product, account, request, serverNow: now });
      this.state = out.state;
      response = out.response;
    }
    return { response, timing: { send: reading(), recv: reading() } };
  }
}

// A socket the old bundle's sessions open and that never connects: the old bundle runs offline.
class NoSocket {
  constructor() { this.readyState = 0; }
  addEventListener() {}
  send() {}
  close() { this.readyState = 3; }
}

// One browser: its storage, which the old bundle wrote and the new bundle's engine shares, and the locks and channels of
// its tabs. The old bundle's stores read the page's globals, as they do in a browser.
function browser(t) {
  // As a browser's localStorage: each stored key an own property, so `Object.keys` lists them.
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => (Object.hasOwn(storage, key) ? storage[key] : null) },
    setItem: { value: (key, value) => { storage[key] = String(value); } },
    removeItem: { value: (key) => { delete storage[key]; } },
    key: { value: (index) => Object.keys(storage)[index] ?? null },
    length: { get: () => Object.keys(storage).length },
  });
  const listening = { addEventListener() {}, removeEventListener() {} };
  const page = { indexedDB: new IDBFactory(), window: { localStorage: storage, ...listening }, localStorage: storage, document: { visibilityState: 'visible', ...listening },
    WebSocket: NoSocket, fetch: async () => { throw new TypeError('no network in the old bundle'); } };
  for (const [key, value] of Object.entries(page)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  return { storage, engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() };
}

// A tab of the new bundle on `disk`: its engine live over `server`, signed in as `account` or signed out, under the
// engine's `limits`.
async function tab(t, disk, server, account = null, limits = {}) {
  const transport = {
    account,
    request: async (endpoint, request) => server.answer(endpoint, request, transport.account, () => engine.reading()),
    openLive: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  };
  const engine = await BrowserSyncEngine.open({ indexedDB: disk.engines, keyRange: IDBKeyRange, registry: roadmapRegistry, transport, timers: globalThis,
    now: Date.now, monotonic: () => Math.floor(performance.now()), navigator: { onLine: true, locks: disk.locks, storage: { persist: async () => true } },
    document: null, window: null, leadership: { locks: disk.locks, channel: disk.channels.open },
    telemetry: { event() {}, failure() {} }, limits });
  t.after(() => engine.close());
  if (account) assert.equal((await engine.signIn(account)).complete, true);
  await engine.start();
  return engine;
}

// The carry-over of one tab, its reports and events kept.
function carryOver(disk, { timers = globalThis, session = null, stores = new OldStores() } = {}) {
  const reported = [];
  const tracked = [];
  const carry = new CarryOver({ session, stores, locks: disk.locks, timers,
    report: (operation, error, tags) => reported.push({ operation, tags }), track: (name, props) => tracked.push({ name, ...props }) });
  return { carry, reported, tracked };
}

// The carry-over of a tab, started as the app starts it: once the engine stands, and again as `consider` says.
function started(t, disk, engine, options = {}) {
  const carrying = carryOver(disk, { ...options, session: { getSnapshot: () => ({ engine, ready: true }), subscribe: () => () => {} } });
  carrying.carry.start();
  t.after(() => carrying.carry.stop());
  return carrying;
}

// Until a started carry-over has taken up the engine's active binding and the runs it queued, the ones queued while they
// ran among them, are done.
async function settled(carry, engine) {
  await until(engine, () => carry.binding === engine.activeBinding(), 'the carry-over taking up the active replica');
  for (let running = null; running !== carry.running;) {
    running = carry.running;
    await running;
  }
}

const runner = (engine) => new ActionRunner(new EngineReplica(engine), roadmapRegistry, new FixedZone(0));

// Everything the replica holds of one roadmap, as the person would read it.
function holding(engine, tree) {
  const read = (scope, type) => runner(engine).read(scope, (reader) => reader.repository(type).all('drawn'));
  const overlay = RoadmapScopes.overlay(tree);
  const workspace = {};
  const of = (step) => (workspace[step] ??= { subtasks: [], links: [], note: '' });
  for (const subtask of read(overlay, Subtask)) of(subtask.step).subtasks.push([subtask.label, subtask.done]);
  for (const link of read(overlay, StepLink)) of(link.step).links.push([link.url, link.title]);
  for (const note of read(overlay, StepNote)) of(String(note.id.record)).note = note.text;
  return {
    listed: read(RoadmapScopes.account, Roadmap).some((roadmap) => roadmap.id.record === tree),
    title: read(RoadmapScopes.tree(tree), RoadmapMeta)[0]?.title ?? null,
    steps: read(RoadmapScopes.tree(tree), RoadmapStep).map((step) => [String(step.id.record), step.label]).sort(),
    links: read(RoadmapScopes.tree(tree), RoadmapLink).map((link) => [link.from, link.to]).sort(),
    kinds: read(RoadmapScopes.tree(tree), RoadmapKind).map((kind) => String(kind.id.record)).sort(),
    marks: read(overlay, StepMark).filter((mark) => mark.status === 'complete').map((mark) => String(mark.id.record)).sort(),
    pointers: read(overlay, StepPointer).map((pointer) => [String(pointer.id.record), pointer.opens]).sort(),
    workspace,
  };
}

// What the old bundle's stores still hold, by store.
async function oldStores() {
  return {
    sync: (await new SyncStore().treeIds({ durable: true })).sort(),
    index: Object.keys(new LocalTreeRegistry().entries()).sort(),
    workspaces: new WorkspaceStore().treeIds().sort(),
    marks: new ProgressStore().treeIds().sort(),
  };
}

const NOTHING_OLD = { sync: [], index: [], workspaces: [], marks: [] };

// The engine's queued entries of every scope, as many as there are.
const queued = (engine) => engine.device.activeReplica.outbox.filter((entry) => entry.state !== 'acked').length;

// The old bundle plants a roadmap with nobody signed in, as its new-roadmap door does from a paste, and marks a step in
// its room; it keeps a workspace on two steps, and a mark left undrained from before roadmap's own sync.
async function plantedSignedOut(owner = null) {
  globalThis.window.wmDeviceConfirmation = { owner };
  const id = await bearImportedTree({ title: 'Learn to sail', kinds: DEFAULT_KINDS, nodes: [
    { id: 'wind', label: 'Read the wind', color: 'olive', prerequisites: [] },
    { id: 'dock', label: 'Leave the dock', color: 'terracotta', prerequisites: ['wind'], description: 'Quietly, at slack water' },
    { id: 'solo', label: 'Sail solo', color: 'gold', prerequisites: ['dock'] },
  ] });
  const room = new SyncSession({ treeId: id, title: 'Learn to sail' });
  await room.start();
  room.markProgress(['wind'], 'complete');
  await room.persistNow();
  room.close();
  const workspaces = new WorkspaceStore();
  let wind = addSubtask(addSubtask(emptyWorkspace(), 'Check the forecast'), 'Watch the flags');
  wind = toggleSubtask(wind, wind.subtasks[0].id);
  wind = setNote(addLink(wind, 'www.example.org/wind'), 'Gusts come in from the left.');
  workspaces.save(id, { wind, solo: addSubtask(emptyWorkspace(), 'x'.repeat(300)) });
  globalThis.window.localStorage.setItem(`windmill:progress:${id}`, JSON.stringify({ completed: ['dock'], completedAt: { dock: 1_700_000_000_000 } }));
  return id;
}

// The roadmap `plantedSignedOut` plants, as the replica holds it once carried: the 300-character subtask on `solo` is past
// its bound, set aside for the one list.
const SAILED = {
  listed: true, title: 'Learn to sail',
  steps: [['dock', 'Leave the dock'], ['solo', 'Sail solo'], ['wind', 'Read the wind']],
  links: [['dock', 'solo'], ['wind', 'dock']],
  kinds: ['build', 'learn', 'milestone'],
  marks: ['dock', 'wind'],
  pointers: [],
  workspace: { wind: { subtasks: [['Check the forecast', true], ['Watch the flags', false]], links: [['https://www.example.org/wind', 'example.org']], note: 'Gusts come in from the left.' } },
};

test('a roadmap made signed out is carried into the anon replica under its id, with its marks, its workspace and the mark left undrained, and its old stores stay until the server takes its creation; the question to the server holds its tree open no longer than it asks', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  assert.deepEqual({ held: holding(engine, id), open: [...engine.openScopes], holders: [...engine.openings.keys()] }, { held: SAILED, open: [], holders: [] });
  const ledger = runner(engine).read(RoadmapScopes.account, (read) => carryLedgerOf(read, id));
  assert.deepEqual({ to: ledger.to, created: ledger.created }, { to: id, created: true });
  assert.deepEqual(ledger.kept.map((each) => [each.reason, each.subject.t, each.values.label]), [['pastBound', 'subtask', 'x'.repeat(300)]]);
  assert.deepEqual(await oldStores(), { sync: [id], index: [id], workspaces: [id], marks: [id] });
  assert.deepEqual(reported, []);
  assert.deepEqual(tracked, [
    { name: 'roadmap_carry', stage: 'found', roadmaps: '1', changed: '0', workspaces: '1', marks: '1' },
    { name: 'roadmap_carry', stage: 'carried', roadmaps: '1', moved: '0', changes: '0', marks: '2-5', items: '2-5', kept: '1', conversations: '0' },
    { name: 'roadmap_carry', stage: 'waiting', roadmaps: '1' },
  ]);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Another device of the same server, with storage of its own.
const device = (t, server, account) => tab(t, { engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() }, server, account);

// Until `seen` holds of the engine, which syncs on its own, or the bound passes.
async function until(engine, seen, what) {
  for (let turn = 0; turn < 250; turn += 1) {
    if (seen()) return;
    engine.kick();
    engine.kickPull();
    await pause(20);
  }
  assert.fail(`${what} never came`);
}

const sent = (engine) => until(engine, () => engine.device.activeReplica.outbox.every((entry) => entry.state === 'acked'), 'every entry acknowledged');

// A's other device plants a roadmap the server keeps: three steps, the first two linked.
async function plantedOnServer(t, server) {
  const phone = await device(t, server, 'A');
  const outcome = await runner(phone).runAct(new CreateRoadmap('Learn to row', { steps: [
    { key: 'grip', label: 'Grip the oars' }, { key: 'stroke', label: 'Pull a stroke' }, { key: 'turn', label: 'Turn the boat' },
  ], links: [['grip', 'stroke']] }));
  assert.equal(outcome.kind, 'committed');
  await sent(phone);
  return { phone, tree: outcome.result.tree, steps: outcome.result.steps };
}

// The old bundle's room on a roadmap the server keeps, signed in as A: the server's graft as the old server sent it, then
// changes made offline and never sent: a rename, a new step after the second, a deleted step, a mark and a subtask.
async function editedOffline(tree, steps) {
  globalThis.window.wmDeviceConfirmation = { owner: 'A' };
  const at = '1700000000000:0:server';
  const labels = { grip: 'Grip the oars', stroke: 'Pull a stroke', turn: 'Turn the boat' };
  const room = new SyncSession({ treeId: tree, title: 'Learn to row' });
  await room.start();
  room.receiveState({ t: 'subgraph', intent: 'graft', seq: 4, reach: 'writer', title: { v: 'Learn to row', at },
    nodes: Object.entries(steps).map(([key, id], index) => ({ id, createdAt: at, label: labels[key], labelAt: at, order: `a${index}`, orderAt: at })),
    edges: [{ from: steps.grip, to: steps.stroke, addedAt: at }],
    kinds: DEFAULT_KINDS.map((kind, rank) => ({ id: kind.id, createdAt: at, hue: kind.hue, hueAt: at, label: kind.label, labelAt: at, description: kind.description,
      descriptionAt: at, rank, rankAt: at })) });
  room.receiveProgressGraft({ marks: [] });
  room.dispatch({ kind: 'RenameNode', id: steps.grip, label: 'Grip the oars lightly' });
  room.dispatch({ kind: 'CreateNode', id: 'mile', label: 'Row a mile', prerequisites: [steps.stroke] });
  room.dispatch({ kind: 'DeleteNode', id: steps.turn });
  room.markProgress([steps.stroke], 'complete');
  await room.persistNow();
  room.close();
  new WorkspaceStore().save(tree, { [steps.grip]: addSubtask(emptyWorkspace(), 'Loosen the wrists') });
}

test('changes a signed-in browser had not sent are carried as new gestures after the roadmap’s first pull, and reach the server', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const { phone, tree, steps } = await plantedOnServer(t, server);
  await editedOffline(tree, steps);
  const engine = await tab(t, disk, server, 'A');
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  const expected = {
    listed: true, title: 'Learn to row',
    steps: [['mile', 'Row a mile'], [steps.grip, 'Grip the oars lightly'], [steps.stroke, 'Pull a stroke']].sort(),
    links: [[steps.grip, steps.stroke], [steps.stroke, 'mile']].sort(),
    kinds: ['build', 'learn', 'milestone'], marks: [steps.stroke], pointers: [],
    workspace: { [steps.grip]: { subtasks: [['Loosen the wrists', false]], links: [], note: '' } },
  };
  assert.deepEqual(holding(engine, tree), expected);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
  assert.deepEqual(tracked.map(({ stage }) => stage), ['found', 'carried', 'cleared']);
  assert.deepEqual(tracked[0], { name: 'roadmap_carry', stage: 'found', roadmaps: '0', changed: '1', workspaces: '1', marks: '0' });
  await sent(engine);
  for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) await phone.subscribe(scope).catch(() => {});
  await until(phone, () => JSON.stringify(holding(phone, tree)) === JSON.stringify(expected), 'the other device’s copy of the carried changes');
});

test('a claim cut short, a roadmap made signed out that the server already holds as the person’s own, is carried as changes to it', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id);
  await claimAnswered(id);
  const engine = await tab(t, disk, server, 'A');
  await until(engine, () => holding(engine, id).listed, 'the account’s list');
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  const held = holding(engine, id);
  assert.deepEqual({ steps: held.steps, links: held.links, marks: held.marks, subtasks: held.workspace.wind?.subtasks }, {
    steps: [['dock', 'Leave the dock'], ['solo', 'Sail solo'], ['wind', 'Read the wind']],
    links: [['dock', 'solo'], ['wind', 'dock']],
    marks: ['dock', 'wind'],
    subtasks: [['Check the forecast', true], ['Watch the flags', false]],
  });
  assert.deepEqual(runner(engine).read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').map((roadmap) => roadmap.id.record)), [id]);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
});

// The old bundle plants a second roadmap with nobody signed in, one step of which opens the first.
async function pointingAt(sail) {
  globalThis.window.wmDeviceConfirmation = { owner: null };
  const row = await bearImportedTree({ title: 'Learn to row', kinds: DEFAULT_KINDS, nodes: [{ id: 'sea', label: 'Row out to sea', color: 'olive', prerequisites: [] }] });
  const room = new SyncSession({ treeId: row, title: 'Learn to row' });
  await room.start();
  room.dispatch({ kind: 'SetNodeTree', id: 'sea', opens: sail });
  await room.persistNow();
  room.close();
  return row;
}

// The old bundle's claim of a roadmap made signed out, cut short once the server had answered it: its session took the
// server's graft of the roadmap the claim created, its title and genesis legend, and sent nothing the server confirmed.
async function claimAnswered(id) {
  const at = '1700000000000:0:server';
  const claim = new SyncSession({ treeId: id, title: 'Learn to sail' });
  await claim.start();
  claim.receiveState({ t: 'subgraph', intent: 'graft', seq: 1, reach: 'writer', title: { v: 'Learn to sail', at }, nodes: [], edges: [],
    kinds: DEFAULT_KINDS.map((kind, rank) => ({ id: kind.id, createdAt: at, hue: kind.hue, hueAt: at, label: kind.label, labelAt: at,
      description: kind.description, descriptionAt: at, rank, rankAt: at })) });
  await claim.persistNow();
  claim.close();
}

// A roadmap the server keeps under `id` for `account`, titled `title`, planted on that account's other device.
async function servedAs(t, server, account, id, title = 'Someone’s') {
  const phone = await device(t, server, account);
  const served = new CarriedRoadmap(id, { title, guide: '', kinds: DEFAULT_KINDS, steps: [], links: [] }, roadmapRegistry, runner(phone).moment());
  assert.equal((await runner(phone).runAct(new CarryRoadmap(id, served))).kind, 'committed');
  await sent(phone);
  return phone;
}

test('a claim cut short whose roadmap the person deleted on the server is created under a fresh id in their account', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const sail = await plantedSignedOut();
  const phone = await servedAs(t, server, 'A', sail);
  await claimAnswered(sail);
  const deleted = await runner(phone).runAct(new DeleteRoadmap(sail));
  for (const segment of deleted.receipt.segments) for (const localId of segment.localIds) await phone.release(localId);
  await sent(phone);
  const engine = await tab(t, disk, server, 'A');
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  const fresh = CarriedIds.roadmap(sail);
  assert.deepEqual({ sail: holding(engine, fresh).steps.length, kept: holding(engine, sail).listed }, { sail: 3, kept: false });
  assert.equal(tracked.find(({ stage }) => stage === 'carried').moved, '1');
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
});

test('signed out, a roadmap made here whose id the server serves for another account is created under a fresh id, and the device’s pointers at it move with it; both keep their old stores until the server takes them', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const sail = await plantedSignedOut();
  const row = await pointingAt(sail);
  const phone = await servedAs(t, server, 'B', sail);
  assert.equal((await runner(phone).runAct(new SetVisibility(sail, 'public'))).kind, 'committed');
  await sent(phone);
  const engine = await tab(t, disk, server);
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  const fresh = CarriedIds.roadmap(sail);
  assert.deepEqual({ fresh: holding(engine, fresh).steps.length, theirs: holding(engine, sail).listed, pointers: holding(engine, row).pointers },
    { fresh: 3, theirs: false, pointers: [['sea', fresh]] });
  assert.deepEqual((await oldStores()).sync, [row, sail].sort());
  assert.deepEqual(reported, []);
});

test('a carry cut short writes nothing or everything: a commit the store refuses keeps every old entry for the next load, and one that landed is not written twice', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut('A');
  const engine = await tab(t, disk, server, 'A');
  const commitAct = engine.commitAct.bind(engine);
  engine.commitAct = () => Promise.reject(new DOMException('the disk is full', 'QuotaExceededError'));
  const first = carryOver(disk);
  await first.carry.run(engine);
  engine.commitAct = commitAct;
  assert.equal(holding(engine, id).listed, false);
  assert.deepEqual(first.reported.map(({ operation, tags }) => [operation, tags.stage, tags.name]), [['roadmap-carry-write', 'carry', 'QuotaExceededError']]);
  assert.deepEqual((await oldStores()).sync, [id]);

  const stores = new OldStores();
  const forget = stores.forget.bind(stores);
  let killed = true;
  stores.forget = async (roadmap) => {
    if (killed) throw new DOMException('the tab closed', 'AbortError');
    return forget(roadmap);
  };
  const second = new CarryOver({ stores, locks: disk.locks, report: () => {}, track: () => {} });
  await second.run(engine);
  killed = false;
  assert.equal(holding(engine, id).steps.length, 3);
  assert.deepEqual((await oldStores()).sync, [id]);
  const commit = engine.commitAct.bind(engine);
  let wrote = 0;
  engine.commitAct = async (...args) => {
    const committed = await commit(...args);
    if (committed.outcome !== null) wrote += 1;
    return committed;
  };
  const third = carryOver(disk);
  await third.carry.run(engine);
  assert.equal(wrote, 0, 'nothing is written twice');
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(third.tracked.map(({ stage }) => stage), ['found', 'cleared']);
});

test('two tabs at once: one carries under the lock, the other finds nothing left, and nothing is carried twice', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const [one, two] = [await tab(t, disk, server), await tab(t, disk, server)];
  const [a, b] = [carryOver(disk), carryOver(disk)];
  await Promise.all([a.carry.run(one), b.carry.run(two)]);
  const creations = one.device.activeReplica.outbox.filter((entry) => entry.intent.d?.some((delta) => delta.t === 'tree' && delta.id === id)).length;
  assert.equal(creations, 1);
  assert.deepEqual([a.tracked.map(({ stage }) => stage), b.tracked.map(({ stage }) => stage)], [['found', 'carried', 'waiting'], []]);
  assert.equal(holding(one, id).steps.length, 3);
  assert.deepEqual((await oldStores()).sync, [id]);
});

test('a tab that never reloaded keeps writing the old store after the carry: the next load carries what it wrote since, and nothing it wrote before', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const old = new SyncSession({ treeId: id, title: 'Learn to sail' });
  await old.start();
  const engine = await tab(t, disk, server);
  await carryOver(disk).carry.run(engine);
  assert.equal((await runner(engine).runAct(new ChangeStep(id, 'wind', { label: 'Read the wind well' }))).kind, 'committed');
  old.dispatch({ kind: 'RenameNode', id: 'solo', label: 'Sail alone' });
  await old.persistNow();
  old.close();
  const { carry, tracked } = carryOver(disk);
  await carry.run(engine);
  assert.deepEqual(holding(engine, id).steps, [['dock', 'Leave the dock'], ['solo', 'Sail alone'], ['wind', 'Read the wind well']]);
  assert.deepEqual(tracked, [
    { name: 'roadmap_carry', stage: 'found', roadmaps: '1', changed: '0', workspaces: '1', marks: '0' },
    { name: 'roadmap_carry', stage: 'carried', roadmaps: '0', moved: '0', changes: '1', marks: '1', items: '0', kept: '0', conversations: '0' },
  ]);
  assert.deepEqual((await oldStores()).sync, [id]);
});

test('a second run changes nothing', async (t) => {
  const disk = browser(t);
  const server = new Server();
  await plantedSignedOut();
  const engine = await tab(t, disk, server);
  await carryOver(disk).carry.run(engine);
  const entries = engine.device.activeReplica.outbox.length;
  const rows = JSON.stringify(engine.device.activeReplica.deviceRows('roadmap'));
  const again = carryOver(disk);
  await again.carry.run(engine);
  assert.deepEqual({ entries: engine.device.activeReplica.outbox.length, rows: JSON.stringify(engine.device.activeReplica.deviceRows('roadmap')), tracked: again.tracked, reported: again.reported },
    { entries, rows, tracked: [], reported: [] });
});

test('a change to a roadmap deleted since cannot land: it is kept with its words for the one list, and its old store goes', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const { phone, tree, steps } = await plantedOnServer(t, server);
  await editedOffline(tree, steps);
  const deleted = await runner(phone).runAct(new DeleteRoadmap(tree));
  for (const segment of deleted.receipt.segments) for (const localId of segment.localIds) await phone.release(localId);
  await sent(phone);
  const engine = await tab(t, disk, server, 'A');
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  const ledger = runner(engine).read(RoadmapScopes.account, (read) => carryLedgerOf(read, tree));
  const words = ledger.kept.filter((each) => typeof each.values.label === 'string').map((each) => [each.reason, each.values.label]);
  assert.deepEqual(words.sort(), [['roadmapDeleted', 'Grip the oars lightly'], ['roadmapDeleted', 'Loosen the wrists'], ['roadmapDeleted', 'Row a mile']]);
  assert.equal(ledger.to, null);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
});

test('the ledger holds a person’s words, so a sign-out’s Keep keeps it with its replica and Discard takes it', async (t) => {
  for (const choice of ['keep', 'discard']) {
    const disk = browser(t);
    const server = new Server();
    const id = await plantedSignedOut('A');
    const engine = await tab(t, disk, server, 'A');
    await carryOver(disk).carry.run(engine);
    await sent(engine);
    const scan = async () => {
      const { device } = await engine.store.read();
      return device.replicas.map((replica) => [replica.meta.state, Object.keys(replica.device.roadmap ?? {}).filter(CarryLedger.isLedger)]);
    };
    assert.deepEqual(await scan(), [['anon', []], ['bound', [CarryLedger.key(id)]]]);
    await engine.finishSignOut({ choice });
    assert.deepEqual(await scan(), choice === 'keep' ? [['anon', []], ['dormant', [CarryLedger.key(id)]]] : [['anon', []]], choice);
  }
});

test('a roadmap made here while an account was signed in waits for that account, and is carried once it signs in', async (t) => {
  const disk = browser(t);
  const server = new Server();
  globalThis.window.wmDeviceConfirmation = { owner: 'A' };
  const id = await bearImportedTree({ title: 'Learn to knit', kinds: DEFAULT_KINDS, nodes: [{ id: 'cast', label: 'Cast on', color: 'olive', prerequisites: [] }] });
  const engine = await tab(t, disk, server);
  const { carry, tracked } = carryOver(disk, { session: { getSnapshot: () => ({ engine, ready: true }), subscribe: () => () => {} } });
  carry.start();
  t.after(() => carry.stop());
  await settled(carry, engine);
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync, tracked: tracked.map(({ stage }) => stage) },
    { listed: false, old: [id], tracked: ['found', 'waiting'] });
  engine.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await settled(carry, engine);
  assert.deepEqual({ steps: holding(engine, id).steps, old: await oldStores() }, { steps: [['cast', 'Cast on']], old: NOTHING_OLD });
});

test('with no connection a roadmap made signed out waits for the server’s answer, at once, its old stores whole, and is carried when the connection comes back', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  server.reachable = false;
  const engine = await tab(t, disk, server);
  engine.setOnline(false);
  const before = Date.now();
  const { carry, tracked, reported } = started(t, disk, engine);
  await settled(carry, engine);
  assert.ok(Date.now() - before < 5000, 'nothing waits on a server the engine cannot reach');
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync, stages: tracked.map(({ stage }) => stage), reported },
    { listed: false, old: [id], stages: ['found', 'waiting'], reported: [] });
  server.reachable = true;
  engine.setOnline(true);
  await until(engine, () => holding(engine, id).listed, 'the carry once the connection came back');
  await settled(carry, engine);
  assert.deepEqual({ held: holding(engine, id), stages: tracked.map(({ stage }) => stage), reported }, { held: SAILED, stages: ['found', 'waiting', 'found', 'carried'], reported: [] });
});

test('signed out, then signed in to an account that holds no roadmaps: what was carried into the anon replica reaches the server whole, and its old stores go once the server takes it', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  const { carry, tracked, reported } = started(t, disk, engine);
  await settled(carry, engine);
  const before = holding(engine, id);
  assert.deepEqual({ held: before, old: (await oldStores()).sync }, { held: SAILED, old: [id] });
  engine.transport.account = 'B';
  assert.equal((await engine.signIn('B')).complete, true);
  await settled(carry, engine);
  assert.deepEqual({ old: await oldStores(), stages: tracked.map(({ stage }) => stage), reported }, { old: NOTHING_OLD, stages: ['found', 'carried', 'waiting', 'found', 'cleared'], reported: [] });
  await sent(engine);
  const phone = await device(t, server, 'B');
  await until(phone, () => holding(phone, id).listed, 'the account’s list on another device');
  for (const scope of [RoadmapScopes.tree(id)]) await phone.subscribe(scope);
  await until(phone, () => JSON.stringify(holding(phone, id)) === JSON.stringify(before), 'the carried roadmap on another device');
});

test('a claim the server answered goes only to the account whose list holds it: never into the anon replica, nor another account’s', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id);
  await claimAnswered(id);
  const engine = await tab(t, disk, server);
  const { carry, tracked } = started(t, disk, engine);
  await settled(carry, engine);
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync, queued: queued(engine) }, { listed: false, old: [id], queued: 0 }, 'signed out');
  engine.transport.account = 'B';
  assert.equal((await engine.signIn('B')).complete, true);
  await settled(carry, engine);
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync }, { listed: false, old: [id] }, 'signed in as another account');
  await engine.finishSignOut({ choice: 'keep' });
  engine.transport.account = null;
  await settled(carry, engine);
  engine.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await settled(carry, engine);
  assert.deepEqual({ steps: holding(engine, id).steps, old: await oldStores() },
    { steps: [['dock', 'Leave the dock'], ['solo', 'Sail solo'], ['wind', 'Read the wind']], old: NOTHING_OLD }, 'signed in as the account that claimed it');
  assert.deepEqual(tracked.map(({ stage }) => stage), ['found', 'waiting', 'found', 'carried', 'cleared']);
});

test('a roadmap made signed out waits while an account is signed in, for the lineage rule to ask of it, and is carried into the anon replica once signed out, its old stores kept until the server takes it', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server, 'A');
  const { carry } = started(t, disk, engine);
  await settled(carry, engine);
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync }, { listed: false, old: [id] });
  await engine.finishSignOut({ choice: 'keep' });
  engine.transport.account = null;
  await settled(carry, engine);
  assert.deepEqual({ state: engine.getSnapshot().state, steps: holding(engine, id).steps.length, old: (await oldStores()).sync }, { state: 'anon', steps: 3, old: [id] });
});

for (const choice of ['keep', 'discard']) {
  test(`an account's roadmap left uncarried at its sign-out ${choice === 'keep' ? 'waits with its replica' : 'and not named by its Discard waits all the same'}, and is carried once the account signs in again`, async (t) => {
    const disk = browser(t);
    const server = new Server();
    const { tree, steps } = await plantedOnServer(t, server);
    await editedOffline(tree, steps);
    const engine = await tab(t, disk, server, 'A');
    engine.setOnline(false);
    const { carry, tracked } = started(t, disk, engine);
    await settled(carry, engine);
    assert.deepEqual({ old: (await oldStores()).sync, stages: tracked.map(({ stage }) => stage) }, { old: [tree], stages: ['found', 'waiting'] }, 'with no connection it waits');
    await engine.finishSignOut({ choice });
    engine.transport.account = null;
    await settled(carry, engine);
    assert.deepEqual({ old: (await oldStores()).sync, queued: queued(engine), stages: tracked.map(({ stage }) => stage) },
      { old: [tree], queued: 0, stages: ['found', 'waiting'] }, 'signed out, nothing of it reaches the anon replica');
    engine.setOnline(true);
    engine.transport.account = 'A';
    assert.equal((await engine.signIn('A')).complete, true);
    await settled(carry, engine);
    assert.deepEqual({ steps: holding(engine, tree).steps.map(([, label]) => label).sort(), old: await oldStores() },
      { steps: ['Grip the oars lightly', 'Pull a stroke', 'Row a mile'], old: NOTHING_OLD });
  });
}

// The notices of roadmap's the engine holds, by code.
function noticeCodes(engine) {
  const hold = engine.observeNotices('roadmap');
  const codes = hold.getSnapshot().notices.map((notice) => notice.code);
  hold.release();
  return codes;
}

// Until another device of `account` holds `tree` as `expected`.
async function onAnotherDevice(t, server, account, tree, expected) {
  const phone = await device(t, server, account);
  for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) await phone.subscribe(scope).catch(() => {});
  await until(phone, () => JSON.stringify(holding(phone, tree)) === JSON.stringify(expected), 'the carried roadmap on another device');
  return phone;
}

test('a claim whose create landed but whose answer never came back, carried signed out, keeps its old stores; at sign-in the server refuses its id as taken, and it is carried whole as changes to the account’s roadmap, once', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id, 'Learn to sail');
  const engine = await tab(t, disk, server);
  const { carry, reported } = started(t, disk, engine);
  await settled(carry, engine);
  assert.deepEqual({ held: holding(engine, id), old: (await oldStores()).sync }, { held: SAILED, old: [id] }, 'signed out, in the anon replica, its old stores kept');
  engine.transport.account = 'A';
  const due = (await engine.signIn('A')).due.find((question) => question.product === 'roadmap');
  assert.equal((await engine.signIn('A', { decisions: { roadmap: 'add' }, counted: { roadmap: due.counted } })).complete, true);
  await settled(carry, engine);
  await sent(engine);
  assert.deepEqual({ held: holding(engine, id), fresh: holding(engine, CarriedIds.roadmap(id)).listed, old: await oldStores(), notices: noticeCodes(engine), reported },
    { held: SAILED, fresh: false, old: NOTHING_OLD, notices: [], reported: [] });
  await onAnotherDevice(t, server, 'A', id, SAILED);
});

test('signed in, a claim whose create landed but whose answer never came back is carried as changes to the roadmap the account’s list holds', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id, 'Learn to sail');
  const engine = await tab(t, disk, server, 'A');
  await until(engine, () => holding(engine, id).listed, 'the account’s list');
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  await sent(engine);
  assert.deepEqual({ held: holding(engine, id), old: await oldStores(), reported, stages: tracked.map(({ stage }) => stage) },
    { held: SAILED, old: NOTHING_OLD, reported: [], stages: ['found', 'carried', 'cleared'] });
  await onAnotherDevice(t, server, 'A', id, SAILED);
});

// Signed out, Coach asked about `tree`: a turn it answered, with a pending proposal on its answer, and a turn about every
// roadmap still running.
async function askedAbout(engine, tree) {
  const opened = committedOf(await runner(engine).runAct(new OpenTurn({ about: { treeId: tree }, question: 'Where do I start?' }))).result;
  const coach = new Id(opened.coach, CoachMessage);
  committedOf(await runner(engine).runAct(new EndTurn(coach, { state: 'completed', text: 'Read the wind.' })));
  committedOf(await runner(engine).runAct(new MintProposal({ proposal: runner(engine).mint(CoachProposal), treeId: tree, thread: new Id(opened.thread, CoachThread), message: coach,
    changes: [{ op: 'rename', nodeId: 'wind', label: 'Read the wind well' }], base: [] })));
  committedOf(await runner(engine).runAct(new OpenTurn({ about: { treeId: null }, question: 'And after that?' })));
}

function committedOf(outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome;
}

// What a device draws of Coach: each conversation by what it is about, with who said what and the state Coach's turn
// stands in, and each proposal with its roadmap and state.
function coachOf(engine) {
  return runner(engine).read(RoadmapScopes.account, (read) => ({
    conversations: read.repository(CoachThread).all('drawn').map((thread) => ({ about: thread.treeId,
      said: Conversation.read(read, thread.id).messages.map((message) => [message.role, message.text, message.isCoach ? message.state : null, message.proposalId !== null]) }))
      .sort((a, b) => String(a.about).localeCompare(String(b.about))),
    proposals: read.repository(CoachProposal).all('drawn').map((proposal) => ({ about: proposal.treeId, state: proposal.state })),
  }));
}

// `askedAbout`'s records about `tree`, as each device of the account draws them.
const ASKED = (tree) => ({
  conversations: [
    { about: null, said: [['person', 'And after that?', null, false], ['coach', '', 'running', false]] },
    { about: tree, said: [['person', 'Where do I start?', null, false], ['coach', 'Read the wind.', 'completed', true]] },
  ],
  proposals: [{ about: tree, state: 'pending' }],
});

test('signed out, Coach asked about a roadmap the account already holds: a sign-in that sends one entry a push, refused as taken, keeps the conversation, its messages and the proposal on both browsers, and leaves no notice', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id, 'Learn to sail');
  const engine = await tab(t, disk, server, null, { PUSH_MAX_INTENTS: 1 });
  const { carry, reported, tracked } = started(t, disk, engine);
  await settled(carry, engine);
  await askedAbout(engine, id);
  assert.deepEqual(coachOf(engine), ASKED(id), 'signed out');
  engine.transport.account = 'A';
  const due = (await engine.signIn('A')).due.find((question) => question.product === 'roadmap');
  assert.equal((await engine.signIn('A', { decisions: { roadmap: 'add' }, counted: { roadmap: due.counted } })).complete, true);
  await settled(carry, engine);
  await sent(engine);
  assert.deepEqual({ held: holding(engine, id), coach: coachOf(engine), notices: noticeCodes(engine), old: await oldStores(), reported,
    carried: tracked.filter(({ stage }) => stage === 'carried').map(({ conversations }) => conversations) },
  { held: SAILED, coach: ASKED(id), notices: [], old: NOTHING_OLD, reported: [], carried: ['0', '1'] });
  const phone = await onAnotherDevice(t, server, 'A', id, SAILED);
  await until(phone, () => coachOf(phone).proposals.length === 1, 'the proposal on another device');
  assert.deepEqual(coachOf(phone), ASKED(id));
});

test('signed out, a step changed and Coach asked about a roadmap the account already holds: a sign-in whose push the change splits keeps the roadmap’s steps and the Coach records on both browsers, for the carry-over waits for the refusal to settle before it places the roadmap again', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  await servedAs(t, server, 'A', id, 'Learn to sail');
  const engine = await tab(t, disk, server);
  const { carry, reported } = started(t, disk, engine);
  await settled(carry, engine);
  committedOf(await runner(engine).runAct(new ChangeStep(id, 'dock', { label: 'Leave the dock at slack water' })));
  await askedAbout(engine, id);
  engine.transport.account = 'A';
  const due = (await engine.signIn('A')).due.find((question) => question.product === 'roadmap');
  assert.equal((await engine.signIn('A', { decisions: { roadmap: 'add' }, counted: { roadmap: due.counted } })).complete, true);
  await settled(carry, engine);
  await sent(engine);
  // The steps are read by id: keeping the change made signed out is node m3-a-refused-carry-keeps-the-edits-made-signed-out's.
  const byId = (held) => ({ ...held, steps: held.steps.map(([step]) => step) });
  const expected = { ...SAILED, steps: ['dock', 'solo', 'wind'] };
  assert.deepEqual({ held: byId(holding(engine, id)), coach: coachOf(engine), notices: noticeCodes(engine), old: await oldStores(), reported },
    { held: expected, coach: ASKED(id), notices: [], old: NOTHING_OLD, reported: [] });
  const phone = await device(t, server, 'A');
  for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) await phone.subscribe(scope).catch(() => {});
  await until(phone, () => JSON.stringify(byId(holding(phone, id))) === JSON.stringify(expected) && coachOf(phone).proposals.length === 1, 'the roadmap and the proposal on another device');
  assert.deepEqual(coachOf(phone), ASKED(id));
});

// A carry the account's change interrupts: `change` runs as the carry-over asks the server of `tree`, its first await.
function interrupted(engine, tree, change) {
  const subscribe = engine.subscribe.bind(engine);
  let fired = false;
  engine.subscribe = async (scope) => {
    const answer = await subscribe(scope);
    if (!fired && scope === RoadmapScopes.tree(tree)) {
      fired = true;
      await change();
    }
    return answer;
  };
}

// Every device row of roadmap's each replica holds, by its state.
async function rowsByReplica(engine) {
  const { device: stored } = await engine.store.read();
  return stored.replicas.map((replica) => [replica.meta.state, Object.keys(replica.device.roadmap ?? {})]);
}

for (const choice of ['keep', 'discard']) {
  test(`a sign-out with ${choice === 'keep' ? 'Keep' : 'Discard'} while a carry waits on a roadmap’s first pull writes nothing into the anon replica, keeps every old store, and the roadmap is carried at a load signed in as its account again`, async (t) => {
    const disk = browser(t);
    const server = new Server();
    const { tree, steps } = await plantedOnServer(t, server);
    await editedOffline(tree, steps);
    const engine = await tab(t, disk, server, 'A');
    interrupted(engine, tree, async () => {
      await engine.finishSignOut({ choice });
      engine.transport.account = null;
    });
    const { carry, reported, tracked } = started(t, disk, engine);
    await settled(carry, engine);
    assert.deepEqual({ rows: await rowsByReplica(engine), queued: queued(engine), old: (await oldStores()).sync, reported, stages: tracked.map(({ stage }) => stage) },
      { rows: choice === 'keep' ? [['anon', []], ['dormant', []]] : [['anon', []]], queued: 0, old: [tree], reported: [], stages: ['found', 'waiting'] });
    carry.stop();
    engine.close();
    const reloaded = await tab(t, disk, server, 'A');
    const next = carryOver(disk);
    await next.carry.run(reloaded);
    assert.deepEqual({ steps: holding(reloaded, tree).steps.map(([, label]) => label).sort(), old: await oldStores(), reported: next.reported },
      { steps: ['Grip the oars lightly', 'Pull a stroke', 'Row a mile'], old: NOTHING_OLD, reported: [] }, 'a load signed in as the account again carries it');
  });
}

test('signed out, another tab signs in to an account that holds roadmaps while a carry asks the server: nothing reaches that account, every old store stays, and the account’s own run leaves the roadmap waiting for the anon replica', async (t) => {
  const disk = browser(t);
  const server = new Server();
  await plantedOnServer(t, server);
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  interrupted(engine, id, async () => {
    engine.transport.account = 'A';
    assert.equal((await engine.signIn('A')).complete, true);
  });
  const { carry, reported, tracked } = started(t, disk, engine);
  await settled(carry, engine);
  assert.deepEqual({ state: engine.getSnapshot().state, queued: queued(engine), listed: holding(engine, id).listed, old: (await oldStores()).sync, reported,
    stages: tracked.map(({ stage }) => stage), holders: [...engine.openings.keys()] },
  { state: 'bound', queued: 0, listed: false, old: [id], reported: [], stages: ['found', 'waiting'], holders: [] });
});

test('signed out, a sign-in that adds the anon replica to an account, keeping the replica, while a carry asks the server: nothing the carry decided reaches the account', async (t) => {
  const disk = browser(t);
  const server = new Server();
  await plantedOnServer(t, server);
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  assert.equal((await runner(engine).runAct(new CreateRoadmap('Learn to swim'))).kind, 'committed');
  const anon = engine.device.activeReplica.id;
  interrupted(engine, id, async () => {
    engine.transport.account = 'A';
    const due = (await engine.signIn('A')).due.find((question) => question.product === 'roadmap');
    assert.equal((await engine.signIn('A', { decisions: { roadmap: 'add' }, counted: { roadmap: due.counted } })).complete, true);
  });
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  assert.deepEqual({ same: engine.device.activeReplica.id === anon, account: engine.device.activeReplica.meta.account, listed: holding(engine, id).listed,
    ledger: Object.keys(engine.device.activeReplica.deviceRows('roadmap')).filter(CarryLedger.isLedger), old: (await oldStores()).sync, reported },
  { same: true, account: 'A', listed: false, ledger: [], old: [id], reported: [] });
});

test('a roadmap with many steps and many workspace items past their bound is carried in one act, each item set aside before it is tried', async (t) => {
  const disk = browser(t);
  const server = new Server();
  globalThis.window.wmDeviceConfirmation = { owner: null };
  const nodes = Array.from({ length: 300 }, (_, index) => ({ id: `s${index}`, label: `Step ${index}`, color: 'olive', prerequisites: index ? [`s${index - 1}`] : [] }));
  const id = await bearImportedTree({ title: 'Big', kinds: DEFAULT_KINDS, nodes });
  let workspace = emptyWorkspace();
  for (let index = 0; index < 200; index += 1) workspace = addSubtask(workspace, `${'x'.repeat(250)}${index}`);
  new WorkspaceStore().save(id, { s0: addSubtask(workspace, 'Count the steps') });
  const engine = await tab(t, disk, server);
  const commitAct = engine.commitAct.bind(engine);
  let commits = 0;
  engine.commitAct = (...args) => { commits += 1; return commitAct(...args); };
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  const ledger = runner(engine).read(RoadmapScopes.account, (read) => carryLedgerOf(read, id));
  assert.deepEqual({ commits, steps: holding(engine, id).steps.length, subtasks: holding(engine, id).workspace.s0?.subtasks, kept: ledger.kept.length,
    reasons: [...new Set(ledger.kept.map((each) => each.reason))], reported },
  { commits: 1, steps: 300, subtasks: [['Count the steps', false]], kept: 200, reasons: ['pastBound'], reported: [] });
});

test('one index row that does not read leaves every other roadmap carried, and is reported once on this browser, not on every load', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const rows = JSON.parse(globalThis.window.localStorage.getItem('windmill:device-trees'));
  rows.t_00000000000000ff = { title: 7, owner: null, claimed: false };
  globalThis.window.localStorage.setItem('windmill:device-trees', JSON.stringify(rows));
  const engine = await tab(t, disk, server);
  const loads = [];
  for (let load = 0; load < 2; load += 1) {
    const { carry, reported } = carryOver(disk);
    await carry.run(engine);
    loads.push(reported.map(({ operation, tags }) => [operation, tags.store, tags.name]));
  }
  assert.deepEqual({ held: holding(engine, id), loads, rows: Object.keys(JSON.parse(globalThis.window.localStorage.getItem('windmill:device-trees'))).sort() },
    { held: SAILED, loads: [[['roadmap-carry-read', 'index', 'other']], []], rows: [id, 't_00000000000000ff'].sort() });
});

test('an index row whose record the old bundle has not written yet waits a load; one still with no record a load later is forgotten as empty', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const store = new SyncStore();
  const record = await store.load(id);
  await store.clear(id, { durable: true });
  globalThis.window.wmDeviceConfirmation = { owner: null };
  new LocalTreeRegistry().record('t_00000000000000b2', 'Never written');
  const engine = await tab(t, disk, server);
  const first = carryOver(disk);
  await first.carry.run(engine);
  assert.deepEqual({ listed: holding(engine, id).listed, index: (await oldStores()).index, stages: first.tracked.map(({ stage }) => stage) },
    { listed: false, index: [id, 't_00000000000000b2'].sort(), stages: ['found', 'waiting'] }, 'the first load forgets neither');
  assert.equal((await store.save(id, record)).status, 'saved');
  const second = carryOver(disk);
  await second.carry.run(engine);
  assert.deepEqual({ held: holding(engine, id), index: (await oldStores()).index, stages: second.tracked.map(({ stage }) => stage) },
    { held: SAILED, index: [id], stages: ['found', 'carried', 'waiting', 'cleared'] });
});

test('an entry that does not read is reported once on this browser, and a load that leaves waiting what the last one left says nothing', async (t) => {
  const disk = browser(t);
  const server = new Server();
  globalThis.window.localStorage.setItem('windmill:workspace:t_00000000000000bb', '{not json');
  const { tree, steps } = await plantedOnServer(t, server);
  await editedOffline(tree, steps);
  const engine = await tab(t, disk, server, 'A');
  engine.setOnline(false);
  const loads = [];
  for (let load = 0; load < 3; load += 1) {
    const { carry, reported, tracked } = carryOver(disk);
    await carry.run(engine);
    loads.push({ reported: reported.map(({ operation, tags }) => [operation, tags.store]), stages: tracked.map(({ stage }) => stage) });
  }
  assert.deepEqual(loads, [
    { reported: [['roadmap-carry-read', 'workspace']], stages: ['found', 'waiting'] },
    { reported: [], stages: [] },
    { reported: [], stages: [] },
  ]);
});

test('the demo’s own workspace is no old store: the carry-over reads past it', async (t) => {
  const disk = browser(t);
  const server = new Server();
  globalThis.window.localStorage.setItem('windmill:workspace:t_9e407a96b5330ebe', JSON.stringify({ n1: { subtasks: [{ id: 's1', label: 'A demo subtask', done: false }], links: [], note: '' } }));
  const engine = await tab(t, disk, server);
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  assert.deepEqual({ reported, tracked, workspaces: (await oldStores()).workspaces }, { reported: [], tracked: [], workspaces: ['t_9e407a96b5330ebe'] });
});

test('a run that fails, and a question to the server that fails, are reported as reads: of the replica, and of the server', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  engine.subscribe = async () => { throw new TypeError('the transport broke'); };
  const asking = carryOver(disk);
  await asking.carry.run(engine);
  const stores = new OldStores();
  stores.read = async () => { throw new TypeError('the store broke'); };
  const { carry, reported } = started(t, disk, engine, { stores });
  await settled(carry, engine);
  assert.deepEqual({ asked: asking.reported, ran: reported, old: (await oldStores()).sync },
    { asked: [{ operation: 'roadmap-carry-read', tags: { store: 'server', name: 'other' } }], ran: [{ operation: 'roadmap-carry-read', tags: { store: 'replica', name: 'other' } }], old: [id] });
});
