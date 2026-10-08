import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../packages/api-contract/sync/reference/gym/product.js';
import { Refusal } from '../../../../packages/api-contract/sync/reference/server/admit.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { steadyTiming } from '../../../../packages/api-contract/sync/reference/core/clock.js';
import { nextPush, onPushResponse } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { onPullResponse, pullRequest } from '../../../../packages/api-contract/sync/reference/client/puller.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { GymRefusal, isStoreFailure } from '../../../src/products/gym/errors.js';
import * as gymRuntime from '../../../src/products/gym/gymRuntime.js';
import { gymRoutes } from '../../../src/products/gym/routes.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { environment } from '../../platform/sync/fakes.js';
import { confirmed } from './harness.mjs';

const SCOPE = 'self/gym';
const SAVES = 'rack:workoutDrafts';
const NOW = 1_800_000_000_000;
const draftKey = 'backfill';
const input = { id: 'session00001', startedAt: NOW - 60_000, finishedAt: NOW - 1_000,
  sets: [{ id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: NOW - 5_000 }] };
const rawDraft = { date: '2027-01-15', startTime: '07:59', duration: '  59 ', unit: 'kg', routineName: 'Private session',
  groups: [{ id: 'group1', exerciseId: 'bench-press', sets: [{ id: 'set00000001', weight: '060,000', reps: '05',
    rpe: '7,5', note: ' Private e\u0301 words\n', kind: 'drop' }] }] };
const correction = { requestId: 'request00001', startedAt: input.startedAt, finishedAt: input.finishedAt, routineName: 'Corrected',
  sets: [{ ...input.sets[0], setNumber: 1, reps: 6 }] };

async function open(t, product = new GymProduct()) {
  const env = environment();
  env.timers.time = NOW;
  env.state.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  let account = 'A';
  env.transport.request = async () => ({ response: hello({ state: env.state, registry, account, serverTime: NOW }), timing: steadyTiming(NOW, NOW) });
  const events = [], failures = [], engines = new Set();
  const apiFor = (engine) => gymRuntime.createGymApi(engine, {
    event: (operation, outcome) => events.push({ operation, outcome }), failure: (operation) => failures.push(operation),
  });
  const options = { ...env.options, registry, onPushResult: (...args) => gymRuntime.gymCommandResult?.(...args) };
  const device = async () => {
    const engine = await BrowserSyncEngine.open(options);
    engines.add(engine);
    engine.observe(SCOPE);
    return engine;
  };
  let engine = await device();
  assert.equal((await engine.signIn(account)).complete, true);
  let api = apiFor(engine);
  t.after(() => { for (const each of engines) each.close(); });
  const pullOnce = async () => {
    const request = pullRequest(engine.device.activeReplica, registry, [SCOPE]);
    const result = pull({ state: env.state, registry, product, account, request, serverNow: NOW });
    env.state = result.state;
    await engine.write(null, (device, context) => onPullResponse(device.activeReplica, context, request, result.response, steadyTiming(NOW, NOW)), [SCOPE]);
  };
  return {
    env, events, failures, get engine() { return engine; }, get api() { return api; },
    reopen: async () => { engine.close(); engine = await device(); api = apiFor(engine); return api; },
    peer: async () => { const peer = await device(); return { engine: peer, api: apiFor(peer) }; },
    land: (...rows) => engine.write(null, (device) => rows.forEach((row, index) => device.activeReplica.putConfirmed(SCOPE, { ...row, seq: index + 1 })), [SCOPE]),
    next: () => engine.write(null, (device, context) => nextPush(device.activeReplica, context)),
    async pushOne() {
      const request = await this.next();
      assert.ok(request, 'a pending command must reach the sender');
      const result = push({ state: env.state, registry, product, account, request, serverNow: NOW });
      env.state = result.state;
      await engine.pushResults(engine.device.activeReplica.storageHandle, request, result.response, steadyTiming(NOW, NOW));
      return result.response;
    },
    async sync() {
      for (let round = 0; round < 20; round += 1) {
        if (!engine.device.activeReplica.entries().some((entry) => ['ready', 'sent'].includes(entry.state))) { await pullOnce(); return; }
        await this.pushOne();
        await pullOnce();
      }
      assert.fail('the workout did not settle');
    },
    async switchAccount(next) {
      engine.online = false;
      await engine.beginSignOut();
      await engine.finishSignOut({ choice: 'keep' });
      account = next;
      assert.equal((await engine.signIn(account)).complete, true);
      api = apiFor(engine);
      return api;
    },
  };
}

function savedReceipt(api, key = draftKey) {
  const receipt = api.workoutSave(key);
  assert.ok(receipt);
  assert.equal(receipt instanceof Promise, false, 'the snapshot read is synchronous');
  return receipt;
}

function commands(engine) { return engine.device.activeReplica.entries().filter((entry) => entry.intent.cmd).map((entry) => entry.intent.cmd); }

test('the gym route sends engine command results to the combined receipt hook', () => {
  assert.equal(typeof gymRuntime.gymCommandResult, 'function');
  assert.equal(gymRoutes.sync.onPushResult, gymRuntime.gymCommandResult);
});

test('workout input and its exact raw draft commit together and remain pending across reopen', async (t) => {
  const h = await open(t);
  const typed = structuredClone(rawDraft);
  await h.api.importSession(input, { draftKey, draft: typed });
  typed.groups[0].sets[0].note = 'Changed after submitting';
  const receipt = savedReceipt(h.api);
  const { error, ...value } = receipt;
  assert.equal(error, null);
  assert.deepEqual(value, { status: 'pending', sessionId: input.id, draft: rawDraft, command: { name: 'gym.importSession', args: input } });
  assert.deepEqual(h.engine.device.activeReplica.deviceRows('gym')[SAVES], { [draftKey]: value });
  await h.api.clearWorkoutSave(draftKey);
  assert.deepEqual(savedReceipt(h.api), receipt, 'pending input cannot be acknowledged away');
  await h.reopen();
  assert.deepEqual(savedReceipt(h.api), receipt);
  assert.deepEqual(commands(h.engine), [receipt.command]);
});

test('two tabs sharing IndexedDB preflight overlapping backfills inside the write lock', async (t) => {
  const h = await open(t);
  const peer = await h.peer();
  const other = { ...input, id: 'session00002', sets: [{ ...input.sets[0], id: 'set00000002' }] };
  const results = await Promise.allSettled([
    h.api.importSession(input, { draftKey: 'first', draft: rawDraft }),
    peer.api.importSession(other, { draftKey: 'second', draft: { ...rawDraft, routineName: 'Second private workout' } }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const refused = results.find((result) => result.status === 'rejected');
  assert.ok(refused?.status === 'rejected' && refused.reason instanceof GymRefusal);
  assert.equal(refused.reason.code, 'session-overlap');
  await h.engine.refresh(true);
  await peer.engine.refresh(true);
  assert.equal(commands(h.engine).length, 1);
  assert.deepEqual(commands(peer.engine), commands(h.engine));
  assert.equal(Object.keys(h.engine.device.activeReplica.deviceRows('gym')[SAVES]).length, 1);
});

test('future workout times refuse before command or raw draft persistence', async (t) => {
  const h = await open(t);
  await assert.rejects(h.api.importSession({ ...input, finishedAt: NOW + 1 }, { draftKey, draft: rawDraft }), { code: 'bad-instant' });
  assert.deepEqual(commands(h.engine), []);
  assert.equal(h.engine.device.activeReplica.deviceRows('gym')[SAVES], undefined);
  assert.deepEqual(h.failures, []);
});

test('an identical pending save reuses its command and original draft while a different payload refuses', async (t) => {
  const h = await open(t);
  const first = await h.api.importSession(input, { draftKey, draft: rawDraft });
  const receipt = savedReceipt(h.api);
  const retried = await h.api.importSession(structuredClone(input), { draftKey, draft: { ...rawDraft, duration: 'changed after submit' } });
  assert.deepEqual(retried, first);
  assert.deepEqual(savedReceipt(h.api), receipt);
  assert.deepEqual(commands(h.engine), [receipt.command]);
  await assert.rejects(h.api.importSession({ ...input, sets: [{ ...input.sets[0], reps: 8 }] }, { draftKey, draft: rawDraft }), { code: 'save-pending' });
  assert.deepEqual(savedReceipt(h.api), receipt);
  assert.deepEqual(commands(h.engine), [receipt.command]);
});

test('server acceptance settles the durable receipt and acknowledgement cannot clear a newer submission', async (t) => {
  const h = await open(t);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const pending = savedReceipt(h.api);
  await h.sync();
  const first = savedReceipt(h.api);
  assert.deepEqual(first, { ...pending, status: 'accepted' });
  assert.deepEqual(commands(h.engine), []);
  await h.reopen();
  assert.deepEqual(savedReceipt(h.api), first);
  const next = { id: 'session00002', startedAt: NOW - 120_000, finishedAt: NOW - 90_000,
    sets: [{ ...input.sets[0], id: 'set00000002', completedAt: NOW - 100_000 }] };
  await h.api.importSession(next, { draftKey, draft: { ...rawDraft, duration: '30' } });
  await h.sync();
  const second = savedReceipt(h.api);
  assert.equal(second.status, 'accepted');
  assert.equal(second.sessionId, next.id);
  await h.api.clearWorkoutSave(draftKey, first.command);
  assert.deepEqual(savedReceipt(h.api), second);
  await h.api.clearWorkoutSave(draftKey, second.command);
  assert.equal(h.api.workoutSave(draftKey), null);
  await h.reopen();
  assert.equal(h.api.workoutSave(draftKey), null);
});

test('a late overlap refusal keeps exact raw input across restart and resolves the conflicting session document', async (t) => {
  const product = new GymProduct();
  const runCommand = product.runCommand.bind(product);
  const conflict = { id: 'session00002', startedAt: NOW - 50_000, finishedAt: NOW - 10_000, routineName: 'Another private session' };
  let refuse = true;
  product.runCommand = (context, command) => {
    if (refuse && command.name === 'gym.importSession') { refuse = false; throw new Refusal('session-overlap', { sessionId: conflict.id }); }
    return runCommand(context, command);
  };
  const h = await open(t, product);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const before = savedReceipt(h.api);
  await h.land(confirmed('session', conflict.id, { startedAt: conflict.startedAt, finishedAt: conflict.finishedAt, closedBy: 'finish', displayName: conflict.routineName }));
  const response = await h.pushOne();
  assert.equal(response.body.results[0].code, 'session-overlap');
  assert.deepEqual(commands(h.engine), []);
  for (const reopened of [false, true]) {
    if (reopened) await h.reopen();
    const { error, ...receipt } = savedReceipt(h.api);
    assert.deepEqual(receipt, { ...Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'error')),
      status: 'refused', code: 'session-overlap', detail: { sessionId: conflict.id } });
    assert.ok(error instanceof GymRefusal);
    assert.equal(error.code, 'session-overlap');
    assert.deepEqual(error.overlapping, conflict);
  }
  assert.equal((await h.api.session(input.id)), null, 'a refused prediction leaves no phantom session');
  assert.equal(JSON.stringify({ events: h.events, failures: h.failures, engineEvents: h.env.events, engineFailures: h.env.failures }).includes('Private'), false);
});

test('a refused correction retries its original request identity and opaque draft unchanged', async (t) => {
  const product = new GymProduct();
  const runCommand = product.runCommand.bind(product);
  let refuse = true;
  product.runCommand = (context, command) => {
    if (refuse && command.name === 'gym.correctSession') { refuse = false; throw new Refusal('session-overlap', { sessionId: 'session00002' }); }
    return runCommand(context, command);
  };
  const h = await open(t, product);
  await h.api.importSession(input);
  await h.sync();
  const key = `correction:${input.id}`;
  await h.api.correctSession(input.id, correction, { draftKey: key, draft: rawDraft });
  const pending = savedReceipt(h.api, key);
  assert.deepEqual(pending.command, { name: 'gym.correctSession', args: { sessionId: input.id, ...correction } });
  await h.pushOne();
  assert.equal(savedReceipt(h.api, key).status, 'refused');
  await h.reopen();
  await h.api.correctSession(input.id, correction, { draftKey: key, draft: rawDraft });
  assert.deepEqual(savedReceipt(h.api, key), pending);
  assert.deepEqual(commands(h.engine), [pending.command]);
  await h.api.correctSession(input.id, correction, { draftKey: key, draft: { ...rawDraft, duration: 'later typing' } });
  assert.deepEqual(commands(h.engine), [pending.command]);
  assert.deepEqual(savedReceipt(h.api, key).draft, rawDraft);
  await h.sync();
  assert.equal(savedReceipt(h.api, key).status, 'accepted');
  assert.equal((await h.api.session(input.id)).sets[0].reps, 6);
});

test('transient clock and base refusals leave the sent workout receipt pending', async (t) => {
  const h = await open(t);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const before = savedReceipt(h.api);
  const request = await h.next();
  assert.equal(typeof gymRuntime.gymWorkoutResult, 'function');
  for (const code of ['clock-skew', 'base-unknown']) {
    await h.engine.write(null, (device, context) => gymRuntime.gymWorkoutResult(device.activeReplica, context,
      { n: request.intents[0].n, s: 'refused', code }, { epoch: 'ep-1', serverTime: NOW }), [SCOPE]);
    assert.deepEqual(savedReceipt(h.api), before);
  }
  await h.sync();
  assert.equal(savedReceipt(h.api).status, 'accepted');
});

for (const [status, code] of [[400, 'invalid'], [413, 'too-large']]) test(`HTTP ${status} recovers a settled refusal from the durable notice without a result hook`, async (t) => {
  const h = await open(t);
  const weighted = { ...input, sets: [{ ...input.sets[0], weightKg: 60.125 }] };
  await h.api.importSession(weighted, { draftKey, draft: rawDraft });
  const request = await h.next();
  await h.engine.write(null, (device, context) => onPushResponse(device.activeReplica, context, request,
    { status, body: { epoch: 'ep-1', serverTime: NOW } }, steadyTiming(NOW, NOW)), [SCOPE]);
  assert.deepEqual(commands(h.engine), []);
  await h.reopen();
  const receipt = savedReceipt(h.api);
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.code, code);
  assert.equal(receipt.command.args.sets[0].weightKg, 60.125, 'the raw receipt matches its normalized command notice by identity');
  assert.deepEqual(receipt.draft, rawDraft);
  assert.ok(receipt.error instanceof GymRefusal);
  assert.equal(receipt.error.code, code);
  await h.api.clearWorkoutSave(draftKey, receipt.command);
  assert.equal(h.api.workoutSave(draftKey), null);
});

test('failed storage rolls back the receipt with its command and reports only bounded operation labels', async (t) => {
  const h = await open(t);
  const before = (await h.engine.store.read()).device.toJSON();
  const transact = h.engine.store.transact.bind(h.engine.store);
  h.engine.store.transact = () => { h.engine.store.transact = transact; return Promise.reject(new DOMException('Private session detail', 'QuotaExceededError')); };
  await assert.rejects(h.api.importSession(input, { draftKey, draft: rawDraft }), isStoreFailure);
  assert.deepEqual((await h.engine.store.read()).device.toJSON(), before);
  assert.equal(h.api.workoutSave(draftKey), null);
  assert.deepEqual(commands(h.engine), []);
  assert.deepEqual(h.env.failures, ['storage']);
  assert.deepEqual(h.failures, []);
  assert.deepEqual(h.events, [{ operation: 'session-import', outcome: 'failed' }]);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  assert.deepEqual(savedReceipt(h.api).draft, rawDraft);
  assert.equal(JSON.stringify({ events: h.events, failures: h.failures, engineEvents: h.env.events, engineFailures: h.env.failures }).includes('Private'), false);
});

test('account changes retain the draft only for its owner and reject a stale account handle', async (t) => {
  const h = await open(t);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const owner = h.api;
  const before = savedReceipt(owner);
  await h.switchAccount('B');
  assert.equal(h.api.workoutSave(draftKey), null);
  assert.throws(() => owner.workoutSave(draftKey), { code: 'not-writable' });
  await assert.rejects(owner.importSession(input, { draftKey, draft: rawDraft }), { code: 'not-writable' });
  await assert.rejects(owner.clearWorkoutSave(draftKey), { code: 'not-writable' });
  assert.deepEqual(commands(h.engine), []);
  assert.equal(h.engine.device.activeReplica.deviceRows('gym')[SAVES], undefined);
  await h.switchAccount('A');
  assert.deepEqual(savedReceipt(h.api), before);
  assert.deepEqual(commands(h.engine), [before.command]);
});

test('a late accepted response settles the dormant owner receipt without exposing it to the active account', async (t) => {
  const product = new GymProduct();
  const h = await open(t, product);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const pending = savedReceipt(h.api);
  const request = await h.next();
  const handle = h.engine.device.activeReplica.storageHandle;
  const result = push({ state: h.env.state, registry, product, account: 'A', request, serverNow: NOW });
  h.env.state = result.state;
  await h.switchAccount('B');
  await h.engine.pushResults(handle, request, result.response, steadyTiming(NOW, NOW));
  assert.equal(h.api.workoutSave(draftKey), null);
  assert.deepEqual(commands(h.engine), []);
  assert.equal(h.engine.device.activeReplica.deviceRows('gym')[SAVES], undefined);
  await h.switchAccount('A');
  assert.deepEqual(savedReceipt(h.api), { ...pending, status: 'accepted' });
});

for (const mode of ['closed', 'open', 'pending']) test(`runtime preflight refuses a ${mode} overlapping workout without writing`, async (t) => {
  const h = await open(t);
  const conflict = { ...input, id: 'session00002', sets: [{ ...input.sets[0], id: 'set00000002' }] };
  if (mode === 'pending') await h.api.importSession(conflict);
  else await h.land(confirmed('session', conflict.id, { startedAt: conflict.startedAt,
    ...(mode === 'closed' ? { finishedAt: conflict.finishedAt, closedBy: 'finish' } : {}) }));
  const before = (await h.engine.store.read()).device.toJSON();
  await assert.rejects(h.api.importSession(input, { draftKey, draft: rawDraft }), (error) => {
    assert.ok(error instanceof GymRefusal);
    assert.equal(error.code, 'session-overlap');
    assert.equal(error.overlapping?.id, conflict.id);
    return true;
  });
  assert.deepEqual((await h.engine.store.read()).device.toJSON(), before);
  assert.equal(h.api.workoutSave(draftKey), null);
});

test('backfill preflight uses the same stale close as the workout shown in the log', async (t) => {
  const h = await open(t);
  const startedAt = NOW - 86_400_000;
  const completedAt = startedAt + 60_000;
  await h.land(confirmed('session', 'sessionStale', { startedAt }),
    confirmed('set', 'setStale0001', { sessionId: 'sessionStale', exerciseId: 'bench-press',
      setNumber: 1, weightKg: 60, reps: 5, completedAt }));
  assert.equal((await h.api.session('sessionStale')).session.finishedAt, completedAt);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  assert.deepEqual(commands(h.engine), [{ name: 'gym.importSession', args: input }]);
  assert.equal(savedReceipt(h.api).status, 'pending');
  assert.equal((await h.api.session('sessionStale')).session.finishedAt, completedAt);
});

for (const target of ['missing', 'open']) test(`correction preflight requires an existing finished target: ${target}`, async (t) => {
  const h = await open(t);
  if (target === 'open') await h.land(confirmed('session', input.id, { startedAt: input.startedAt }));
  const before = (await h.engine.store.read()).device.toJSON();
  await assert.rejects(h.api.correctSession(input.id, correction, { draftKey, draft: rawDraft }),
    { code: target === 'open' ? 'session-open' : 'unknown-record' });
  assert.deepEqual((await h.engine.store.read()).device.toJSON(), before);
  assert.equal(h.api.workoutSave(draftKey), null);
});

test('correction preflight checks future times, interval geometry and overlaps while excluding its own session', async (t) => {
  const h = await open(t);
  await h.api.importSession(input);
  await h.sync();
  const other = { id: 'session00002', startedAt: NOW - 120_000, finishedAt: NOW - 90_000 };
  await h.land(confirmed('session', other.id, { startedAt: other.startedAt, finishedAt: other.finishedAt, closedBy: 'finish' }));
  for (const [changed, code] of [
    [{ ...correction, finishedAt: NOW + 1 }, 'bad-instant'],
    [{ ...correction, startedAt: NOW - 1, finishedAt: NOW - 2 }, 'bad-instant'],
    [{ ...correction, sets: [{ ...correction.sets[0], completedAt: input.finishedAt + 1 }] }, 'bad-instant'],
    [{ ...correction, startedAt: other.startedAt, finishedAt: other.finishedAt,
      sets: [{ ...correction.sets[0], completedAt: other.startedAt + 1 }] }, 'session-overlap'],
  ]) {
    const before = (await h.engine.store.read()).device.toJSON();
    await assert.rejects(h.api.correctSession(input.id, changed, { draftKey, draft: rawDraft }), { code });
    assert.deepEqual((await h.engine.store.read()).device.toJSON(), before);
    assert.equal(h.api.workoutSave(draftKey), null);
  }
  await h.api.correctSession(input.id, correction, { draftKey, draft: rawDraft });
  assert.equal(savedReceipt(h.api).status, 'pending');
});

test('receipt identity follows normalized import and correction commands without rewriting their raw inputs', async (t) => {
  const h = await open(t);
  const weighted = { ...input, sets: [{ ...input.sets[0], weightKg: 60.125, rpe: 7.25 }] };
  await h.api.importSession(weighted, { draftKey, draft: rawDraft });
  const pendingImport = savedReceipt(h.api);
  assert.deepEqual(pendingImport.command.args, weighted);
  assert.deepEqual(commands(h.engine), [{ name: 'gym.importSession', args: { ...weighted,
    sets: [{ ...weighted.sets[0], weightKg: 60.13, rpe: 7.3 }] } }]);
  await h.api.importSession(weighted, { draftKey, draft: rawDraft });
  assert.equal(commands(h.engine).length, 1);
  await h.sync();
  assert.deepEqual(savedReceipt(h.api), { ...pendingImport, status: 'accepted' });
  const corrected = { ...correction, sets: [{ ...correction.sets[0], weightKg: 62.345, rpe: 8.25 }] };
  await h.api.correctSession(input.id, corrected, { draftKey, draft: rawDraft });
  const pendingCorrection = savedReceipt(h.api);
  assert.deepEqual(pendingCorrection.command.args, { sessionId: input.id, ...corrected });
  assert.deepEqual(commands(h.engine), [{ name: 'gym.correctSession', args: { sessionId: input.id, ...corrected,
    sets: [{ ...corrected.sets[0], weightKg: 62.35, rpe: 8.3 }] } }]);
  await h.sync();
  assert.deepEqual(savedReceipt(h.api), { ...pendingCorrection, status: 'accepted' });
});

test('a failed result transaction keeps the command sent and the raw receipt pending until its response retries', async (t) => {
  const product = new GymProduct();
  const h = await open(t, product);
  await h.api.importSession(input, { draftKey, draft: rawDraft });
  const pending = savedReceipt(h.api);
  const request = await h.next();
  const result = push({ state: h.env.state, registry, product, account: 'A', request, serverNow: NOW });
  h.env.state = result.state;
  const transact = h.engine.store.transact.bind(h.engine.store);
  let writes = 0;
  h.engine.store.transact = (change, options = {}) => {
    if (!options.readonly && ++writes === 2) {
      h.engine.store.transact = transact;
      return transact(change, { ...options, beforeCommit: () => { throw new DOMException('Private failed receipt detail', 'QuotaExceededError'); } });
    }
    return transact(change, options);
  };
  const handle = h.engine.device.activeReplica.storageHandle;
  await assert.rejects(h.engine.pushResults(handle, request, result.response, steadyTiming(NOW, NOW)), isStoreFailure);
  assert.equal(writes, 2, 'the failed write is the command-result transaction after its offset sample');
  assert.deepEqual(savedReceipt(h.api), pending);
  assert.equal(h.engine.device.activeReplica.entries()[0].state, 'sent');
  await h.reopen();
  assert.deepEqual(savedReceipt(h.api), pending);
  await h.sync();
  assert.deepEqual(savedReceipt(h.api), { ...pending, status: 'accepted' });
  assert.deepEqual(commands(h.engine), []);
  assert.deepEqual(h.env.failures, ['storage']);
  assert.equal(JSON.stringify({ events: h.events, failures: h.failures, engineEvents: h.env.events, engineFailures: h.env.failures }).includes('Private'), false);
});
