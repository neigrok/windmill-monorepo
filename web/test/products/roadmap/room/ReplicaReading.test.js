import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { FakeChannels, FakeLocks, FakeTimers, until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { CreateRoadmap, CreateSubtree, SetVisibility, WriteRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { ChangeStep, CreateStep, DeleteStep } from '../../../../src/products/roadmap/domain/steps.js';
import { Complete, SetPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { AddStepLink, AddSubtask } from '../../../../src/products/roadmap/domain/workspace.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { FIRST_COPY_MS, ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

test('a roadmap opens from the device’s copy in the shapes the room reads today, its marks dated as the server received them', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
      { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock', color: 'sky', description: 'Fenders out' },
      { key: 'solo', label: 'Sail solo', links: [{ url: 'https://example.com/solo', label: 'Checklist' }] },
    ], links: [['wind', 'dock'], ['dock', 'solo']] })));
    committed(await a.runner.runAct(new WriteRoadmap(tree, { guide: 'Go slowly' })));
    committed(await a.runner.runAct(Complete(tree, steps.wind)));
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    const read = await reading.read({ signal: new AbortController().signal });
    const born = { ms: 1_800_000_000_000, counter: 1, actor: 'r_000000000002' };
    assert.deepEqual({ ...read.seed, place: { ...read.seed.place } }, {
      id: tree, title: 'Learn to sail', guide: 'Go slowly', author: null, visibility: 'private', mine: true,
      place: { root: tree, parent: null, path: [], depth: 0 },
      kinds: [
        { id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' },
        { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
        { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' },
      ],
      nodes: [
        { id: steps.solo, label: 'Sail solo', icon: '', color: 'terracotta', order: 'a0', createdAt: born, createdMs: 1_800_000_000_000,
          prerequisites: [steps.dock], status: undefined, description: undefined, links: [{ url: 'https://example.com/solo', label: 'Checklist' }], opens: undefined },
        { id: steps.wind, label: 'Read the wind', icon: '', color: 'terracotta', order: 'a0', createdAt: born, createdMs: 1_800_000_000_000,
          prerequisites: [], status: undefined, description: undefined, links: undefined, opens: undefined },
        { id: steps.dock, label: 'Leave the dock', icon: '', color: 'sky', order: 'a0', createdAt: born, createdMs: 1_800_000_000_000,
          prerequisites: [steps.wind], status: undefined, description: 'Fenders out', links: undefined, opens: undefined },
      ],
    });
    assert.deepEqual(read.overlay, { completed: new Set([steps.wind]), completedAt: { [steps.wind]: 1_800_000_000_000 }, server: true });
    assert.deepEqual({ workspace: read.workspace, guides: read.guides },
      { workspace: {}, guides: { guides: [{ treeId: tree, title: 'Learn to sail', text: 'Go slowly' }] } });
    reading.close();
  } finally {
    a.close();
  }
});

test('the room follows each change the replica draws: a step deleted elsewhere is read through, and a mark made unsent is dated by the device', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
      { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock' }, { key: 'solo', label: 'Sail solo' },
    ], links: [['wind', 'dock'], ['dock', 'solo']] })));
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    await reading.read({ signal: new AbortController().signal });
    const followed = [];
    reading.follow({ onTree: (seed) => followed.push(['tree', seed.nodes.map((step) => [step.id, step.prerequisites])]),
      onProgress: (marks) => followed.push(['marks', [...marks.completed], marks.completedAt]), onWorkspace: () => {}, onGuides: () => {},
      onLanding: () => {}, onActivity: () => {} });

    committed(await a.runner.runAct(new DeleteStep(tree, steps.dock)));
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    await until(() => followed.length >= 2);
    assert.deepEqual(followed.at(-2), ['tree', [[steps.solo, [steps.wind]], [steps.wind, []]]]);

    a.world.now += 60_000;
    a.env.timers.time = a.world.now;
    committed(await a.runner.runAct(Complete(tree, steps.wind)));
    await until(() => followed.at(-1)[1].length === 1);
    assert.deepEqual(followed.at(-1), ['marks', [steps.wind], { [steps.wind]: a.world.now }]);
    assert.deepEqual(reading.statusSnapshot(), { phase: 'live', online: true, structurePending: 0, progressPending: 1, structureInFlight: 0,
      progressInFlight: 0, structureGestures: 0, progressGestures: 0, rebaselining: false, progressBlocked: false, refused: null, receiptVersion: 0 });
    reading.close();
  } finally {
    a.close();
  }
});

// The device keeps nothing of a step deleted elsewhere but its spent id (engine.md §7.5): a line names it as the device's
// note took it when the device linked from it, the link reaching the server after the delete, and an edit made after the
// delete arrived brings the step back.
test('the device tells its own changes once: a new step that follows past a step another device deleted, and a step its edit brought back; a read that fails tells nothing and reports once', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [
      { key: 'course', label: 'Choose a course' }, { key: 'wind', label: 'Read the wind' }, { key: 'dock', label: 'Leave the dock' },
    ], links: [['course', 'wind'], ['wind', 'dock']] })));
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    const b = await a.device();
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    await reading.read({ signal: new AbortController().signal });
    const landed = [];
    reading.follow({ onTree: () => {}, onProgress: () => {}, onWorkspace: () => {}, onGuides: () => {}, onLanding: (lines) => landed.push(lines), onActivity: () => {} });

    committed(await b.runner.runAct(new DeleteStep(tree, steps.wind)));
    committed(await b.runner.runAct(new DeleteStep(tree, steps.dock)));
    await a.advance(CONSTANTS.HOLD_MS);
    await b.senderStep();
    const reef = committed(await a.runner.runAct(new CreateStep(tree, { label: 'Reef the sail' }, [steps.wind])));
    await a.sync();
    committed(await a.runner.runAct(new ChangeStep(tree, steps.dock, { description: 'Cast off the lines' })));
    await a.sync();
    assert.deepEqual(reading.landing(), [
      { key: `follows:${reef}:${steps.wind}`, step: reef, rule: 'follows', removed: ['Read the wind'], followed: ['Choose a course'],
        told: { nodes: [reef], edges: [[steps.wind, reef]] } },
      { key: `cameBack:${steps.dock}`, step: steps.dock, rule: 'cameBack', told: { revived: [steps.dock] } },
    ]);
    assert.deepEqual(landed.at(-1).map((line) => line.key), [`follows:${reef}:${steps.wind}`, `cameBack:${steps.dock}`]);

    await reading.tell(reading.landing());
    assert.deepEqual({ landing: reading.landing(), note: a.runner.read(RoadmapScopes.tree(tree), (read) => read.device(RoadmapScopes.landing(tree))) },
      { landing: [], note: null });
    reading.close();

    const reports = [];
    const failing = new ReplicaReading({ treeId: tree, timers: a.env.timers, report: (operation) => reports.push(operation),
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    await failing.read({ signal: new AbortController().signal });
    failing.writes.runner.read = () => { throw new Error('the note could not be read'); };
    assert.deepEqual({ lines: [failing.landing(), failing.landing()], reports }, { lines: [[], []], reports: ['roadmap-replica-landing'] });
    failing.close();
  } finally {
    a.close();
  }
});

test('a subtree stands on its step with how far it is, a pointer opens the roadmap it names, and a hidden subtree is in no address and no list', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [
      { key: 'sail', label: 'Learn to sail' }, { key: 'book', label: 'Write the book' },
    ], links: [] })));
    const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail)));
    const knot = committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Tie a bowline' }, [])));
    committed(await a.runner.runAct(Complete(subtree, knot)));
    const other = committed(await a.runner.runAct(new CreateRoadmap('The book', { steps: [{ key: 'draft', label: 'Draft' }], links: [] })));
    committed(await a.runner.runAct(SetPointer(tree, steps.book, other.tree)));
    for (const id of [tree, subtree, other.tree]) for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const open = (treeId) => new ReplicaReading({ treeId, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });

    const root = open(tree);
    const read = await root.read({ signal: new AbortController().signal });
    const opening = (id) => {
      const { treeId, read: known, valid, complete, title, done, total, loop, own, owned, provisional } = read.seed.nodes.find((step) => step.id === id).opening;
      return { treeId, known, valid, complete, title, done, total, loop, own, owned, provisional };
    };
    assert.deepEqual({ sail: opening(steps.sail), book: opening(steps.book), opens: read.seed.nodes.map((step) => step.opens ?? null) }, {
      sail: { treeId: subtree, known: true, valid: true, complete: true, title: '', done: 1, total: 1, loop: false, own: false, owned: true, provisional: false },
      book: { treeId: other.tree, known: true, valid: true, complete: false, title: 'The book', done: 0, total: 1, loop: false, own: false, owned: false, provisional: false },
      opens: [null, other.tree],
    });
    assert.deepEqual((await root.list()).map(({ id, title, done, total, origin }) => ({ id, title, done, total, origin })).sort((x, y) => x.title.localeCompare(y.title)), [
      { id: tree, title: 'My year', done: 1, total: 2, origin: 'server' },
      { id: other.tree, title: 'The book', done: 0, total: 1, origin: 'server' },
    ]);
    root.close();

    const inside = await open(subtree).read({ signal: new AbortController().signal });
    assert.deepEqual({ title: inside.seed.title, place: { ...inside.seed.place }, mine: inside.seed.mine }, {
      title: 'Learn to sail', mine: true,
      place: { root: tree, parent: { tree, step: steps.sail }, path: [{ tree, step: steps.sail, title: 'My year' }], depth: 1 },
    });

    committed(await a.runner.runAct(new DeleteStep(tree, steps.sail)));
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    const told = [];
    const hidden = new ReplicaReading({ treeId: subtree, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, repository: { loadActivity: async () => [] } });
    assert.deepEqual({ read: await hidden.read({ signal: new AbortController().signal }), told }, { read: null, told: [['roadmap_load', { outcome: 'missing' }]] });
  } finally {
    a.close();
  }
});

test('a reader’s step that owns a subtree stands on what the server says the subtree has come to, through each change the room follows; one it says nothing of stays unread', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [
      { key: 'sail', label: 'Learn to sail' }, { key: 'bay', label: 'Cross the bay' }, { key: 'book', label: 'Write the book' },
    ], links: [['sail', 'bay']] })));
    const sail = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail))).subtree;
    const bay = committed(await a.runner.runAct(new CreateSubtree(tree, steps.bay))).subtree;
    const book = committed(await a.runner.runAct(new CreateSubtree(tree, steps.book))).subtree;
    for (const id of [tree, sail, bay, book]) a.observe(RoadmapScopes.tree(id));
    await a.sync();
    // The engine as a stranger's browser sees it: no roadmap of theirs in the list, so the roadmap is someone else's.
    const nothing = { drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: true, firstPullComplete: true };
    const engine = Object.create(a.engine, { observe: { value: (scope) => (scope === RoadmapScopes.account
      ? { subscribe: () => () => {}, getSnapshot: () => nothing, release: () => {} } : a.engine.observe(scope)) } });
    const snapshot = { engine, ready: true, online: true, error: false };
    const subtrees = new Map([
      [steps.sail, Opening.owned({ id: sail, done: 1, total: 2, state: 'open' })],
      [steps.bay, Opening.owned({ id: bay, done: 0, total: 0, state: 'open' })],
    ]);
    const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers, session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => ({ completed: new Set(), completedAt: {}, server: true, subtrees }), loadActivity: async () => [] } });
    const read = await reading.read({ signal: new AbortController().signal });
    const pills = (seed) => Object.fromEntries(seed.nodes.map(({ label, opening }) => [label, [opening.face, opening.done, opening.total]]));
    assert.deepEqual({ pills: pills(read.seed), overlay: read.overlay, workspace: read.workspace }, {
      pills: { 'Learn to sail': ['open', 1, 2], 'Cross the bay': ['empty', 0, 0], 'Write the book': ['unread', 0, 0] },
      overlay: { completed: new Set(), completedAt: {}, server: true }, workspace: null,
    });

    const followed = [];
    reading.follow({ onTree: (seed) => followed.push(pills(seed)), onProgress: () => assert.fail('a reader is shown the owner’s marks the server read'),
      onWorkspace: () => {}, onGuides: () => {}, onLanding: () => {}, onActivity: () => {} });
    committed(await a.runner.runAct(new ChangeStep(tree, steps.bay, { label: 'Cross the sound' })));
    await a.sync();
    await until(() => followed.length >= 1);
    const renamed = { 'Learn to sail': ['open', 1, 2], 'Cross the sound': ['empty', 0, 0], 'Write the book': ['unread', 0, 0] };
    assert.deepEqual(followed, followed.map(() => renamed), 'every picture the room follows keeps what the server said');
    reading.close();
  } finally {
    a.close();
  }
});

test('the room subscribes the roadmap it opens and drops it on leaving; with no copy, offline, it says so at once, and online after the bound', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    await a.sync();
    a.engine.setOnline(false);
    const snapshot = { engine: a.engine, ready: true, online: false, error: false };
    const told = [];
    const track = (name, props) => told.push([name, props]);
    const offline = new ReplicaReading({ treeId: 't_00000000000000aa', timers: a.env.timers, track,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, repository: { loadActivity: async () => [] } });
    assert.equal(await offline.read({ signal: new AbortController().signal }), null);
    assert.equal(a.engine.openScopes.has('tree/t_00000000000000aa'), true);
    offline.close();
    await until(() => !a.engine.openScopes.has('tree/t_00000000000000aa'));

    a.engine.setOnline(true);
    snapshot.online = true;
    const waiting = new ReplicaReading({ treeId: 't_00000000000000ab', timers: a.env.timers, track,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, repository: { loadActivity: async () => [] } });
    let answered = 'pending';
    waiting.read({ signal: new AbortController().signal }).then((read) => { answered = read; });
    await until(() => a.engine.openScopes.has('tree/t_00000000000000ab'));
    a.env.timers.advance(FIRST_COPY_MS - 1);
    await until(() => true);
    assert.equal(answered, 'pending');
    a.env.timers.advance(1);
    await until(() => answered !== 'pending');
    assert.equal(answered, null);
    waiting.close();
    assert.deepEqual(told, [['roadmap_load', { outcome: 'unanswered' }], ['roadmap_load', { outcome: 'unanswered' }]]);
  } finally {
    a.close();
  }
});

test('a room that leaves while the engine takes its roadmap’s subscription leaves the roadmap unfollowed, however soon it leaves', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const followed = {};
    for (const turns of [0, 1, 2, 3, 4, 6, 10]) {
      const tree = `t_00000000000000${(0xa0 + turns).toString(16)}`;
      const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers,
        session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, repository: { loadActivity: async () => [] } });
      const leaving = new AbortController();
      const read = reading.read({ signal: leaving.signal });
      for (let turn = 0; turn < turns; turn++) await Promise.resolve();
      leaving.abort();
      reading.close();
      assert.equal(await read, null);
      await until(() => true);
      followed[turns] = a.engine.openScopes.has(RoadmapScopes.tree(tree));
    }
    assert.deepEqual(followed, { 0: false, 1: false, 2: false, 3: false, 4: false, 6: false, 10: false });
  } finally {
    a.close();
  }
});

test('a reader who leaves a subtree while the roadmap above it is being subscribed leaves that roadmap unfollowed too', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [{ key: 'sail', label: 'Learn to sail' }], links: [] })));
    const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail)));
    for (const id of [tree, subtree]) for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) a.observe(scope);
    await a.sync();
    // A stranger's browser: no roadmap of theirs in the list, so the subtree is read with the roadmap above it, which it
    // holds nothing of until the engine answers its subscription, once `above` lets it; the engine holds the roadmap
    // open from the moment it is asked.
    let above = null;
    let taken = false;
    const nothing = { drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: true, firstPullComplete: true };
    const seen = (scope, shown) => {
      const hold = a.engine.observe(scope);
      return { subscribe: (listener) => hold.subscribe(listener), getSnapshot: () => (shown() ? hold.getSnapshot() : nothing), release: () => hold.release() };
    };
    const engine = Object.create(a.engine, {
      observe: { value: (scope) => {
        if (scope === RoadmapScopes.account) return seen(scope, () => false);
        if (scope === RoadmapScopes.tree(tree)) return seen(scope, () => taken);
        return a.engine.observe(scope);
      } },
      subscribe: { value: (scope) => {
        if (scope !== RoadmapScopes.tree(tree)) return a.engine.subscribe(scope);
        const answer = a.engine.subscribe(scope);
        return new Promise((resolve) => { above = () => answer.then((said) => { taken = true; resolve(said); }); });
      } },
    });
    const snapshot = { engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: subtree, timers: a.env.timers, session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('the subtree is never shown'), loadActivity: async () => [] } });
    const leaving = new AbortController();
    const read = reading.read({ signal: leaving.signal });
    await until(() => above !== null);
    leaving.abort();
    reading.close();
    assert.equal(await read, null);
    await above();
    await until(() => true);
    assert.deepEqual({ above: a.engine.openScopes.has(RoadmapScopes.tree(tree)), subtree: a.engine.openScopes.has(RoadmapScopes.tree(subtree)) },
      { above: false, subtree: false });
  } finally {
    a.close();
  }
});

// Two readings of one address at once, as the tree picker reads one while the room holds it: each holds the roadmap's
// subscription, so the one that leaves first takes only its own.
test('two readings of a roadmap someone else owns hold it each: the first to leave leaves the other following it, and the last lets it go', async (t) => {
  let state = ServerState.empty({ epoch: 'ep-readers', accounts: { A: { name: 'A' }, B: { name: 'B' } } });
  const product = new RoadmapProduct();
  const tab = async (account) => {
    const transport = {
      request: async (endpoint, request) => {
        const timing = { send: engine.reading(), recv: engine.reading() };
        if (endpoint === 'hello') return { response: hello({ state, registry: roadmapRegistry, account, serverTime: Date.now() }), timing };
        const out = (endpoint === 'push' ? push : pull)({ state, registry: roadmapRegistry, product, account, request, serverNow: Date.now() });
        state = out.state;
        return { response: out.response, timing };
      },
      openLive: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }),
    };
    const locks = new FakeLocks();
    const engine = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, registry: roadmapRegistry, transport, timers: globalThis,
      now: Date.now, monotonic: () => Math.floor(performance.now()), navigator: { onLine: true, locks, storage: { persist: async () => true } },
      document: null, window: null, leadership: { locks, channel: new FakeChannels().open }, telemetry: { event() {}, failure() {} } });
    t.after(() => engine.close());
    assert.equal((await engine.signIn(account)).complete, true);
    await engine.start();
    return engine;
  };
  // Whether `seen` came within five seconds, each engine pulling and sending as it waits.
  const settled = async (engines, seen) => {
    for (let turn = 0; turn < 250 && !seen(); turn += 1) {
      for (const engine of engines) {
        engine.kick();
        engine.kickPull();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return seen();
  };
  const owner = await tab('A');
  const runner = new ActionRunner(new EngineReplica(owner), roadmapRegistry, new FixedZone(0));
  const { tree } = committed(await runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
  committed(await runner.runAct(new SetVisibility(tree, 'public')));
  assert.ok(await settled([owner], () => owner.device.activeReplica.outbox.every((entry) => entry.state === 'acked')), 'the owner’s roadmap reaches the server');
  const stranger = await tab('B');
  const snapshot = { engine: stranger, ready: true, online: true, error: false };
  const address = () => new ReplicaReading({ treeId: tree, session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    repository: { loadProgress: async () => assert.fail('an address reads no marks'), loadActivity: async () => assert.fail('an address reads no activity') } });
  const first = address(), second = address();
  const cards = await Promise.all([first.readCard(), second.readCard()]);
  first.close();
  committed(await runner.runAct(new WriteRoadmap(tree, { title: 'Learn to sail far' })));
  const title = () => (second.roadmap().state === 'open' ? second.roadmap().seed.title : second.roadmap().state);
  await settled([owner, stranger], () => title() === 'Learn to sail far');
  const afterFirstClosed = { followed: stranger.scopes().includes(RoadmapScopes.tree(tree)), title: title() };
  second.close();
  const card = { id: tree, title: 'Learn to sail', author: null, steps: 1, mine: false };
  assert.deepEqual({ cards, afterFirstClosed, letGo: await settled([stranger], () => !stranger.scopes().includes(RoadmapScopes.tree(tree))) },
    { cards: [card, card], afterFirstClosed: { followed: true, title: 'Learn to sail far' }, letGo: true });
});

test('a browser whose copy could not open, as one that keeps nothing, is told at once that the roadmap cannot be shown; one whose copy does not open within the bound, after it', async () => {
  const timers = new FakeTimers();
  const told = [];
  const track = (name, props) => told.push([name, props]);
  const unkept = new ReplicaReading({ treeId: 't_00000000000000aa', timers, track, repository: { loadActivity: async () => [] },
    session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: true }), subscribe: () => () => {} } });
  assert.equal(await unkept.read({ signal: new AbortController().signal }), null);
  assert.deepEqual(told, [['roadmap_load', { outcome: 'unkept' }]]);
  unkept.close();

  const unopened = new ReplicaReading({ treeId: 't_00000000000000aa', timers, track, repository: { loadActivity: async () => [] },
    session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: false }), subscribe: () => () => {} } });
  let answered = 'pending';
  unopened.read({ signal: new AbortController().signal }).then((read) => { answered = read; });
  timers.advance(FIRST_COPY_MS);
  await until(() => answered !== 'pending');
  assert.deepEqual({ answered, told }, { answered: null, told: [['roadmap_load', { outcome: 'unkept' }], ['roadmap_load', { outcome: 'unopened' }]] });
  unopened.close();

  const left = new AbortController();
  const leaving = new ReplicaReading({ treeId: 't_00000000000000aa', timers, track, repository: { loadActivity: async () => [] },
    session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: false }), subscribe: () => () => {} } });
  const read = leaving.read({ signal: left.signal });
  left.abort();
  assert.deepEqual({ read: await read, told: told.length }, { read: null, told: 2 });
});

test('the owner’s workspace comes from their overlay, each step’s items in their own order', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
    const first = committed(await a.runner.runAct(AddSubtask(tree, steps.wind, 'Check the forecast')));
    const second = committed(await a.runner.runAct(AddSubtask(tree, steps.wind, 'Watch the flags')));
    const link = committed(await a.runner.runAct(AddStepLink(tree, steps.wind, { url: 'https://www.example.com/wind', title: '' })));
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });
    const read = await reading.read({ signal: new AbortController().signal });
    assert.deepEqual(read.workspace, { [steps.wind]: {
      subtasks: [{ id: first, label: 'Check the forecast', done: false }, { id: second, label: 'Watch the flags', done: false }],
      note: '',
      links: [{ id: link, url: 'https://www.example.com/wind', title: 'example.com', domain: 'example.com' }],
    } });
    reading.close();
  } finally {
    a.close();
  }
});

test('a roadmap another device deleted takes the device’s note of it along: one the room finds gone as it opens, and one deleted while its room is open', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const plant = async (title) => {
      const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap(title, { steps: [{ key: 'course', label: 'Choose a course' }], links: [] })));
      committed(await a.runner.runAct(new CreateStep(tree, { label: 'Read the wind' }, [steps.course])));
      for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
      return tree;
    };
    const closed = await plant('Learn to sail');
    const open = await plant('Learn to row');
    await a.sync();
    const b = await a.device();
    await a.sync();
    const note = (tree) => a.runner.read(RoadmapScopes.account, (read) => read.device(RoadmapScopes.landing(tree)));
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = (tree) => new ReplicaReading({ treeId: tree, timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an owner reads their own marks'), loadActivity: async () => [] } });

    const room = reading(open);
    await room.read({ signal: new AbortController().signal });
    room.follow({ onTree: () => {}, onProgress: () => {}, onWorkspace: () => {}, onGuides: () => {}, onLanding: () => {}, onActivity: () => {} });
    const { DeleteRoadmap } = await import('../../../../src/products/roadmap/domain/roadmaps.js');
    committed(await b.runner.runAct(new DeleteRoadmap(closed)));
    committed(await b.runner.runAct(new DeleteRoadmap(open)));
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    assert.notEqual(note(closed), null, 'a roadmap deleted elsewhere whose room is not open keeps its note until a reading finds it gone');
    await until(() => note(open) === null);
    room.close();

    const late = reading(closed);
    assert.equal(await late.read({ signal: new AbortController().signal }), null);
    await until(() => note(closed) === null);
    late.close();
  } finally {
    a.close();
  }
});

test('the bare roadmap door reads the person’s list once the device has read it, newest first; with no copy it cannot say which, and tells why', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const plant = async (title) => {
      const { tree } = committed(await a.runner.runAct(new CreateRoadmap(title)));
      for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
      await a.sync();
      return tree;
    };
    const sail = await plant('Learn to sail');
    await a.advance(1000);
    const row = await plant('Learn to row');
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: null, timers: a.env.timers, session: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
    const listed = await reading.readList({ signal: new AbortController().signal });
    reading.close();
    assert.deepEqual(listed.map(({ id, title }) => [id, title]), [[row, 'Learn to row'], [sail, 'Learn to sail']]);

    const told = [];
    const unkept = new ReplicaReading({ treeId: null, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: true }), subscribe: () => () => {} } });
    assert.deepEqual({ listed: await unkept.readList({ signal: new AbortController().signal }), list: unkept.list(), card: unkept.card(sail), told },
      { listed: null, list: null, card: null, told: [['roadmap_load', { outcome: 'unkept' }]] });
    unkept.close();
  } finally {
    a.close();
  }
});

test('a reader who goes into a subtree waits for the roadmap above it to be subscribed: a scope the engine does not pull yet is not read empty', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [{ key: 'sail', label: 'Learn to sail' }], links: [] })));
    const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail)));
    committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Tie a bowline' }, [])));
    for (const id of [tree, subtree]) for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) a.observe(scope);
    await a.sync();
    // The engine as a stranger's browser sees it: no roadmap of theirs in the list, and the roadmap above the subtree not
    // yet in its subscriptions, which it reads, as it reads any scope it does not pull, as pulled and holding nothing.
    let above = null;
    let taken = false;
    const nothing = { drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: true, firstPullComplete: true };
    const seen = (scope, shown) => {
      const hold = a.engine.observe(scope);
      return { subscribe: (listener) => hold.subscribe(listener), getSnapshot: () => (shown() ? hold.getSnapshot() : nothing), release: () => hold.release() };
    };
    const engine = Object.create(a.engine, {
      observe: { value: (scope) => {
        if (scope === RoadmapScopes.account) return seen(scope, () => false);
        if (scope === RoadmapScopes.tree(tree)) return seen(scope, () => taken);
        return a.engine.observe(scope);
      } },
      subscribe: { value: (scope) => (scope === RoadmapScopes.tree(tree)
        ? new Promise((resolve) => { above = () => { taken = true; resolve('subscribed'); }; }) : a.engine.subscribe(scope)) },
    });
    const snapshot = { engine, ready: true, online: true, error: false };
    const told = [];
    const reading = new ReplicaReading({ treeId: subtree, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async (seed) => ({ completed: new Set(), completedAt: {}, server: true, seed }), loadActivity: async () => [] } });
    let answered = 'pending';
    reading.read({ signal: new AbortController().signal }).then((read) => { answered = read; });
    await until(() => above !== null);
    await until(() => true);
    assert.deepEqual({ answered, told }, { answered: 'pending', told: [] }, 'the subtree is not judged before the roadmap above it is subscribed');
    above();
    await until(() => answered !== 'pending');
    assert.deepEqual({ title: answered?.seed.title, steps: answered?.seed.nodes.map((step) => step.label), told }, { title: 'Learn to sail', steps: ['Tie a bowline'], told: [] });
    reading.close();
  } finally {
    a.close();
  }
});

test('the home card and the landing read the person’s roadmaps once the device can say what each is, newest first, and again as they change; with no copy the list is unread, and they tell nothing', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const sail = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
    committed(await a.runner.runAct(Complete(sail.tree, sail.steps.wind)));
    for (const scope of [RoadmapScopes.tree(sail.tree), RoadmapScopes.overlay(sail.tree)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const told = [];
    const reading = new ReplicaReading({ treeId: null, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
    const lists = [];
    const shown = ({ id, title, done, total, origin }) => ({ id, title, done, total, origin });
    await reading.followRoadmaps({ signal: new AbortController().signal, onList: (list) => lists.push(list.map(shown)), onUnread: () => assert.fail('the copy stood') });
    assert.deepEqual(lists, [[{ id: sail.tree, title: 'Learn to sail', done: 1, total: 1, origin: 'server' }]]);

    await a.advance(1000);
    const row = committed(await a.runner.runAct(new CreateRoadmap('Learn to row', { steps: [{ key: 'grip', label: 'Grip the oars' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(row.tree), RoadmapScopes.overlay(row.tree)]) a.observe(scope);
    await a.sync();
    await until(() => lists.at(-1).length === 2 && lists.at(-1)[0].total === 1);
    assert.deepEqual(lists.at(-1), [{ id: row.tree, title: 'Learn to row', done: 0, total: 1, origin: 'server' },
      { id: sail.tree, title: 'Learn to sail', done: 1, total: 1, origin: 'server' }]);
    reading.close();

    const unkept = new ReplicaReading({ treeId: null, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: true }), subscribe: () => () => {} } });
    const heard = [];
    await unkept.followRoadmaps({ signal: new AbortController().signal, onList: () => assert.fail('nothing is listed'), onUnread: () => heard.push('unread') });
    assert.deepEqual({ heard, told }, { heard: ['unread'], told: [] });
    unkept.close();
  } finally {
    a.close();
  }
});

test('the home card and the landing wait on a copy that opens late: the list is unread at the bound, and listed once the copy stands', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const sail = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(sail.tree), RoadmapScopes.overlay(sail.tree)]) a.observe(scope);
    await a.sync();
    let snapshot = { engine: null, ready: false, online: true, error: false };
    const listeners = new Set();
    const session = { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
    const reading = new ReplicaReading({ treeId: null, timers: a.env.timers, track: () => assert.fail('a list tells nothing'), session });
    const heard = [];
    reading.followRoadmaps({ signal: new AbortController().signal, onList: (list) => heard.push(list.map(({ title }) => title)), onUnread: () => heard.push('unread') });
    a.env.timers.advance(FIRST_COPY_MS - 1);
    await until(() => true);
    const beforeTheBound = [...heard];
    a.env.timers.advance(1);
    await until(() => true);
    snapshot = { engine: a.engine, ready: true, online: true, error: false };
    for (const listener of listeners) listener();
    await until(() => heard.length === 2).catch(() => {});
    assert.deepEqual({ beforeTheBound, heard }, { beforeTheBound: [], heard: ['unread', ['Learn to sail']] });
    reading.close();
  } finally {
    a.close();
  }
});

test('the tree picker reads an address from the device’s copy, its own subscription dropped once read: a subtree by its step’s name, none for a deleted roadmap, and no answer as an unanswered read', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [{ key: 'sail', label: 'Learn to sail' }], links: [] })));
    const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail)));
    committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Tie a bowline' }, [])));
    committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Reef the sail' }, [])));
    const gone = committed(await a.runner.runAct(new CreateRoadmap('Learn to row', { steps: [], links: [] })));
    for (const id of [tree, subtree, gone.tree]) for (const scope of [RoadmapScopes.tree(id), RoadmapScopes.overlay(id)]) a.observe(scope);
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: true, error: false };
    const told = [];
    const address = (treeId) => new ReplicaReading({ treeId, timers: a.env.timers, track: (name, props) => told.push([name, props]),
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      repository: { loadProgress: async () => assert.fail('an address reads no marks'), loadActivity: async () => assert.fail('an address reads no activity') } });

    const inside = address(subtree);
    assert.deepEqual(await inside.readCard(), { id: subtree, title: 'Learn to sail', author: null, steps: 2, mine: true });
    inside.close();
    await until(() => !a.engine.openScopes.has(RoadmapScopes.tree(subtree)));

    const { DeleteRoadmap } = await import('../../../../src/products/roadmap/domain/roadmaps.js');
    committed(await a.runner.runAct(new DeleteRoadmap(gone.tree)));
    await a.advance(CONSTANTS.HOLD_MS);
    await a.sync();
    const nowhere = address(gone.tree);
    assert.equal(await nowhere.readCard(), null);
    nowhere.close();

    a.engine.setOnline(false);
    snapshot.online = false;
    const unanswered = address('t_00000000000000ab');
    await assert.rejects(unanswered.readCard(), (error) => error.status === 0);
    unanswered.close();
    assert.deepEqual(told, []);
  } finally {
    a.close();
  }
});

test('a reader’s room whose reads of the owner’s marks and of the activity fail opens on the steps’ seeds with no feed, and each failure reports once a visit under a server tree’s name', async (t) => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    // A stranger's browser: no roadmap of theirs in the list, so the roadmap is someone else's, read with its owner's marks.
    const nothing = { drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: true, firstPullComplete: true };
    const engine = Object.create(a.engine, { observe: { value: (scope) => {
      const hold = a.engine.observe(scope);
      if (scope !== RoadmapScopes.account) return hold;
      return { subscribe: (listener) => hold.subscribe(listener), getSnapshot: () => nothing, release: () => hold.release() };
    } } });
    const snapshot = { engine, ready: true, online: true, error: false };
    const asked = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      asked.push(String(url).split('/').at(-1));
      return { ok: false, status: 503, json: async () => ({ code: 'unavailable' }) };
    });
    const reports = [];
    const reported = new Set();
    const overlays = [];
    const feeds = [];
    for (const visit of ['opens', 'a sign-in reads it again']) {
      const reading = new ReplicaReading({ treeId: tree, timers: a.env.timers, reported, report: (operation, error) => reports.push([visit, operation, error ?? null]),
        session: { getSnapshot: () => snapshot, subscribe: () => () => {} } });
      overlays.push((await reading.read({ signal: new AbortController().signal })).overlay);
      reading.follow({ onTree: () => {}, onProgress: () => {}, onWorkspace: () => {}, onGuides: () => {}, onLanding: () => {}, onActivity: (events) => feeds.push(events) });
      await until(() => asked.length === overlays.length * 2);
      reading.close();
    }
    const seeds = { completed: new Set(), completedAt: {}, server: false };
    const activity = 'activity?since=0&limit=200';
    assert.deepEqual({ overlays, reports, asked, feeds }, {
      overlays: [seeds, seeds], reports: [['opens', 'roadmap-progress-load', null], ['opens', 'roadmap-activity-load', null]],
      asked: ['progress', activity, 'progress', activity], feeds: [],
    });
  } finally {
    a.close();
  }
});

test('a room asks the server for its roadmap’s activity only where the server holds the roadmap: the account’s own reports a lost read, and the browser’s own signed out is asked nothing', async (t) => {
  globalThis.document = { visibilityState: 'visible' };
  t.after(() => { delete globalThis.document; });
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(String(url).split('/').at(-1));
    throw new TypeError('Failed to fetch');
  });
  // The room's activity, as it follows a roadmap of `engine`'s, through the reading's own server reads.
  const activity = async (engine, tree) => {
    const reports = [];
    const snapshot = { engine, ready: true, online: true, error: false };
    const reading = new ReplicaReading({ treeId: tree, session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, report: (operation) => reports.push(operation) });
    const { seed } = await reading.read({ signal: new AbortController().signal });
    const from = asked.length;
    reading.follow({ onTree() {}, onProgress() {}, onWorkspace() {}, onGuides() {}, onLanding() {}, onActivity: () => assert.fail('a lost read brings no feed') });
    await until(() => reports.length === asked.length - from).catch(() => {});
    reading.close();
    return { state: engine.getSnapshot().state, mine: seed.mine, asked: asked.slice(from), reports };
  };

  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  let account;
  try {
    const { tree } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail', { steps: [{ key: 'wind', label: 'Read the wind' }], links: [] })));
    for (const scope of [RoadmapScopes.tree(tree), RoadmapScopes.overlay(tree)]) a.observe(scope);
    await a.sync();
    account = await activity(a.engine, tree);
  } finally {
    a.close();
  }

  const locks = new FakeLocks();
  const offline = { request: async () => { throw Object.assign(new TypeError('the server does not answer'), { kind: 'network' }); },
    openLive: () => ({ readyState: 0, send() {}, close() { this.readyState = 3; } }) };
  const browser = await BrowserSyncEngine.open({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, registry: roadmapRegistry, transport: offline, timers: globalThis,
    now: Date.now, monotonic: () => Math.floor(performance.now()), navigator: { onLine: true, locks, storage: { persist: async () => true } },
    document: null, window: null, leadership: { locks, channel: new FakeChannels().open }, telemetry: { event() {}, failure() {} } });
  t.after(() => browser.close());
  await browser.start();
  const runner = new ActionRunner(new EngineReplica(browser), roadmapRegistry, new FixedZone(0));
  const { tree } = committed(await runner.runAct(new CreateRoadmap('Learn to swim', { steps: [{ key: 'float', label: 'Float' }], links: [] })));
  const signedOut = await activity(browser, tree);

  assert.deepEqual({ account, signedOut }, {
    account: { state: 'bound', mine: true, asked: ['activity?since=0&limit=200'], reports: ['roadmap-activity-load'] },
    signedOut: { state: 'anon', mine: true, asked: [], reports: [] },
  });
});
