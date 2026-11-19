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

// A tab of the new bundle on `disk`: its engine live over `server`, signed in as `account` or signed out.
async function tab(t, disk, server, account = null) {
  const transport = {
    account,
    request: async (endpoint, request) => server.answer(endpoint, request, transport.account, () => engine.reading()),
    openLive: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  };
  const engine = await BrowserSyncEngine.open({ indexedDB: disk.engines, keyRange: IDBKeyRange, registry: roadmapRegistry, transport, timers: globalThis,
    now: Date.now, monotonic: () => Math.floor(performance.now()), navigator: { onLine: true, locks: disk.locks, storage: { persist: async () => true } },
    document: null, window: null, leadership: { locks: disk.locks, channel: disk.channels.open },
    telemetry: { event() {}, failure() {} } });
  t.after(() => engine.close());
  if (account) assert.equal((await engine.signIn(account)).complete, true);
  await engine.start();
  return engine;
}

// The carry-over of one tab, its reports and events kept.
function carryOver(disk, { timers = globalThis, session = null } = {}) {
  const reported = [];
  const tracked = [];
  const carry = new CarryOver({ session, stores: new OldStores(), locks: disk.locks, timers,
    report: (operation, error, tags) => reported.push({ operation, tags }), track: (name, props) => tracked.push({ name, ...props }) });
  return { carry, reported, tracked };
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
// its room; it keeps a workspace on two steps, and a mark left undrained from before roadmap's present sync.
async function plantedSignedOut() {
  globalThis.window.wmDeviceConfirmation = { owner: null };
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

test('a roadmap made signed out is carried into the anon replica under its id, with its marks, its workspace and the mark left undrained, and its old stores go', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  const held = holding(engine, id);
  assert.deepEqual({ ...held, workspace: { ...held.workspace, solo: undefined } }, {
    listed: true, title: 'Learn to sail',
    steps: [['dock', 'Leave the dock'], ['solo', 'Sail solo'], ['wind', 'Read the wind']],
    links: [['dock', 'solo'], ['wind', 'dock']],
    kinds: ['build', 'learn', 'milestone'],
    marks: ['dock', 'wind'],
    pointers: [],
    workspace: { wind: { subtasks: [['Check the forecast', true], ['Watch the flags', false]], links: [['https://www.example.org/wind', 'example.org']], note: 'Gusts come in from the left.' }, solo: undefined },
  });
  const ledger = runner(engine).read(RoadmapScopes.account, (read) => carryLedgerOf(read, id));
  assert.equal(ledger.to, id);
  assert.deepEqual(ledger.kept.map((each) => [each.reason, each.subject.t, each.values.label]), [['pastBound', 'subtask', 'x'.repeat(300)]]);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
  assert.deepEqual(tracked, [
    { name: 'roadmap_carry', stage: 'found', roadmaps: '1', changed: '0', workspaces: '1', marks: '1' },
    { name: 'roadmap_carry', stage: 'carried', roadmaps: '1', moved: '0', changes: '0', marks: '2-5', items: '2-5', kept: '1' },
    { name: 'roadmap_carry', stage: 'cleared', stores: '2-5' },
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
  const phone = await device(t, server, 'A');
  const claimed = new CarriedRoadmap(id, { title: 'Learn to sail', guide: '', kinds: DEFAULT_KINDS, steps: [], links: [] }, roadmapRegistry, runner(phone).moment());
  assert.equal((await runner(phone).runAct(new CarryRoadmap(id, claimed))).kind, 'committed');
  await sent(phone);
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

// A roadmap the server keeps under `id` for `account`, planted on that account's other device.
async function servedAs(t, server, account, id) {
  const phone = await device(t, server, account);
  const served = new CarriedRoadmap(id, { title: 'Someone’s', guide: '', kinds: DEFAULT_KINDS, steps: [], links: [] }, roadmapRegistry, runner(phone).moment());
  assert.equal((await runner(phone).runAct(new CarryRoadmap(id, served))).kind, 'committed');
  await sent(phone);
  return phone;
}

test('a roadmap made signed out whose id the person deleted on the server is created under a fresh id, and the device’s pointers at it move with it', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const sail = await plantedSignedOut();
  const row = await pointingAt(sail);
  const phone = await servedAs(t, server, 'A', sail);
  const deleted = await runner(phone).runAct(new DeleteRoadmap(sail));
  for (const segment of deleted.receipt.segments) for (const localId of segment.localIds) await phone.release(localId);
  await sent(phone);
  const engine = await tab(t, disk, server, 'A');
  const { carry, reported, tracked } = carryOver(disk);
  await carry.run(engine);
  const fresh = CarriedIds.roadmap(sail);
  assert.deepEqual({ sail: holding(engine, fresh).steps.length, kept: holding(engine, sail).listed, row: holding(engine, row).steps, pointers: holding(engine, row).pointers },
    { sail: 3, kept: false, row: [['sea', 'Row out to sea']], pointers: [['sea', fresh]] });
  assert.equal(tracked.find(({ stage }) => stage === 'carried').moved, '1');
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
});

test('signed out, a roadmap made here whose id the server serves for another account is created under a fresh id', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const sail = await plantedSignedOut();
  const phone = await servedAs(t, server, 'B', sail);
  assert.equal((await runner(phone).runAct(new SetVisibility(sail, 'public'))).kind, 'committed');
  await sent(phone);
  const engine = await tab(t, disk, server);
  const { carry, reported } = carryOver(disk);
  await carry.run(engine);
  const fresh = CarriedIds.roadmap(sail);
  assert.deepEqual({ fresh: holding(engine, fresh).steps.length, theirs: holding(engine, sail).listed }, { fresh: 3, theirs: false });
  assert.deepEqual(await oldStores(), NOTHING_OLD);
  assert.deepEqual(reported, []);
});

test('a carry cut short writes nothing or everything: a commit the store refuses keeps every old entry for the next load, and one that landed is not written twice', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
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
  const entries = engine.device.activeReplica.outbox.length;
  const third = carryOver(disk);
  await third.carry.run(engine);
  assert.equal(engine.device.activeReplica.outbox.length, entries, 'nothing is written twice');
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
  assert.deepEqual([a.tracked.map(({ stage }) => stage), b.tracked.map(({ stage }) => stage)], [['found', 'carried', 'cleared'], []]);
  assert.equal(holding(one, id).steps.length, 3);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
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
    { name: 'roadmap_carry', stage: 'found', roadmaps: '0', changed: '1', workspaces: '0', marks: '0' },
    { name: 'roadmap_carry', stage: 'carried', roadmaps: '0', moved: '0', changes: '1', marks: '1', items: '0', kept: '0' },
    { name: 'roadmap_carry', stage: 'cleared', stores: '2-5' },
  ]);
  assert.deepEqual(await oldStores(), NOTHING_OLD);
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
    const id = await plantedSignedOut();
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
  await carry.running;
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync, tracked: tracked.map(({ stage }) => stage) },
    { listed: false, old: [id], tracked: ['found', 'waiting'] });
  engine.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await carry.running;
  assert.deepEqual({ steps: holding(engine, id).steps, old: await oldStores() }, { steps: [['cast', 'Cast on']], old: NOTHING_OLD });
});

test('with no connection a roadmap made signed out waits for the server’s answer, at once, and its old stores stay whole', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  server.reachable = false;
  const engine = await tab(t, disk, server);
  engine.setOnline(false);
  const { carry, tracked, reported } = carryOver(disk);
  const started = Date.now();
  await carry.run(engine);
  assert.ok(Date.now() - started < 5000, 'nothing waits on a server the engine cannot reach');
  assert.deepEqual({ listed: holding(engine, id).listed, old: (await oldStores()).sync, stages: tracked.map(({ stage }) => stage), reported },
    { listed: false, old: [id], stages: ['found', 'waiting'], reported: [] });
  server.reachable = true;
  engine.setOnline(true);
  await carryOver(disk).carry.run(engine);
  assert.deepEqual({ listed: holding(engine, id).listed, old: await oldStores() }, { listed: true, old: NOTHING_OLD });
});

test('signed out, then signed in to an account that holds no roadmaps: what was carried into the anon replica reaches the server whole', async (t) => {
  const disk = browser(t);
  const server = new Server();
  const id = await plantedSignedOut();
  const engine = await tab(t, disk, server);
  await carryOver(disk).carry.run(engine);
  const before = holding(engine, id);
  engine.transport.account = 'B';
  assert.equal((await engine.signIn('B')).complete, true);
  await sent(engine);
  const phone = await device(t, server, 'B');
  await until(phone, () => holding(phone, id).listed, 'the account’s list on another device');
  for (const scope of [RoadmapScopes.tree(id)]) await phone.subscribe(scope);
  await until(phone, () => JSON.stringify(holding(phone, id)) === JSON.stringify(before), 'the carried roadmap on another device');
});
