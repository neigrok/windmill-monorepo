// Roadmap's part as the account changes on the device's copy (flow 50): the words of the sign-in question, naming the
// roadmaps of the person's list the signed-out work changes; the words of the sign-out question, where every unsent
// change is roadmap's; the work it lets the engine add without asking; and the sweep of the landing notes and told notices
// at sign-out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
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
  const words = accountChange.signInWords(engine, due, (name, props) => told.push([name, props]));
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
    told: [['roadmap_signin', { step: 'shown', roadmaps: '2-5' }], ['roadmap_signin', { step: 'add', roadmaps: '2-5' }]],
  });
});

test('one roadmap is asked of in the singular, and work that changes no roadmap the list holds is added without asking', async (t) => {
  const accountChange = await import('../../../../src/products/roadmap/sync/accountChange.js');
  const one = await device(t, { holdsRoadmaps: true });
  await one.plant('Learn to sail');
  const asked = roadmapDue(await one.engine.signIn('A'));
  const words = accountChange.signInWords(one.engine, asked, () => {});

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
  const words = accountChange.signOutWords(engine, question, (name, props) => told.push([name, props]));
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
  const madeWords = accountChange.signOutWords(engine, made);
  await engine.cancelSignOut();
  const composed = await runner.runComposed([new ChangeStep(sail.tree, step, { description: 'Watch the water' }), new MarkStep(sail.tree, step, 'complete')]);
  const scopes = new Set(engine.device.activeReplica.entries().slice(2).map((entry) => entry.scope));
  const both = await engine.beginSignOut();
  const bothWords = accountChange.signOutWords(engine, both);
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
  const cleanWords = accountChange.signOutWords(engine, clean);
  await engine.cancelSignOut();
  await plant('Learn to sail');
  const roadmapOnly = await engine.beginSignOut();
  const foreign = { ...roadmapOnly, unsent: roadmapOnly.unsent + 1, pending: 1, counted: [...roadmapOnly.counted, 'device:journal:claim:digest'] };
  assert.deepEqual({ clean: cleanWords, foreign: accountChange.signOutWords(engine, foreign), mine: accountChange.signOutWords(engine, roadmapOnly)?.title },
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
    await forgetReplicaRoom(engine);
    assert.deepEqual({ before, after: await rowsOf(), told: globalThis.window.localStorage.getItem('windmill:roadmap:kept-told') }, {
      before: choice === 'keep'
        ? [['anon', { 'landing:t_0000000000000002': note }], ['dormant', { 'landing:t_0000000000000001': note }]]
        : [['anon', { 'landing:t_0000000000000002': note }]],
      after: choice === 'keep' ? [['anon', {}], ['dormant', {}]] : [['anon', {}]],
      told: null,
    });
  });
}
