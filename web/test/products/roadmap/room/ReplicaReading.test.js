import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CreateRoadmap, CreateSubtree, WriteRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { CreateStep, DeleteStep } from '../../../../src/products/roadmap/domain/steps.js';
import { Complete, SetPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { AddStepLink, AddSubtask } from '../../../../src/products/roadmap/domain/workspace.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { FIRST_COPY_MS, ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';

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
      onProgress: (marks) => followed.push(['marks', [...marks.completed], marks.completedAt]), onWorkspace: () => {}, onGuides: () => {}, onActivity: () => {} });

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
    assert.equal(await open(subtree).read({ signal: new AbortController().signal }), null);
  } finally {
    a.close();
  }
});

test('the room subscribes the roadmap it opens and drops it on leaving; with no copy, offline, it says so at once, and online after the bound', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    await a.sync();
    const snapshot = { engine: a.engine, ready: true, online: false, error: false };
    const offline = new ReplicaReading({ treeId: 't_00000000000000aa', timers: a.env.timers,
      session: { getSnapshot: () => snapshot, subscribe: () => () => {} }, repository: { loadActivity: async () => [] } });
    assert.equal(await offline.read({ signal: new AbortController().signal }), null);
    assert.equal(a.engine.openScopes.has('tree/t_00000000000000aa'), true);
    offline.close();
    await until(() => !a.engine.openScopes.has('tree/t_00000000000000aa'));

    snapshot.online = true;
    const waiting = new ReplicaReading({ treeId: 't_00000000000000ab', timers: a.env.timers,
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
  } finally {
    a.close();
  }
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
