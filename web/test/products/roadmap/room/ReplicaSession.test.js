import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { until } from '../../../platform/sync/fakes.js';
import { roadmapRegistry } from '../domain/vectors.js';
import { CreateRoadmap, CreateSubtree } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { InadmissibleGuide } from '../../../../src/products/roadmap/guide/GuideDraft.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { ReplicaReading } from '../../../../src/products/roadmap/room/ReplicaReading.js';

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
