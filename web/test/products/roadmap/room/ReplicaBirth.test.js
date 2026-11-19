// A roadmap's birth on the device's copy (roadmap-on-the-engine.md §5 Create a roadmap, Signed out): the domain's creation
// on the replica the engine holds active, the browser's anon replica signed out and the account's signed in, with a
// plan's legend and the marks of the steps it brings done.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { RoadmapKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { StepMark } from '../../../../src/products/roadmap/domain/progress.js';
import { Roadmap, RoadmapMeta } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapScopes } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { RoadmapLink, RoadmapStep } from '../../../../src/products/roadmap/domain/steps.js';
import { ReplicaBirth } from '../../../../src/products/roadmap/room/ReplicaBirth.js';
import { environment } from '../../../platform/sync/fakes.js';
import { browserWith } from '../../gym/harness.mjs';

// A browser's engine on the composed registry, signed out until `signIn`, whose server answers only a hello, as A, an
// account that holds no roadmaps; and the session the shell publishes for it.
async function browser(t) {
  browserWith();
  const env = environment();
  const at = { wall: env.timers.time, mono: env.timers.time, boot: 'test' };
  env.transport.response = async (endpoint) => {
    if (endpoint !== 'hello') throw new Error('offline');
    return { response: hello({ state: env.state, registry, account: 'A', serverTime: env.timers.time }), timing: { send: at, recv: at } };
  };
  const engine = await BrowserSyncEngine.open({ ...env.options, registry, draw: (bound) => randomInt(bound) });
  t.after(() => engine.close());
  const session = { getSnapshot: () => ({ engine, ready: true, online: true, error: false }), subscribe: () => () => {} };
  const runner = new ActionRunner(new EngineReplica(engine), registry, new FixedZone(0));
  return { engine, session, runner, birth: new ReplicaBirth({ session, timers: env.timers }) };
}

// What the replica holds of one roadmap: whether the person's list holds it, its title, its kinds in their order, its
// steps (label, icon, colour, web links), each link between steps by their labels, and the steps marked complete.
function held(runner, tree) {
  const listed = runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn').some((roadmap) => String(roadmap.id.record) === tree));
  return runner.read(RoadmapScopes.tree(tree), (read) => {
    const steps = read.repository(RoadmapStep).all('drawn');
    const named = new Map(steps.map((step) => [String(step.id.record), step.label]));
    return {
      listed,
      title: read.repository(RoadmapMeta).find(new Id('meta', RoadmapMeta), 'drawn')?.title,
      kinds: read.repository(RoadmapKind).all('drawn').sort((a, b) => (a.ord < b.ord ? -1 : 1)).map((kind) => [kind.hue, kind.label, kind.description]),
      steps: steps.map((step) => [step.label, step.icon, step.color, step.links.map((link) => [link.url, link.label])]).sort(),
      links: read.repository(RoadmapLink).all('drawn').map((link) => [named.get(link.from), named.get(link.to)]).sort(),
      marked: runner.read(RoadmapScopes.overlay(tree), (overlay) => overlay.repository(StepMark).all('drawn')
        .filter((mark) => mark.status === 'complete').map((mark) => named.get(String(mark.id.record))).sort()),
    };
  });
}

test('signed out, a blank birth is the domain’s creation in the browser’s anon replica: its title, the genesis kinds and its named first step', async (t) => {
  const { runner, birth } = await browser(t);
  const { treeId, local } = await birth.plant({ title: 'Learn to sail', nodes: [{ id: 'root', label: 'Learn to sail', icon: 'sparkles', color: 'terracotta', prerequisites: [] }] });
  assert.deepEqual({ local, ...held(runner, treeId) }, {
    local: true, listed: true, title: 'Learn to sail',
    kinds: [['terracotta', 'Build', 'Things you make'], ['olive', 'Learn', 'Things you figure out'], ['gold', 'Milestone', 'Moments that matter']],
    steps: [['Learn to sail', 'sparkles', 'terracotta', []]], links: [], marked: [],
  });
});

test('a quest or a pasted plan is born whole: its legend in place of the genesis kinds, its links, its web links, and its done steps marked', async (t) => {
  const { runner, birth } = await browser(t);
  const { treeId, local } = await birth.plant({
    title: 'Learn to sail',
    kinds: [{ id: 'seamanship', hue: 'terracotta', label: 'Seamanship', description: 'Handling the boat' }, { id: 'weather', hue: 'sky', label: 'Weather', description: '' }],
    nodes: [
      { id: 'rig', label: 'Rig the boat', icon: 'sparkles', color: 'terracotta', prerequisites: [], status: 'complete', links: ['https://example.com/rig', '  '] },
      { id: 'wind', label: 'Read the wind', color: 'sky', prerequisites: ['rig'], links: [{ url: 'https://example.com/wind', label: 'Wind' }] },
      { id: 'solo', label: 'Sail solo', color: 'terracotta', prerequisites: ['rig', 'wind'], status: 'complete' },
    ],
  });
  assert.deepEqual({ local, ...held(runner, treeId) }, {
    local: true, listed: true, title: 'Learn to sail',
    kinds: [['terracotta', 'Seamanship', 'Handling the boat'], ['sky', 'Weather', '']],
    steps: [
      ['Read the wind', '', 'sky', [['https://example.com/wind', 'Wind']]],
      ['Rig the boat', 'sparkles', 'terracotta', [['https://example.com/rig', '']]],
      ['Sail solo', '', 'terracotta', []],
    ],
    links: [['Read the wind', 'Sail solo'], ['Rig the boat', 'Read the wind'], ['Rig the boat', 'Sail solo']],
    marked: ['Rig the boat', 'Sail solo'],
  });
});

test('a plan whose legend is the genesis kinds is born with them, under their own ids', async (t) => {
  const { runner, birth } = await browser(t);
  const { treeId } = await birth.plant({ title: 'Learn to row', nodes: [{ id: 'grip', label: 'Grip the oars', color: 'olive', prerequisites: [] }],
    kinds: [{ id: 'build', hue: 'terracotta', label: 'Build', description: 'Things you make' }, { id: 'learn', hue: 'olive', label: 'Learn', description: 'Things you figure out' },
      { id: 'milestone', hue: 'gold', label: 'Milestone', description: 'Moments that matter' }] });
  assert.deepEqual(runner.read(RoadmapScopes.tree(treeId), (read) => read.repository(RoadmapKind).all('drawn').map((kind) => String(kind.id.record)).sort()),
    ['build', 'learn', 'milestone']);
});

test('signed in, a birth is the account’s, which the engine sends', async (t) => {
  const { engine, runner, birth } = await browser(t);
  assert.equal((await engine.signIn('A')).complete, true);
  const { treeId, local } = await birth.plant({ title: 'Learn to swim', nodes: [{ id: 'root', label: 'Learn to swim', icon: 'sparkles', color: 'terracotta', prerequisites: [] }] });
  assert.deepEqual({ local, listed: held(runner, treeId).listed, state: engine.getSnapshot().state }, { local: false, listed: true, state: 'bound' });
});

test('a browser whose copy could not open plants nothing, and says so with no words of the person’s', async () => {
  const birth = new ReplicaBirth({ session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error: true }), subscribe: () => () => {} } });
  await assert.rejects(birth.plant({ title: 'Learn to sail', nodes: [] }), { message: 'the device’s copy did not open' });
});

test('a plan the domain refuses is not born', async (t) => {
  const { runner, birth } = await browser(t);
  await assert.rejects(birth.plant({ title: 'Learn to sail', nodes: [], kinds: [{ hue: 'sky', label: 'Weather' }, { hue: 'sky', label: 'Tides' }] }),
    { message: 'the birth was refused' });
  assert.deepEqual(runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn')), []);
});
