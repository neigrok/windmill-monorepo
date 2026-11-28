// Roadmap's part as the account changes on the device's copy (flow 50, Roadmap Coach 10.4): the words of the sign-in
// question, naming the roadmaps of the person's list the signed-out work changes, or counting them with its Coach
// conversations; the words of the sign-out question, where every unsent change is roadmap's; the work it lets the engine
// add without asking; what reaches the account, and a second browser, with each answer; and the sweep of the landing notes
// and told notices at sign-out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { CoachMessage, CoachProposal, CoachThread, Conversation, EndTurn, MintProposal, OpenTurn, WithdrawTurn } from '../../../../src/products/roadmap/domain/conversation.js';
import { CreateRoadmap, CreateSubtree, DeleteRoadmap, WriteRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { ChangeStep } from '../../../../src/products/roadmap/domain/steps.js';
import { MarkStep } from '../../../../src/products/roadmap/domain/progress.js';
import { environment } from '../../../platform/sync/fakes.js';
import { browserWith } from '../../gym/harness.mjs';

const note = { nodes: ['n2'], edges: [['n1', 'n2']], revived: [], names: [{ id: 'n1', name: 'Read the wind' }] };

// A device on the composed registry whose server answers a hello as A, saying whether A holds roadmaps, and takes nothing.
// Ids are drawn at random, as a browser draws them, so a second roadmap does not draw the first one's id forever.
async function device(t, { holdsRoadmaps }) {
  browserWith();
  const env = environment();
  const at = { wall: env.timers.time, mono: env.timers.time, boot: 'test' };
  env.transport.response = async (endpoint) => {
    if (endpoint !== 'hello') throw new Error('offline');
    const answer = hello({ state: env.state, registry, account: 'A', serverTime: env.timers.time });
    answer.body.holdsRecords.roadmap = holdsRoadmaps;
    return { response: answer, timing: { send: at, recv: at } };
  };
  const engine = await BrowserSyncEngine.open({ ...env.options, registry, draw: (bound) => randomInt(bound) });
  t.after(() => engine.close());
  const runner = new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0));
  const plant = async (title, steps = []) => {
    const outcome = await runner.runAct(new CreateRoadmap(title, { steps: steps.map((label) => ({ key: label, label })), links: [] }));
    assert.equal(outcome.kind, 'committed');
    return { tree: String(outcome.result.tree), steps: outcome.result.steps };
  };
  return { engine, runner, plant };
}

const roadmapDue = (result) => result.due.find((question) => question.product === 'roadmap');

test('signed out, the browser’s roadmaps meet an account that holds roadmaps: the question names each standing one, in the order they were made, and a subtree’s work is its root’s', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, runner, plant } = await device(t, { holdsRoadmaps: true });
  const sail = await plant('Learn to sail', ['Read the wind']);
  await plant('  ');
  const gone = await plant('Learn to row');
  assert.equal((await runner.runAct(new DeleteRoadmap(gone.tree))).kind, 'committed');
  assert.equal((await runner.runAct(new CreateSubtree(sail.tree, sail.steps['Read the wind']))).kind, 'committed');
  const result = await engine.signIn('A');
  const due = roadmapDue(result);
  const told = [];
  const words = await accountChange.signInWords(engine, due, (name, props) => told.push([name, props]));
  words.onStep('shown');
  words.onStep('add');
  words.onStep('unknown');
  assert.deepEqual({ complete: result.complete, adoption: accountChange.adoptionAnswer(engine, due), words: { ...words, onStep: typeof words.onStep }, told }, {
    complete: false,
    adoption: null,
    words: {
      title: 'Add your roadmaps?',
      lead: '2 roadmaps on this browser can join your account.',
      items: ['Learn to sail', 'Untitled roadmap'],
      note: 'Choosing Discard removes these browser roadmaps.',
      onStep: 'function',
    },
    told: [['roadmap_signin', { step: 'shown', roadmaps: '2-5', conversations: '0' }], ['roadmap_signin', { step: 'add', roadmaps: '2-5', conversations: '0' }]],
  });
});

test('one roadmap is asked of in the singular, and work that changes no roadmap the list holds is added without asking', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const one = await device(t, { holdsRoadmaps: true });
  await one.plant('Learn to sail');
  const asked = roadmapDue(await one.engine.signIn('A'));
  const words = await accountChange.signInWords(one.engine, asked, () => {});

  const none = await device(t, { holdsRoadmaps: true });
  const gone = await none.plant('Learn to row');
  assert.equal((await none.runner.runAct(new DeleteRoadmap(gone.tree))).kind, 'committed');
  const unseen = roadmapDue(await none.engine.signIn('A'));
  assert.deepEqual({ lead: words.lead, items: words.items, note: words.note, asked: accountChange.adoptionAnswer(one.engine, asked),
    unseen: accountChange.adoptionAnswer(none.engine, unseen) }, {
    lead: '1 roadmap on this browser can join your account.', items: ['Learn to sail'], note: 'Choosing Discard removes this browser roadmap.',
    asked: null, unseen: 'add',
  });
});

// Signed out, a turn about `tree` (null for every roadmap) that Coach answered: the conversation and Coach's answer.
async function answered(runner, tree, question = 'Where do I start?') {
  const opened = await runner.runAct(new OpenTurn({ about: { treeId: tree }, question }));
  assert.equal(opened.kind, 'committed');
  const coach = new Id(opened.result.coach, CoachMessage);
  assert.equal((await runner.runAct(new EndTurn(coach, { state: 'completed', text: 'Read the wind.' }))).kind, 'committed');
  return { thread: new Id(opened.result.thread, CoachThread), coach };
}

test('signed out, Coach’s conversations beside the browser’s roadmaps: the question counts both in one sentence (10.4), one made and withdrawn is not counted, and each step is told with both counts', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, runner, plant } = await device(t, { holdsRoadmaps: true });
  const sail = await plant('Learn to sail', ['Read the wind']);
  await plant('Learn to row');
  await answered(runner, sail.tree);
  await answered(runner, null, 'What should I learn next?');
  const withdrawn = await runner.runAct(new OpenTurn({ about: { treeId: sail.tree }, question: 'Never asked' }));
  const { thread, person, coach } = withdrawn.result;
  const turn = { thread: new Id(thread, CoachThread), person: new Id(person, CoachMessage), coach: new Id(coach, CoachMessage) };
  assert.equal((await runner.runAct(new WithdrawTurn(turn))).kind, 'committed');
  const due = roadmapDue(await engine.signIn('A'));
  const told = [];
  const words = await accountChange.signInWords(engine, due, (name, props) => told.push([name, props]));
  words.onStep('shown');
  words.onStep('discard');
  assert.deepEqual({ adoption: accountChange.adoptionAnswer(engine, due), words: { ...words, onStep: typeof words.onStep }, told }, {
    adoption: null,
    words: {
      title: 'Add to your account?',
      lead: 'This browser has 2 roadmaps and 2 conversations from before you signed in. Your account already has roadmaps. Add them, or discard them from this browser.',
      items: [],
      note: null,
      discard: { title: 'Discard 2 roadmaps and 2 conversations?', body: 'They are deleted from this browser. You can’t undo this.' },
      onStep: 'function',
    },
    told: [['roadmap_signin', { step: 'shown', roadmaps: '2-5', conversations: '2-5' }], ['roadmap_signin', { step: 'discard', roadmaps: '2-5', conversations: '2-5' }]],
  });
});

test('signed out, work that holds conversations and no roadmap of the browser’s own is added without asking (roadmap-on-the-engine §5)', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, runner } = await device(t, { holdsRoadmaps: true });
  await answered(runner, null, 'What should I learn?');
  const due = roadmapDue(await engine.signIn('A'));
  assert.deepEqual({ count: due.count, adoption: accountChange.adoptionAnswer(engine, due) }, { count: { coachMessage: 2, coachThread: 1 }, adoption: 'add' });
});

test('an account that holds no roadmaps takes the browser’s without a question', async (t) => {
  const { engine, plant } = await device(t, { holdsRoadmaps: false });
  await plant('Learn to sail');
  const result = await engine.signIn('A');
  assert.deepEqual({ complete: result.complete, due: result.due, state: engine.device.activeReplica.meta.state,
    lineage: [...new Set(engine.device.activeReplica.entries().map((entry) => entry.lineage))] },
  { complete: true, due: [], state: 'bound', lineage: ['A'] });
});

test('at sign-out the question counts the person’s unsent changes of roadmap’s, one an act, and names each roadmap they change with how many', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, runner, plant } = await device(t, { holdsRoadmaps: false });
  assert.equal((await engine.signIn('A')).complete, true);
  const sail = await plant('Learn to sail', ['Read the wind']);
  const row = await plant('Learn to row');
  assert.equal((await runner.runAct(new ChangeStep(sail.tree, sail.steps['Read the wind'], { description: 'Watch the water' }))).kind, 'committed');
  assert.equal((await runner.runAct(new WriteRoadmap(row.tree, { guide: 'Start slow' }))).kind, 'committed');
  engine.online = false;
  const question = await engine.beginSignOut();
  const told = [];
  const words = await accountChange.signOutWords(engine, question, (name, props) => told.push([name, props]));
  words.onStep('shown');
  words.onStep('keep');
  words.onStep('add');
  assert.deepEqual({ unsent: question.unsent, words: { ...words, onStep: typeof words.onStep }, told }, {
    unsent: 6,
    words: {
      title: 'Keep unsent changes?',
      lead: '4 changes haven’t reached your account.',
      items: ['Learn to sail · 2 changes', 'Learn to row · 2 changes'],
      note: 'Keep them for your next sign-in. Discard removes them from this browser.',
      onStep: 'function',
    },
    told: [['roadmap_signout', { step: 'shown', changes: '2-5' }], ['roadmap_signout', { step: 'keep', changes: '2-5' }]],
  });
});

test('a new roadmap is one change, its record and its first words one act, and so is a gesture composed over a roadmap’s steps and its marks', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, runner, plant } = await device(t, { holdsRoadmaps: false });
  assert.equal((await engine.signIn('A')).complete, true);
  const sail = await plant('Learn to sail', ['Read the wind']);
  const step = sail.steps['Read the wind'];
  engine.online = false;
  const made = await engine.beginSignOut();
  const madeWords = await accountChange.signOutWords(engine, made);
  await engine.cancelSignOut();
  const composed = await runner.runComposed([new ChangeStep(sail.tree, step, { description: 'Watch the water' }), new MarkStep(sail.tree, step, 'complete')]);
  const scopes = new Set(engine.device.activeReplica.entries().slice(2).map((entry) => entry.scope));
  const both = await engine.beginSignOut();
  const bothWords = await accountChange.signOutWords(engine, both);
  assert.deepEqual({ made: [made.unsent, madeWords.lead, madeWords.items], composed: composed.kind, scopes: scopes.size,
    both: [both.unsent, bothWords.lead, bothWords.items] }, {
    made: [2, '1 change hasn’t reached your account.', ['Learn to sail · 1 change']],
    composed: 'committed',
    scopes: 2,
    both: [4, '2 changes haven’t reached your account.', ['Learn to sail · 2 changes']],
  });
});

test('a sign-out question that counts nothing, or another product’s change, keeps the shell’s words', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const { engine, plant } = await device(t, { holdsRoadmaps: false });
  assert.equal((await engine.signIn('A')).complete, true);
  engine.online = false;
  const clean = await engine.beginSignOut();
  const cleanWords = await accountChange.signOutWords(engine, clean);
  await engine.cancelSignOut();
  await plant('Learn to sail');
  const roadmapOnly = await engine.beginSignOut();
  const foreign = { ...roadmapOnly, unsent: roadmapOnly.unsent + 1, pending: 1, counted: [...roadmapOnly.counted, 'device:journal:claim:digest'] };
  assert.deepEqual({ clean: cleanWords, foreign: await accountChange.signOutWords(engine, foreign), mine: (await accountChange.signOutWords(engine, roadmapOnly))?.title },
    { clean: null, foreign: null, mine: 'Keep unsent changes?' });
});

for (const choice of ['keep', 'discard']) {
  test(`signing out with ${choice === 'keep' ? 'Keep' : 'Discard'} leaves no landing note and no told notice on the device`, async (t) => {
    const { forgetReplicaRoom } = await import('../../../../src/products/roadmap/sync/accountChange.js');
    const { engine } = await device(t, { holdsRoadmaps: false });
    await engine.signIn('A');
    await engine.write(null, (device) => { device.activeReplica.deviceRows('roadmap')['landing:t_0000000000000001'] = note; });
    globalThis.window.localStorage.setItem('windmill:roadmap:kept-told', JSON.stringify(['notice:g1/0']));
    await engine.finishSignOut({ choice });
    await engine.write(null, (device) => { device.activeReplica.deviceRows('roadmap')['landing:t_0000000000000002'] = note; });
    const rowsOf = async () => (await engine.store.read()).device.replicas.map((replica) => [replica.meta.state, replica.device.roadmap ?? {}]);
    const before = await rowsOf();
    await forgetReplicaRoom({ engine });
    assert.deepEqual({ before, after: await rowsOf(), told: globalThis.window.localStorage.getItem('windmill:roadmap:kept-told') }, {
      before: choice === 'keep'
        ? [['anon', { 'landing:t_0000000000000002': note }], ['dormant', { 'landing:t_0000000000000001': note }]]
        : [['anon', { 'landing:t_0000000000000002': note }]],
      after: choice === 'keep' ? [['anon', {}], ['dormant', {}]] : [['anon', {}]],
      told: null,
    });
  });
}

// The old bundle's stores and the account sweep, on a browser that ran the old bundle: its localStorage lists its keys and
// its IndexedDB holds the old sync database, as a browser's do. Each account's other devices reach one model server.

const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb');
const { ServerState } = await import('../../../../../packages/api-contract/sync/reference/server/state.js');
const { pull, push } = await import('../../../../../packages/api-contract/sync/reference/server/pull.js').then(async (pulling) => ({ ...pulling, ...await import('../../../../../packages/api-contract/sync/reference/server/push.js') }));
const { RoadmapProduct } = await import('../../../../../packages/api-contract/sync/reference/roadmap/product.js');
const { FakeChannels, FakeLocks } = await import('../../../platform/sync/fakes.js');
const { roadmapRegistry } = await import('../domain/vectors.js');
const { RoadmapScopes } = await import('../../../../src/products/roadmap/domain/roadmapRules.js');
const { Roadmap, RoadmapMeta, SetVisibility } = await import('../../../../src/products/roadmap/domain/roadmaps.js');
const { CarryOver } = await import('../../../../src/products/roadmap/carry/CarryOver.js');
const { Complete } = await import('../../../../src/products/roadmap/domain/progress.js');
const { DEFAULT_KINDS } = await import('../../../../src/products/roadmap/model/Legend.js');
const { addSubtask, emptyWorkspace } = await import('../../../../src/products/roadmap/model/NodeWorkspace.js');
const { LocalTreeRegistry } = await import('../../../../src/products/roadmap/persistence/LocalTreeRegistry.js');
const { WorkspaceStore } = await import('../../../../src/products/roadmap/persistence/WorkspaceStore.js');
const { bearImportedTree } = await import('../../../../src/products/roadmap/sync/localTrees.js');
const { SyncSession } = await import('../../../../src/products/roadmap/sync/SyncSession.js');
const { SyncStore } = await import('../../../../src/products/roadmap/sync/SyncStore.js');

class Server {
  constructor() {
    this.state = ServerState.empty({ epoch: 'ep-account', accounts: { A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' } } });
    this.product = new RoadmapProduct();
  }

  answer(endpoint, request, account, reading) {
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

class NoSocket {
  constructor() { this.readyState = 0; }
  addEventListener() {}
  send() {}
  close() { this.readyState = 3; }
}

// A browser's localStorage, which lists its keys as a browser's does.
function keyedStorage() {
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => (Object.hasOwn(storage, key) ? storage[key] : null) },
    setItem: { value: (key, value) => { storage[key] = String(value); } },
    removeItem: { value: (key) => { delete storage[key]; } },
    key: { value: (index) => Object.keys(storage)[index] ?? null },
    length: { get: () => Object.keys(storage).length },
  });
  return storage;
}

// One browser that ran the old bundle, its storage the new bundle's engine shares.
function oldBrowser(t) {
  const storage = keyedStorage();
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

// A tab of the new bundle on `disk`, live over `server`, signed in as `account` or signed out.
async function tab(t, disk, server, account = null) {
  const transport = {
    account,
    request: async (endpoint, request) => server.answer(endpoint, request, transport.account, () => engine.reading()),
    openLive: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
  };
  const engine = await BrowserSyncEngine.open({ indexedDB: disk.engines, keyRange: IDBKeyRange, registry: roadmapRegistry, transport, timers: globalThis,
    now: Date.now, monotonic: () => Math.floor(performance.now()), navigator: { onLine: true, locks: disk.locks, storage: { persist: async () => true } },
    document: null, window: null, leadership: { locks: disk.locks, channel: disk.channels.open }, telemetry: { event() {}, failure() {} } });
  t.after(() => engine.close());
  if (account) assert.equal((await engine.signIn(account)).complete, true);
  await engine.start();
  return engine;
}

const runnerOf = (engine) => new ActionRunner(new EngineReplica(engine), roadmapRegistry, new FixedZone(0));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const titleOf = (engine, tree) => runnerOf(engine).read(RoadmapScopes.tree(tree), (read) => read.repository(RoadmapMeta).all('drawn')[0]?.title ?? null);

// The old bundle's room on a roadmap of `owner`'s the server keeps, its graft as the old server sent it, then changes
// made offline and never sent: a rename, a new step, a deleted step, a mark and a subtask (6 changes as the room counts).
async function editedOffline(tree, title, owner) {
  globalThis.window.wmDeviceConfirmation = { owner };
  const at = '1700000000000:0:server';
  const room = new SyncSession({ treeId: tree, title });
  await room.start();
  room.receiveState({ t: 'subgraph', intent: 'graft', seq: 4, reach: 'writer', title: { v: title, at },
    nodes: ['grip', 'stroke', 'turn'].map((id, index) => ({ id, createdAt: at, label: id, labelAt: at, order: `a${index}`, orderAt: at })),
    edges: [{ from: 'grip', to: 'stroke', addedAt: at }],
    kinds: DEFAULT_KINDS.map((kind, rank) => ({ id: kind.id, createdAt: at, hue: kind.hue, hueAt: at, label: kind.label, labelAt: at, description: kind.description,
      descriptionAt: at, rank, rankAt: at })) });
  room.receiveProgressGraft({ marks: [] });
  room.dispatch({ kind: 'RenameNode', id: 'grip', label: 'Grip the oars lightly' });
  room.dispatch({ kind: 'CreateNode', id: 'mile', label: 'Row a mile', prerequisites: ['stroke'] });
  room.dispatch({ kind: 'DeleteNode', id: 'turn' });
  room.markProgress(['stroke'], 'complete');
  await room.persistNow();
  room.close();
  new WorkspaceStore().save(tree, { grip: addSubtask(emptyWorkspace(), 'Loosen the wrists') });
}

// A roadmap the old bundle planted with nobody signed in.
async function plantedSignedOut(title = 'Learn to sail') {
  globalThis.window.wmDeviceConfirmation = { owner: null };
  return bearImportedTree({ title, kinds: DEFAULT_KINDS, nodes: [{ id: 'wind', label: 'Read the wind', color: 'olive', prerequisites: [] }] });
}

// The old sync database's roadmaps.
const oldRecords = async () => (await new SyncStore().treeIds({ durable: true })).sort();

// What the browser keeps beside each roadmap's records, planted for `trees`: the legend and both ledgers.
function plantResidue(trees) {
  for (const tree of trees) {
    globalThis.window.localStorage.setItem(`windmill:legend:${tree}`, JSON.stringify({ kinds: [{ id: 'build', label: 'Build' }] }));
    globalThis.window.localStorage.setItem(`windmill:return:${tree}`, JSON.stringify({ completed: ['wind'], at: 1 }));
    globalThis.window.localStorage.setItem(`windmill:milestones:${tree}`, JSON.stringify(['wind']));
  }
}

// The last place standing on `tree`, and what sharing left.
function plantPlace(tree) {
  globalThis.window.localStorage.setItem('windmill:last-place', JSON.stringify({ treeId: tree, layout: 'graph', cameraFormat: 'bubble-168-1', camera: null, selectedId: null, at: 1 }));
  globalThis.window.localStorage.setItem('windmill:shared:t_00000000000000cc', '{}');
  globalThis.window.localStorage.setItem('windmill:card:unit', 'cm');
}

// Every key of the browser's localStorage that holds a roadmap's residue, with each id written as its name.
function residue(names) {
  return Object.keys(globalThis.window.localStorage)
    .filter((key) => /^windmill:(legend|return|milestones|last-place|shared|card)/.test(key))
    .map((key) => Object.entries(names).reduce((text, [id, name]) => text.replace(id, name), key)).sort();
}

for (const answer of ['discard', 'add', 'cancel']) {
  test(`a sign-in answered ${answer === 'cancel' ? 'with Escape' : answer === 'add' ? 'Add' : 'Discard'} ${answer === 'discard' ? 'takes what the browser kept beside the roadmaps its Discard took, once the sign-in completes' : 'keeps what the browser kept beside its roadmaps'}, and leaves every other roadmap’s`, async (t) => {
    const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
    const { engine, plant } = await device(t, { holdsRoadmaps: true });
    globalThis.window.localStorage = keyedStorage();
    const sail = await plant('Learn to sail', ['Read the wind']);
    const other = 't_00000000000000dd';
    plantResidue([sail.tree, other]);
    plantPlace(sail.tree);
    const due = roadmapDue(await engine.signIn('A'));
    const words = await accountChange.signInWords(engine, due, () => {});
    const forgotten = words.onStep(answer);
    await pause(0);
    const asked = residue({ [sail.tree]: 'sail', [other]: 'other' });
    if (answer === 'cancel') await engine.cancelSignIn('A');
    else assert.equal((await engine.signIn('A', { decisions: { roadmap: answer }, counted: { roadmap: due.counted } })).complete, true);
    await forgotten;
    const kept = ['windmill:card:unit', 'windmill:legend:other', 'windmill:milestones:other', 'windmill:return:other', 'windmill:shared:t_00000000000000cc'];
    const all = [...kept, 'windmill:last-place', 'windmill:legend:sail', 'windmill:milestones:sail', 'windmill:return:sail'].sort();
    assert.deepEqual({ asked, answered: residue({ [sail.tree]: 'sail', [other]: 'other' }), state: engine.getSnapshot().state },
      { asked: all, answered: answer === 'discard' ? kept : all, state: answer === 'cancel' ? 'anon' : 'bound' });
  });
}

test('at sign-out the question names the account’s roadmaps waiting in the old stores beside its unsent work, and its Discard takes exactly those it counted: what an old tab wrote since, another account’s and the anonymous ones stay', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const disk = oldBrowser(t);
  const server = new Server();
  await editedOffline('t_00000000000000a1', 'Learn to row', 'A');
  await editedOffline('t_00000000000000a2', 'Learn to dive', 'A');
  await editedOffline('t_00000000000000b1', 'Learn to knit', 'B');
  const anonymous = await plantedSignedOut();
  const engine = await tab(t, disk, server, 'A');
  engine.setOnline(false);
  assert.equal((await runnerOf(engine).runAct(new CreateRoadmap('Learn to swim'))).kind, 'committed');
  const question = await engine.beginSignOut();
  const told = [];
  const words = await accountChange.signOutWords(engine, question, (name, props) => told.push([name, props]));
  assert.deepEqual({ lead: words.lead, items: words.items, note: words.note }, {
    lead: '13 changes haven’t reached your account.',
    items: ['Learn to swim · 1 change', 'Learn to row · 6 changes', 'Learn to dive · 6 changes'],
    note: 'Keep them for your next sign-in. Discard removes them from this browser.',
  });
  const dive = new SyncSession({ treeId: 't_00000000000000a2', title: 'Learn to dive' });
  await dive.start();
  dive.dispatch({ kind: 'RenameNode', id: 'stroke', label: 'Kick slowly' });
  await dive.persistNow();
  dive.close();
  words.onStep('discard');
  assert.equal((await engine.finishSignOut({ choice: 'discard', counted: question.counted })).complete, true);
  await accountChange.forgetReplicaRoom({ engine, previous: 'A', track: (name, props) => told.push([name, props]) });
  assert.deepEqual({ old: await oldRecords(), rows: Object.keys(new LocalTreeRegistry().entries()).sort(), told }, {
    old: ['t_00000000000000a2', 't_00000000000000b1', anonymous].sort(),
    rows: ['t_00000000000000a2', 't_00000000000000b1', anonymous].sort(),
    told: [['roadmap_signout', { step: 'discard', changes: '6-20' }], ['roadmap_carry', { stage: 'discarded', roadmaps: '1' }]],
  });
});

test('a sign-out question with nothing unsent in the replica still names the account’s waiting roadmaps, and its Keep takes none of them', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const disk = oldBrowser(t);
  const server = new Server();
  await editedOffline('t_00000000000000a1', 'Learn to row', 'A');
  const engine = await tab(t, disk, server, 'A');
  engine.setOnline(false);
  const question = await engine.beginSignOut();
  const words = await accountChange.signOutWords(engine, question, () => {});
  assert.deepEqual({ unsent: question.unsent, lead: words.lead, items: words.items }, { unsent: 0, lead: '6 changes haven’t reached your account.', items: ['Learn to row · 6 changes'] });
  words.onStep('keep');
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  await accountChange.forgetReplicaRoom({ engine, previous: 'A' });
  assert.deepEqual(await oldRecords(), ['t_00000000000000a1']);
});

test('a Discard its question did not word, in the shell’s words, takes no old store; an account’s closure takes every old roadmap whose row names it', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const disk = oldBrowser(t);
  const server = new Server();
  await editedOffline('t_00000000000000a1', 'Learn to row', 'A');
  await editedOffline('t_00000000000000b1', 'Learn to knit', 'B');
  const anonymous = await plantedSignedOut();
  const engine = await tab(t, disk, server, 'A');
  engine.setOnline(false);
  const asked = await engine.beginSignOut();
  const words = await accountChange.signOutWords(engine, { ...asked, counted: [...asked.counted, 'device:journal:claim:digest'] }, () => {});
  assert.equal((await engine.finishSignOut({ choice: 'discard', counted: asked.counted })).complete, true);
  await accountChange.forgetReplicaRoom({ engine, previous: 'A' });
  const unworded = await oldRecords();
  engine.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await engine.write(null, (device) => { device.meta.closingAccount = { account: 'A', sessionId: 'session-a' }; });
  assert.equal((await engine.finishSignOut({ choice: 'discard' })).complete, true);
  await accountChange.forgetReplicaRoom({ engine, previous: 'A' });
  assert.deepEqual({ words, unworded, closed: await oldRecords() },
    { words: null, unworded: ['t_00000000000000a1', 't_00000000000000b1', anonymous].sort(), closed: ['t_00000000000000b1', anonymous].sort() });
});

for (const leaving of ['keep', 'discard', 'closure']) {
  test(`${leaving === 'closure' ? 'an account’s closure' : `a sign-out with ${leaving === 'keep' ? 'Keep' : 'Discard'}`} leaves no legend, ledger, last place or share residue of the account’s roadmaps in localStorage, and the anonymous roadmaps’ stay`, async (t) => {
    const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
    const disk = oldBrowser(t);
    const server = new Server();
    const anonymous = await plantedSignedOut();
    const engine = await tab(t, disk, server, 'A');
    engine.setOnline(false);
    const made = await runnerOf(engine).runAct(new CreateRoadmap('Learn to swim'));
    const mine = String(made.result.tree);
    plantResidue([mine, 't_00000000000000a1', anonymous]);
    plantPlace(mine);
    const before = residue({ [mine]: 'mine', t_00000000000000a1: 'other', [anonymous]: 'anonymous' });
    if (leaving === 'closure') await engine.write(null, (device) => { device.meta.closingAccount = { account: 'A', sessionId: 'session-a' }; });
    assert.equal((await engine.finishSignOut({ choice: leaving === 'keep' ? 'keep' : 'discard' })).complete, true);
    const signedOut = await runnerOf(engine).runAct(new CreateRoadmap('Learn to float'));
    plantResidue([String(signedOut.result.tree)]);
    await accountChange.forgetReplicaRoom({ engine, previous: 'A' });
    assert.deepEqual({ before, after: residue({ [mine]: 'mine', t_00000000000000a1: 'other', [anonymous]: 'anonymous', [String(signedOut.result.tree)]: 'float' }), old: await oldRecords() }, {
      before: ['windmill:card:unit', 'windmill:last-place', 'windmill:legend:anonymous', 'windmill:legend:mine', 'windmill:legend:other', 'windmill:milestones:anonymous',
        'windmill:milestones:mine', 'windmill:milestones:other', 'windmill:return:anonymous', 'windmill:return:mine', 'windmill:return:other', 'windmill:shared:t_00000000000000cc'],
      after: ['windmill:legend:anonymous', 'windmill:legend:float', 'windmill:milestones:anonymous', 'windmill:milestones:float',
        'windmill:return:anonymous', 'windmill:return:float'],
      old: [anonymous],
    });
  });
}

test('signed out, work on another’s public roadmap is named by its changes as this browser showed it, never by the name another account’s replica holds on this shared browser, and the Discard takes what it named', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const disk = oldBrowser(t);
  const server = new Server();
  const phone = await tab(t, { engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() }, server, 'C');
  const made = await runnerOf(phone).runAct(new CreateRoadmap('Open water', { steps: [{ key: 'float', label: 'Float' }], links: [] }));
  assert.equal((await runnerOf(phone).runAct(new SetVisibility(String(made.result.tree), 'public'))).kind, 'committed');
  await sent(phone);
  const tree = String(made.result.tree);
  const engine = await tab(t, disk, server, 'C');
  await engine.subscribe(RoadmapScopes.tree(tree));
  await until(engine, () => titleOf(engine, tree) === 'Open water', 'the roadmap on the shared browser');
  engine.setOnline(false);
  assert.equal((await runnerOf(engine).runAct(new WriteRoadmap(tree, { title: 'Secret plan' }))).kind, 'committed');
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  engine.transport.account = null;
  engine.setOnline(true);
  await engine.subscribe(RoadmapScopes.tree(tree));
  await until(engine, () => titleOf(engine, tree) === 'Open water', 'the public roadmap, signed out');
  assert.equal((await runnerOf(engine).runAct(Complete(tree, made.result.steps.float))).kind, 'committed');
  assert.equal((await runnerOf(engine).runAct(new CreateRoadmap('Learn to sail'))).kind, 'committed');
  const other = await tab(t, { engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() }, server, 'B');
  assert.equal((await runnerOf(other).runAct(new CreateRoadmap('Learn to knit'))).kind, 'committed');
  await sent(other);
  engine.transport.account = 'B';
  const due = roadmapDue(await engine.signIn('B'));
  const words = await accountChange.signInWords(engine, due, () => {});
  assert.deepEqual({ dormant: engine.device.replicas.some((replica) => replica.meta.state === 'dormant' && JSON.stringify(replica.outbox).includes('Secret plan')),
    adoption: accountChange.adoptionAnswer(engine, due), lead: words.lead, items: words.items, note: words.note, secret: JSON.stringify(words).includes('Secret plan') }, {
    dormant: true, adoption: null, lead: '1 roadmap on this browser can join your account.', items: ['Open water · 1 change', 'Learn to sail'],
    note: 'Choosing Discard removes this browser roadmap.', secret: false,
  });
  assert.equal((await engine.signIn('B', { decisions: { roadmap: 'discard' }, counted: { roadmap: due.counted } })).complete, true);
  assert.deepEqual(engine.device.activeReplica.entries().filter((entry) => engine.registry.productOfRef(entry.scope) === 'roadmap').length, 0);
});

test('a sign-in’s Discard takes the old stores of each roadmap the carry-over carried into the work it counted, the one deleted since among them, while they hold what the question saw, so no later sign-out brings it back; one an old tab wrote since the question, and one it never counted, stay', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const disk = oldBrowser(t);
  const server = new Server();
  const phone = await tab(t, { engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() }, server, 'A');
  assert.equal((await runnerOf(phone).runAct(new CreateRoadmap('Learn to knot'))).kind, 'committed');
  await sent(phone);
  const sail = await plantedSignedOut('Learn to sail');
  const swim = await plantedSignedOut('Learn to swim');
  const dive = await plantedSignedOut('Learn to dive');
  await editedOffline('t_00000000000000b1', 'Learn to knit', 'B');
  const engine = await tab(t, disk, server);
  const told = [];
  const reported = [];
  const carry = new CarryOver({ session: { getSnapshot: () => ({ engine, ready: true }), subscribe: () => () => {} }, locks: disk.locks,
    report: (operation, error, tags) => reported.push({ operation, tags }), track: () => {} });
  carry.start();
  t.after(() => carry.stop());
  const settled = async () => {
    await until(engine, () => carry.binding === engine.activeBinding(), 'the carry-over taking up the active replica');
    for (let running = null; running !== carry.running;) {
      running = carry.running;
      await running;
    }
  };
  const listed = () => runnerOf(engine).read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').map((roadmap) => titleOf(engine, roadmap.id.record)).sort());
  await settled();
  const carried = listed();
  assert.equal((await runnerOf(engine).runAct(new DeleteRoadmap(dive))).kind, 'committed');
  engine.transport.account = 'A';
  const due = roadmapDue(await engine.signIn('A'));
  const words = await accountChange.signInWords(engine, due, (name, props) => told.push([name, props]), { report: (operation, error, tags) => reported.push({ operation, tags }) });
  const room = new SyncSession({ treeId: swim, title: 'Learn to swim' });
  await room.start();
  room.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Float on your back' });
  await room.persistNow();
  room.close();
  const forgotten = words.onStep('discard');
  assert.equal((await engine.signIn('A', { decisions: { roadmap: 'discard' }, counted: { roadmap: due.counted } })).complete, true);
  await forgotten;
  await settled();
  const discarded = { old: await oldRecords(), rows: Object.keys(new LocalTreeRegistry().entries()).sort() };
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  engine.transport.account = null;
  await settled();
  assert.deepEqual({ carried, items: words.items, discarded, signedOut: listed(), told, reported }, {
    carried: ['Learn to dive', 'Learn to sail', 'Learn to swim'],
    items: ['Learn to sail', 'Learn to swim'],
    discarded: { old: [swim, 't_00000000000000b1'].sort(), rows: [swim, 't_00000000000000b1'].sort() },
    signedOut: ['Learn to swim'],
    told: [['roadmap_signin', { step: 'discard', roadmaps: '2-5', conversations: '0' }], ['roadmap_carry', { stage: 'discarded', roadmaps: '2-5' }]],
    reported: [],
  });
});

// Coach's records, made signed out and taken through each answer to the account and a second browser of it. A browser of
// its own: storage, locks and channels.
const ownDisk = () => ({ engines: new IDBFactory(), locks: new FakeLocks(), channels: new FakeChannels() });

// A pending proposal about `tree` on Coach's answer, minted as Coach's tool host mints one: a rename of `step`, its base
// left empty, since nothing here applies it.
/** @param {ActionRunner} runner @param {string} tree @param {string} step @param {{ thread: Id<any>, coach: Id<any> }} turn */
function proposed(runner, tree, step, { thread, coach }) {
  return runner.runAct(new MintProposal({ proposal: runner.mint(CoachProposal), treeId: tree, thread, message: coach,
    changes: [{ op: 'rename', nodeId: step, label: 'Read the wind well' }], base: [] }));
}

// What a browser draws of Coach: each conversation, by what it is about, with who said what and the state Coach's turn
// stands in; each proposal with its roadmap and state; and how many turns this browser holds marked as running.
function coachOf(engine) {
  return runnerOf(engine).read(RoadmapScopes.account, (read) => ({
    conversations: read.repository(CoachThread).all('drawn').map((thread) => ({ about: thread.treeId,
      said: Conversation.read(read, thread.id).messages.map((message) => [message.role, message.text, message.isCoach ? message.state : null]) }))
      .sort((a, b) => String(a.about).localeCompare(String(b.about))),
    proposals: read.repository(CoachProposal).all('drawn').map((proposal) => ({ about: proposal.treeId, state: proposal.state })),
    marks: Object.keys(read.devices('runningTurn:')).length,
  }));
}

const listed = (engine) => runnerOf(engine).read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').length);

for (const answer of ['add', 'discard']) {
  test(`signed out, a conversation and a pending proposal about a roadmap made here, and a turn still running: ${answer === 'add'
    ? 'Add takes them to the account, where a second browser draws them, the proposal still pending'
    : 'Discard takes them from the browser with the turn’s mark, and the account never holds them'}`, async (t) => {
    const server = new Server();
    const phone = await tab(t, ownDisk(), server, 'A');
    assert.equal((await runnerOf(phone).runAct(new CreateRoadmap('Learn to row'))).kind, 'committed');
    await sent(phone);
    const engine = await tab(t, ownDisk(), server);
    const made = await runnerOf(engine).runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] }));
    const sail = String(made.result.tree);
    const turn = await answered(runnerOf(engine), sail);
    assert.equal((await proposed(runnerOf(engine), sail, String(made.result.steps.wind), turn)).kind, 'committed');
    assert.equal((await runnerOf(engine).runAct(new OpenTurn({ about: { treeId: null }, question: 'And after that?' }))).kind, 'committed');
    const before = coachOf(engine);
    engine.transport.account = 'A';
    const due = roadmapDue(await engine.signIn('A'));
    assert.equal((await engine.signIn('A', { decisions: { roadmap: answer }, counted: { roadmap: due.counted } })).complete, true);
    await sent(engine);
    const second = await tab(t, ownDisk(), server, 'A');
    await until(second, () => listed(second) === (answer === 'add' ? 2 : 1), 'the account’s list on a second browser');
    if (answer === 'add') await until(second, () => coachOf(second).proposals.length === 1, 'the proposal on a second browser');
    const none = { conversations: [], proposals: [], marks: 0 };
    assert.deepEqual({ before, here: coachOf(engine), second: coachOf(second) }, {
      before: {
        conversations: [
          { about: null, said: [['person', 'And after that?', null], ['coach', '', 'running']] },
          { about: sail, said: [['person', 'Where do I start?', null], ['coach', 'Read the wind.', 'completed']] },
        ],
        proposals: [{ about: sail, state: 'pending' }],
        marks: 1,
      },
      here: answer === 'add' ? before : none,
      second: answer === 'add' ? { ...before, marks: 0 } : none,
    });
  });
}

test('signed out, a conversation beside work on another’s public roadmap: the question counts the browser’s roadmaps, its conversations and the changes to another’s roadmap (10.4)', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const server = new Server();
  const owner = await tab(t, ownDisk(), server, 'C');
  const made = await runnerOf(owner).runAct(new CreateRoadmap('Open water', { steps: [{ key: 'float', label: 'Float' }], links: [] }));
  const water = String(made.result.tree);
  assert.equal((await runnerOf(owner).runAct(new SetVisibility(water, 'public'))).kind, 'committed');
  await sent(owner);
  const engine = await tab(t, ownDisk(), server);
  await engine.subscribe(RoadmapScopes.tree(water));
  await until(engine, () => titleOf(engine, water) === 'Open water', 'the public roadmap, signed out');
  assert.equal((await runnerOf(engine).runAct(Complete(water, made.result.steps.float))).kind, 'committed');
  const sail = await runnerOf(engine).runAct(new CreateRoadmap('Learn to sail'));
  await answered(runnerOf(engine), String(sail.result.tree));
  const holder = await tab(t, ownDisk(), server, 'B');
  assert.equal((await runnerOf(holder).runAct(new CreateRoadmap('Learn to knit'))).kind, 'committed');
  await sent(holder);
  engine.transport.account = 'B';
  const due = roadmapDue(await engine.signIn('B'));
  const words = await accountChange.signInWords(engine, due, () => {});
  assert.deepEqual({ lead: words.lead, items: words.items, note: words.note, discard: words.discard }, {
    lead: 'This browser has 1 roadmap, 1 conversation, and 1 change from before you signed in. Your account already has roadmaps. Add them, or discard them from this browser.',
    items: [],
    note: null,
    discard: { title: 'Discard 1 roadmap, 1 conversation, and 1 change?', body: 'They are deleted from this browser. You can’t undo this.' },
  });
});
