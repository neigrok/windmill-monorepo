// A roadmap's birth on the device's copy (roadmap-on-the-engine.md §5 Create a roadmap, Signed out): the domain's creation
// on the replica the engine holds active, the browser's anon replica signed out and the account's signed in, with a
// plan's legend and the marks of the steps it brings done; and what a birth that did not stand whole came to, and how its
// door reports it.

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
import { BirthFailure, ReplicaBirth } from '../../../../src/products/roadmap/room/ReplicaBirth.js';
import { FIRST_COPY_MS } from '../../../../src/products/roadmap/room/ReplicaReading.js';
import { FakeTimers, environment, until } from '../../../platform/sync/fakes.js';
import { browserWith } from '../../gym/harness.mjs';

// A browser's engine on the composed registry, signed out until `signIn`, whose server answers only a hello, as A, an
// account that holds no roadmaps; the session the shell publishes for it; and the failures its births report.
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
  const reported = [];
  const report = (operation, error, tags) => reported.push([operation, error instanceof BirthFailure ? error.reason : error.message, tags]);
  return { engine, session, runner, reported, birth: new ReplicaBirth({ session, timers: env.timers, report }) };
}

const sail = (status) => ({ title: 'Learn to sail', nodes: [{ id: 'rig', label: 'Rig the boat', icon: 'sparkles', color: 'terracotta', prerequisites: [], status }] });

// The engine's commits, with `between` run once the first of them, the birth's creation, has committed.
function afterCreation(engine, between) {
  const commitAct = engine.commitAct.bind(engine);
  let first = true;
  engine.commitAct = async (...args) => {
    const answer = await commitAct(...args);
    if (first) {
      first = false;
      await between();
    }
    return answer;
  };
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

test('a browser whose copy could not open plants nothing, and one whose copy did not open within the bound plants nothing after it: each says why with no words of the person’s', async () => {
  const timers = new FakeTimers();
  const opening = (error) => new ReplicaBirth({ timers, session: { getSnapshot: () => ({ engine: null, ready: false, online: true, error }), subscribe: () => () => {} } });
  await assert.rejects(opening(true).plant(sail()), { name: 'BirthFailure', reason: 'unkept', message: 'the birth on the device’s copy did not stand whole' });
  let answered = 'pending';
  opening(false).plant(sail()).catch((error) => { answered = error.reason; });
  timers.advance(FIRST_COPY_MS - 1);
  await until(() => true);
  assert.equal(answered, 'pending');
  timers.advance(1);
  await until(() => answered !== 'pending');
  assert.equal(answered, 'unopened');
});

test('a plan the domain refuses is not born: two kinds of one hue, and a name past its bound', async (t) => {
  const { runner, birth, reported } = await browser(t);
  await assert.rejects(birth.plant({ title: 'Learn to sail', nodes: [], kinds: [{ hue: 'sky', label: 'Weather' }, { hue: 'sky', label: 'Tides' }] }),
    { name: 'BirthFailure', reason: 'refused' });
  await assert.rejects(birth.plant({ title: 'a'.repeat(210), nodes: [] }), { name: 'BirthFailure', reason: 'refused' });
  assert.deepEqual({ listed: runner.read(RoadmapScopes.account, (read) => read.repository(Roadmap).all('drawn')), reported }, { listed: [], reported: [] });
});

test('a roadmap whose creation committed is born, though its done steps cannot be marked: the birth answers it once, and the marks report alone', async (t) => {
  const { engine, birth, reported } = await browser(t);
  await engine.signIn('A');
  afterCreation(engine, () => engine.finishSignOut({ choice: 'keep' }));
  const { treeId, local } = await birth.plant(sail('complete'));
  assert.deepEqual({ local, reported, replicas: engine.device.replicas.map((replica) => [replica.meta.state, replica.entries().some((entry) => entry.scope === RoadmapScopes.tree(treeId))]) }, {
    local: false, reported: [['roadmap-plant', 'marks', { reason: 'marks' }]], replicas: [['anon', false], ['dormant', true]],
  });
});

test('a birth begun signed out is told as the anon replica’s, though a sign-in completes before its marks', async (t) => {
  const { engine, runner, birth, reported } = await browser(t);
  afterCreation(engine, () => engine.signIn('A'));
  const { treeId, local } = await birth.plant(sail('complete'));
  assert.deepEqual({ local, reported, state: engine.getSnapshot().state, marked: held(runner, treeId).marked }, { local: true, reported: [], state: 'bound', marked: ['Rig the boat'] });
});

test('a door reports a failed birth as ours only where it is, with its reason, and any other failure as unexpected', () => {
  const reported = [];
  const report = (operation, error, tags) => reported.push([operation, error.reason ?? error.message, tags]);
  for (const reason of BirthFailure.REASONS) BirthFailure.reportFailed(new BirthFailure(reason), report);
  BirthFailure.reportFailed(new Error('the server is down'), report);
  assert.deepEqual({ reported, reasons: [...BirthFailure.REASONS, null].map((reason) => BirthFailure.reasonOf(reason ? new BirthFailure(reason) : new Error('x'))) }, {
    reported: [['roadmap-plant', 'unopened', { reason: 'unopened' }], ['roadmap-plant', 'marks', { reason: 'marks' }], ['roadmap-plant', 'the server is down', undefined]],
    reasons: ['unkept', 'unopened', 'refused', 'marks', undefined],
  });
  assert.throws(() => new BirthFailure('tired'), TypeError);
});
