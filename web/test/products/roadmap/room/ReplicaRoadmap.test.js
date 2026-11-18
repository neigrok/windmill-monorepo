import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CreateRoadmap, CreateSubtree } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { CreateStep } from '../../../../src/products/roadmap/domain/steps.js';
import { Complete, SetPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { HeldRoadmap, ReplicaRoadmap } from '../../../../src/products/roadmap/room/ReplicaRoadmap.js';

const committed = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

test('a roadmap someone else owns reads as theirs: no pointer and no workspace, its subtrees unread, and its place from the roadmaps above it', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree, steps } = committed(await a.runner.runAct(new CreateRoadmap('My year', { steps: [
      { key: 'sail', label: 'Learn to sail' }, { key: 'book', label: 'Write the book' },
    ], links: [] })));
    const { subtree } = committed(await a.runner.runAct(new CreateSubtree(tree, steps.sail)));
    const knot = committed(await a.runner.runAct(new CreateStep(subtree, { label: 'Tie a bowline' }, [])));
    committed(await a.runner.runAct(Complete(subtree, knot)));
    committed(await a.runner.runAct(SetPointer(tree, steps.book, tree)));
    const held = (id) => new HeldRoadmap({ id, tree: a.engine.observe(RoadmapScopes.tree(id)).getSnapshot().drawn });

    const root = new ReplicaRoadmap(roadmapRegistry, tree, [held(tree)]);
    const sail = root.seed.nodes.find((step) => step.id === steps.sail).opening;
    assert.deepEqual({ state: root.state, mine: root.mine, workspace: root.workspace,
      sail: { treeId: sail.treeId, read: sail.read, owned: sail.owned, face: sail.face },
      book: root.seed.nodes.find((step) => step.id === steps.book) },
    { state: 'open', mine: false, workspace: {},
      sail: { treeId: subtree, read: false, owned: true, face: 'unread' },
      book: { id: steps.book, label: 'Write the book', icon: '', color: 'terracotta', order: 'a1',
        createdAt: { ms: 1_800_000_000_000, counter: 1, actor: 'r_000000000002' }, createdMs: null, prerequisites: [],
        status: undefined, description: undefined, links: undefined, opens: undefined } });

    assert.equal(new ReplicaRoadmap(roadmapRegistry, subtree, [held(subtree)]).state, 'waiting', 'where it stands waits for the roadmap above it');
    const inside = new ReplicaRoadmap(roadmapRegistry, subtree, [held(subtree), held(tree)]);
    assert.deepEqual({ state: inside.state, title: inside.seed.title, place: { ...inside.seed.place }, visibility: inside.seed.visibility,
      steps: inside.seed.nodes.map((step) => step.label) }, {
      state: 'open', title: 'Learn to sail', visibility: 'private', steps: ['Tie a bowline'],
      place: { root: tree, parent: { tree, step: steps.sail }, path: [{ tree, step: steps.sail, title: 'My year' }], depth: 1 },
    });
    assert.equal(new ReplicaRoadmap(roadmapRegistry, tree, [held(tree)], { listRead: false }).state, 'waiting',
      'a roadmap not in a list the device has not read may yet be the person’s own');
    assert.equal(new ReplicaRoadmap(roadmapRegistry, 't_00000000000000aa', [new HeldRoadmap({ id: 't_00000000000000aa' })]).state, 'missing');
  } finally {
    a.close();
  }
});

test('of two kinds that wear one hue, the legend shows the one born first', async () => {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  try {
    const { tree } = committed(await a.runner.runAct(new CreateRoadmap('Learn to sail')));
    const scope = RoadmapScopes.tree(tree);
    const records = a.engine.observe(scope).getSnapshot().drawn;
    const build = records.find((record) => record.t === RoadmapKind.type && record.id === 'build');
    const twin = { ...build, id: 'twin', born: '1900000000000:0:r_other', f: { ...build.f, label: ['Make', build.f.label[1]] } };
    const read = new ReplicaRoadmap(roadmapRegistry, tree, [new HeldRoadmap({ id: tree, tree: [...records, twin] })]);
    assert.deepEqual(read.seed.kinds.map((kind) => kind.id), ['build', 'learn', 'milestone']);
  } finally {
    a.close();
  }
});
