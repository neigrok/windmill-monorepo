import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../packages/api-contract/sync/reference/gym/product.js';
import { Refusal } from '../../../../packages/api-contract/sync/reference/server/admit.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { Id } from '../../../src/platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../src/platform/domain-kit/time.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { isVisible } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { Proposal, ProposeRoutine, REMOVAL_RECEIPTS } from '../../../src/products/gym/domain/proposals.js';
import { Routine, RoutineEntry, SetTarget } from '../../../src/products/gym/domain/routines.js';
import { Exercise } from '../../../src/products/gym/domain/catalogue.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { isStoreFailure } from '../../../src/products/gym/errors.js';
import { createGymApi, gymProposalResult } from '../../../src/products/gym/gymRuntime.js';
import { environment, until } from '../../platform/sync/fakes.js';

const scope = 'self/gym';
const routineId = 'routine0001';
const proposalId = 'proposal001';
const zone = new FixedZone(0);
const routine = { id: routineId, name: 'Lower A', position: 0,
  entries: [{ exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 80 }], restSeconds: 120 }] };

async function open(t, { removing = true } = {}) {
  const env = environment();
  const product = new GymProduct();
  const events = [], failures = [];
  env.transport.account = 'A';
  env.state.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [seed.id.record, seed.fields()]));
  env.transport.request = async (endpoint, request) => {
    env.requests.push({ endpoint, request });
    const account = env.transport.account;
    const now = env.timers.time;
    let response;
    if (endpoint === 'hello') response = hello({ state: env.state, registry, account, serverTime: now });
    else {
      const out = (endpoint === 'push' ? push : pull)({ state: env.state, registry, product, account, request, serverNow: now });
      env.state = out.state;
      response = out.response;
    }
    return { response, timing: {
      send: { wall: now, mono: now, boot: 'test' }, recv: { wall: now, mono: now, boot: 'test' },
    } };
  };
  const options = { ...env.options, registry, onPushResult: gymProposalResult };
  let engine = await BrowserSyncEngine.open(options);
  let runtime;
  const compose = () => {
    runtime = createGymApi(engine, {
      event: (operation, outcome) => events.push({ operation, outcome }), failure: (operation) => failures.push(operation), zone,
    });
  };
  const start = async () => {
    await engine.start();
    await until(() => engine.leader);
    engine.observe(scope);
  };
  const sync = async () => {
    await engine.send();
    await engine.pull();
    assert.deepEqual(engine.device.activeReplica.entries(), []);
  };
  const prepare = async ({ id = proposalId, parent = routineId, remove = removing } = {}) => {
    await runtime.createRoutine({ ...routine, id: parent });
    await sync();
    const runner = new ActionRunner(new EngineReplica(engine), registry, zone);
    const proposed = await runner.run(ProposeRoutine({
      id: new Id(id, Proposal), routineId: new Id(parent, Routine), name: remove ? '' : 'Lower B',
      entries: remove ? [] : [new RoutineEntry(new Id('back-squat', Exercise), [new SetTarget(3, 85)], 180)],
      summary: remove ? 'Remove this routine.' : 'Heavier triples next time.', removing: remove,
    }));
    assert.equal(proposed.kind, 'committed');
    await sync();
  };
  t.after(() => engine.close());
  await start();
  assert.equal((await engine.signIn('A')).complete, true);
  await until(() => engine.leader);
  compose();
  await prepare();
  events.length = 0;
  return {
    env, product, events, failures, sync, prepare,
    get engine() { return engine; },
    get runtime() { return runtime; },
    receipts: () => engine.device.activeReplica.deviceRows('gym')[REMOVAL_RECEIPTS] ?? {},
    visible: (type) => engine.observe(scope).getSnapshot().drawn.filter((row) => row.t === type && isVisible(registry.type(type), row)),
    reopen: async () => {
      engine.close();
      engine = await BrowserSyncEngine.open(options);
      await start();
      compose();
    },
    switchAccount: async (account) => {
      engine.setOnline(false);
      const question = await engine.beginSignOut();
      assert.equal((await engine.finishSignOut({ choice: 'keep', counted: question.counted })).complete, true);
      env.transport.account = account;
      engine.setOnline(true);
      assert.equal((await engine.signIn(account)).complete, true);
      await until(() => engine.leader);
      compose();
    },
  };
}

function failCommit(engine, count = 1) {
  const transact = engine.store.transact.bind(engine.store);
  engine.store.transact = (body, options) => {
    if (options?.readonly) return transact(body, options);
    count -= 1;
    if (count !== 0) return transact(body, options);
    engine.store.transact = transact;
    return transact((device) => {
      body(device);
      throw new DOMException('the disk is full', 'QuotaExceededError');
    }, options);
  };
}

test('an offline removal keeps one pending receipt and one command across repeat Apply and reopen', async (t) => {
  const a = await open(t);
  const before = await a.runtime.proposal(proposalId);
  const owner = a.engine.activeReplica();
  a.engine.setOnline(false);
  const requests = a.env.requests.length;
  const expected = { ...before, removalOutcome: 'pending', removalOwner: owner };
  assert.deepEqual(await Promise.all([a.runtime.applyProposal(proposalId), a.runtime.applyProposal(proposalId)]),
    [{ proposal: expected }, { proposal: expected }]);
  const queued = structuredClone(a.engine.device.activeReplica.entries());
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].intent.cmd, { name: 'gym.applyProposal', args: { proposalId } });
  assert.deepEqual(a.visible('routine'), []);
  await a.engine.send();
  assert.equal(a.env.requests.length, requests);
  assert.deepEqual(a.engine.device.activeReplica.entries(), queued);
  assert.deepEqual(await a.runtime.removalReceipts(), [expected]);
  await a.runtime.removalReceiptShown(proposalId, owner);
  assert.equal(a.receipts()[proposalId].status, 'pending');
  await a.reopen();
  assert.deepEqual(await a.runtime.removalReceipts(), [expected]);
  assert.deepEqual(await a.runtime.applyProposal(proposalId), { proposal: expected });
  assert.equal(a.engine.device.activeReplica.entries().length, 1);
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.env.failures, []);
  assert.deepEqual(a.events.slice(0, 2).sort((left, right) => left.outcome < right.outcome ? -1 : left.outcome > right.outcome ? 1 : 0), [
    { operation: 'proposal-apply', outcome: 'saved-local' },
    { operation: 'proposal-apply', outcome: 'unchanged' },
  ]);
  assert.deepEqual(a.events.slice(2), [{ operation: 'proposal-apply', outcome: 'unchanged' }]);
});

test('a failed Apply stores neither its prediction nor receipt, and retry commits both', async (t) => {
  const a = await open(t);
  const before = (await a.engine.store.read()).device.toJSON();
  const proposal = await a.runtime.proposal(proposalId);
  failCommit(a.engine);
  await assert.rejects(a.runtime.applyProposal(proposalId), isStoreFailure);
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.engine.device.toJSON(), before);
  assert.deepEqual(await a.runtime.proposal(proposalId), proposal);
  assert.deepEqual(await a.runtime.removalReceipts(), []);
  assert.deepEqual(a.events, [{ operation: 'proposal-apply', outcome: 'failed' }]);
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.env.failures, ['storage']);
  assert.equal((await a.runtime.applyProposal(proposalId)).proposal.removalOutcome, 'pending');
  assert.equal(a.engine.device.activeReplica.entries().length, 1);
  assert.equal(a.receipts()[proposalId].status, 'pending');
  assert.deepEqual(a.visible('routine'), []);
});

test('acceptance stays pending until pull, and the cascaded removal survives cold reopen until shown', async (t) => {
  const a = await open(t);
  const pending = (await a.runtime.applyProposal(proposalId)).proposal;
  await a.engine.send();
  assert.deepEqual(a.engine.device.activeReplica.entries().map(({ state }) => state), ['acked']);
  assert.equal(a.receipts()[proposalId].status, 'applied');
  assert.deepEqual(await a.runtime.removalReceipts(), [pending]);
  await a.runtime.removalReceiptShown(proposalId, pending.removalOwner);
  assert.equal(a.receipts()[proposalId].status, 'applied');
  await a.reopen();
  assert.deepEqual(await a.runtime.removalReceipts(), [pending]);
  await a.engine.pull();
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  assert.deepEqual(a.visible('routine'), []);
  assert.deepEqual(a.visible('proposal'), []);
  const applied = await a.runtime.proposal(proposalId);
  assert.equal(applied.removalOutcome, 'applied');
  assert.equal(applied.state, 'applied');
  assert.equal(applied.baseName, 'Lower A');
  assert.deepEqual(applied.changes, pending.changes);
  await a.reopen();
  assert.deepEqual(await a.runtime.removalReceipts(), [applied]);
  const persisted = structuredClone(a.receipts());
  failCommit(a.engine);
  await assert.rejects(a.runtime.removalReceiptShown(proposalId, applied.removalOwner), isStoreFailure);
  assert.deepEqual(a.receipts(), persisted);
  assert.deepEqual(await a.runtime.removalReceipts(), [applied]);
  await a.runtime.removalReceiptShown(proposalId, applied.removalOwner);
  assert.deepEqual(a.receipts(), {});
  assert.deepEqual(await a.runtime.removalReceipts(), []);
  assert.deepEqual(await a.runtime.proposal(proposalId), applied, 'the mounted review retains its shown receipt');
  await a.reopen();
  assert.deepEqual(await a.runtime.removalReceipts(), []);
  assert.equal(await a.runtime.proposal(proposalId), null);
});

test('a refused removal restores the routine and keeps the refusal through reopen, then retry replaces it', async (t) => {
  const a = await open(t);
  const apply = a.product.applyProposal.bind(a.product);
  let refuse = true;
  a.product.applyProposal = (...args) => {
    if (refuse) { refuse = false; throw new Refusal('proposal-superseded', { reason: 'routine-changed' }); }
    return apply(...args);
  };
  await a.runtime.applyProposal(proposalId);
  await a.sync();
  const refused = await a.runtime.proposal(proposalId);
  assert.equal(refused.removalOutcome, 'refused');
  assert.equal(refused.removalRefusal, 'That proposal has been superseded.');
  assert.deepEqual(a.visible('routine').map(({ id }) => id), [routineId]);
  assert.equal(a.receipts()[proposalId].status, 'refused');
  assert.equal(a.receipts()[proposalId].code, 'proposal-superseded');
  assert.deepEqual(a.receipts()[proposalId].detail, { reason: 'routine-changed' });
  await a.reopen();
  assert.deepEqual(await a.runtime.removalReceipts(), [refused]);
  const retried = (await a.runtime.applyProposal(proposalId)).proposal;
  assert.equal(retried.removalOutcome, 'pending');
  assert.equal(retried.removalRefusal, undefined);
  assert.deepEqual(Object.keys(a.receipts()[proposalId]).sort(), ['snapshot', 'status']);
  assert.equal(a.engine.device.activeReplica.entries().length, 1);
  await a.sync();
  const applied = await a.runtime.proposal(proposalId);
  assert.equal(applied.removalOutcome, 'applied');
  const accepted = structuredClone(a.receipts());
  await a.runtime.removalReceiptShown(proposalId, refused.removalOwner, refused.removalOutcome);
  assert.deepEqual(a.receipts(), accepted, 'an observer of the old refusal cannot consume the retry’s applied receipt');
  assert.deepEqual(await a.runtime.removalReceipts(), [applied]);
  await a.runtime.removalReceiptShown(proposalId, applied.removalOwner, applied.removalOutcome);
  assert.deepEqual(a.receipts(), {});
  assert.deepEqual(a.failures, []);
  assert.deepEqual(a.env.failures, []);
});

test('a failed push result transaction keeps the pending receipt and replays the accepted command after reopen', async (t) => {
  const a = await open(t);
  const pending = (await a.runtime.applyProposal(proposalId)).proposal;
  const snapshot = structuredClone(a.receipts());
  // Send writes its numbered command, offset sample, then the result and receipt together.
  failCommit(a.engine, 3);
  await a.engine.send();
  const sent = a.env.requests.filter(({ endpoint }) => endpoint === 'push').at(-1).request.intents;
  assert.deepEqual(a.engine.device.activeReplica.entries().map(({ state }) => state), ['sent']);
  assert.deepEqual(a.receipts(), snapshot);
  assert.deepEqual((await a.engine.store.read()).device.activeReplica.deviceRows('gym')[REMOVAL_RECEIPTS], snapshot);
  assert.deepEqual(await a.runtime.removalReceipts(), [pending]);
  assert.deepEqual(a.visible('routine'), []);
  assert.deepEqual(a.env.failures, ['storage', 'transport']);
  await a.reopen();
  assert.deepEqual(await a.runtime.applyProposal(proposalId), { proposal: pending });
  await a.sync();
  assert.deepEqual(a.env.requests.filter(({ endpoint }) => endpoint === 'push').at(-1).request.intents, sent);
  assert.equal((await a.runtime.proposal(proposalId)).removalOutcome, 'applied');
  assert.deepEqual(a.visible('routine'), []);
  assert.deepEqual(a.visible('proposal'), []);
});

for (const applying of [true, false]) test(`${applying ? 'revising' : 'dismissing a removal'} predicts once and creates no removal receipt`, async (t) => {
  const a = await open(t, { removing: !applying });
  const decide = () => applying ? a.runtime.applyProposal(proposalId) : a.runtime.dismissProposal(proposalId);
  const state = applying ? 'applied' : 'dismissed';
  const first = await decide();
  assert.equal(first.proposal.state, state);
  assert.deepEqual(await decide(), first);
  assert.equal(a.engine.device.activeReplica.entries().length, 1);
  assert.deepEqual(a.receipts(), {});
  assert.deepEqual(await a.runtime.removalReceipts(), []);
  await a.sync();
  assert.equal((await a.runtime.proposal(proposalId)).state, state);
  assert.deepEqual(a.visible('routine').map((row) => row.f.name[0]), [applying ? 'Lower B' : 'Lower A']);
  assert.deepEqual(a.events, [
    { operation: applying ? 'proposal-apply' : 'proposal-dismiss', outcome: 'saved-local' },
    { operation: applying ? 'proposal-apply' : 'proposal-dismiss', outcome: 'unchanged' },
  ]);
});

test('receipt acknowledgement from a previous account cannot clear the new account’s removal', async (t) => {
  const a = await open(t);
  await a.runtime.applyProposal(proposalId);
  await a.sync();
  const oldRuntime = a.runtime;
  const oldOwner = a.engine.activeReplica();
  const oldReceipt = structuredClone(a.receipts());
  await a.switchAccount('B');
  assert.deepEqual(await a.runtime.removalReceipts(), []);
  assert.deepEqual(a.engine.device.replicas.find((replica) => replica.id === oldOwner).deviceRows('gym')[REMOVAL_RECEIPTS], oldReceipt);
  await a.prepare({ id: 'proposal002', parent: 'routine0002' });
  await a.runtime.applyProposal('proposal002');
  await a.sync();
  const current = structuredClone(a.receipts());
  assert.notEqual(a.engine.activeReplica(), oldOwner);
  await assert.rejects(oldRuntime.removalReceiptShown(proposalId, oldOwner), { code: 'not-writable' });
  await a.runtime.removalReceiptShown('proposal002', oldOwner);
  assert.deepEqual(a.receipts(), current);
  await a.runtime.removalReceiptShown('proposal002', a.engine.activeReplica());
  assert.deepEqual(a.receipts(), {});
  assert.deepEqual(a.engine.device.replicas.find((replica) => replica.id === oldOwner).deviceRows('gym')[REMOVAL_RECEIPTS], oldReceipt);
});

for (const method of ['applyProposal', 'dismissProposal']) test(`${method} reports unexpected failures using only its operation`, async (t) => {
  const a = await open(t);
  const operation = method === 'applyProposal' ? 'proposal-apply' : 'proposal-dismiss';
  const before = a.engine.device.toJSON();
  t.mock.method(a.engine, 'commit', async () => { throw new Error('SECRET proposal content'); });
  await assert.rejects(a.runtime[method](proposalId), { message: 'SECRET proposal content' });
  assert.deepEqual(a.engine.device.toJSON(), before);
  assert.deepEqual(a.failures, [operation]);
  assert.deepEqual(a.events, [{ operation, outcome: 'failed' }]);
  assert.deepEqual(a.env.failures, []);
});
