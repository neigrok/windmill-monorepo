import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ActCommit } from '../../../../../packages/api-contract/sync/reference/client/acts.js';
import { runSteps } from '../../../../../packages/api-contract/sync/reference/vectors/steps.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { ActDecision, ActPlan, ScopedPlan } from '../../../../src/platform/domain-kit/acts.js';
import { Valid } from '../../../../src/platform/domain-kit/validation.js';
import { Plan } from '../../../../src/platform/domain-kit/plans.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { Probe, ProbeRefusals, probeValue } from '../../domain-kit/probe.js';
import { environment } from '../fakes.js';

const product = 'self/probe';
const tree = 'tree/b_00000001';
const board = { scope: product, changes: [{ op: 'create', t: 'board', id: 'b_00000001' }] };
const meta = { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'First' } }] };

test('shared act vectors match complete receipts, entries, device rows and clocks', () => {
  const cases = JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/sync/corpus/commit/acts.json', import.meta.url)));
  for (const vector of cases) {
    const { telemetry, events, ...actual } = runSteps(vector.input);
    assert.deepEqual(actual, vector.expect, vector.name);
  }
});

test('a governing create, tree write and repeated-scope update persist as separate intents with one held Undo', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const result = await engine.commitAct([board, { ...meta, opts: { hold: true } },
      { scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Next' } }] }]);
    const receipt = result.outcome;
    assert.deepEqual(receipt.segments.map(({ scope, localIds }) => ({ scope, localIds })),
      [product, tree, tree].map((scope, index) => ({ scope, localIds: [`${receipt.gestureId}/${index}`] })));
    assert.deepEqual(engine.device.activeReplica.entries().map((entry) => [entry.scope, entry.state, entry.releaseAt, entry.commitOrder]),
      [product, tree, tree].map((scope, index) => [scope, 'held', receipt.releaseAt, index + 1]));
    assert.equal(engine.observe(tree).getSnapshot().drawn[0].f.title[0], 'Next');
    assert.equal(new Set(receipt.segments.map((item) => item.stamp)).size, 3);
    assert.equal(await engine.undo(receipt.gestureId), true);
    assert.deepEqual((await engine.store.read()).device.activeReplica.outbox, []);
  } finally { engine.close(); }
});

test('load replays only for hydration, decide runs once, and escaped reader loans end', async () => {
  const env = environment();
  let engine = await BrowserSyncEngine.open(env.options);
  await engine.write(null, (device) => {
    device.activeReplica.putConfirmed(tree, { t: 'meta', id: 'meta', seq: 1, rc: 1, ru: 1, f: { title: ['Before', '1:0:srv'] } });
  }, [tree]);
  engine.close();
  engine = await BrowserSyncEngine.open(env.options);
  try {
    let loads = 0, decisions = 0, escaped, moment;
    const runner = new ActionRunner(new EngineReplica(engine), env.options.registry, new FixedZone(0));
    const result = await runner.runAct({ refusals: ProbeRefusals,
      load(read) {
        loads++; moment = read.moment;
        try { return read.inScope(tree, (reader) => { escaped = reader; return reader.repository(Probe.meta).all('drawn')[0].fields().title; }); }
        catch { return 'caught'; }
      },
      decide(title) {
        decisions++;
        assert.equal(title, 'Before');
        const plan = new Plan();
        plan.update(new Valid(probeValue(Probe.meta, 'meta', { title: 'After' }), moment), { fields: ['title'] });
        return ActDecision.write(new ActPlan([new ScopedPlan(tree, plan)]), 'done');
      },
    });
    assert.throws(() => escaped.repository(Probe.meta).all('drawn'));
    assert.deepEqual([loads, decisions, result.kind], [2, 1, 'committed']);
    assert.equal(engine.observe(tree).getSnapshot().drawn[0].f.title[0], 'After');
  } finally { engine.close(); }
});

test('a later refusal or thrown segment rolls back earlier writes, local rows and clock', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const before = (await engine.store.read()).device.toJSON();
    const segments = [{ ...board, opts: { local: { rack: 'temporary' } } },
      ...[1, 2, 3, 4].map((n) => ({ scope: product, changes: [{ op: 'create', t: 'card', id: `card000${n}`, f: { title: 'Card' } }] }))];
    assert.equal((await engine.commitAct(segments)).outcome.refused, 'cap');
    assert.deepEqual(env.failures, []);
    assert.deepEqual(env.events.filter((event) => event.name === 'sync-commit').at(-1)?.props, { outcome: 'failed' });
    assert.deepEqual((await engine.store.read()).device.toJSON(), before);
    const fault = new Error('later storage read failed');
    await assert.rejects(engine.commitAct(() => ({ request: { scopes: [product, tree], hold: false }, value: null }),
      (_, index) => { if (index === 1) throw fault; return segments[0]; }), (error) => error === fault);
    assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  } finally { engine.close(); }
});

test('IndexedDB abort after all act segments leaves no durable partial writes after reopen', async () => {
  const env = environment();
  let engine = await BrowserSyncEngine.open(env.options);
  const before = (await engine.store.read()).device.toJSON();
  const act = new ActCommit();
  await assert.rejects(engine.store.transact((device, ensureScope) => act.advance(device.activeReplica,
    { ...engine.context(device), ensureScope }, () => ({ request: { scopes: [product, tree], hold: false }, value: [board, meta] }),
    (segments, index) => segments[index]), { beforeCommit: ({ transaction }) => transaction.abort() }));
  engine.close();
  engine = await BrowserSyncEngine.open(env.options);
  assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  engine.close();
});

test('existing mint scopes must be loaded before any randomness and reservations span repeated scope visits', async () => {
  const env = environment();
  let draws = 0;
  const engine = await BrowserSyncEngine.open({ ...env.options, draw: () => { draws++; return draws <= 32 ? 0 : 1; } });
  try {
    await assert.rejects(engine.commitAct((context) => { context.mintID('card', product); return { request: null, value: null }; }, () => assert.fail()));
    assert.equal(draws, 0);
    const minted = await engine.commitAct((context) => {
      context.inScope(product, () => {});
      const first = context.mintID('card', product), second = context.mintID('card', product);
      return { request: null, value: [first, second] };
    }, () => assert.fail());
    assert.notEqual(...minted.value);
    assert.equal(draws, 48);
  } finally { engine.close(); }
});

test('a newly governed scope may mint without an initial borrow and must be created before use', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const result = await engine.commitAct((context) => ({ request: { scopes: [product, tree], hold: false }, value: context.mintID('tag', tree) }),
      (id, index) => index === 0 ? board : { scope: tree, changes: [{ op: 'create', t: 'tag', id, f: { label: 'New' } }] });
    assert.equal(result.outcome.segments.length, 2);
    const before = (await engine.store.read()).device.toJSON();
    await assert.rejects(engine.commitAct((context) => ({ request: null, value: context.mintID('tag', tree) }), () => assert.fail()));
    assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  } finally { engine.close(); }
});

test('a partial release removes the act Undo offer in every scope', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const result = await engine.commitAct([{ ...board, opts: { hold: true } }, meta]);
    await engine.release(result.outcome.segments[0].localIds[0]);
    assert.deepEqual(engine.observe(tree).getSnapshot().undoOffers, []);
    assert.equal(await engine.undo(result.outcome.gestureId), false);
  } finally { engine.close(); }
});

test('the act clock and hold deadline are captured before its callbacks', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const initial = env.timers.time;
    const result = await engine.commitAct((context) => {
      env.timers.time += 100;
      return { request: { scopes: [product, tree], hold: true }, value: context.now };
    }, (now, index, reader) => {
      assert.equal(reader.now, now);
      env.timers.time += 100;
      return index === 0 ? board : meta;
    });
    assert.equal(result.outcome.releaseAt, initial + 9000);
    assert.deepEqual(result.outcome.segments.map((item) => item.stamp.split(':').slice(0, 2).join(':')), [`${initial}:0`, `${initial}:1`]);
  } finally { engine.close(); }
});


test('raw prepare cannot swallow hydration demand before finishing load or drawing an ID', async () => {
  const env = environment();
  let engine = await BrowserSyncEngine.open(env.options);
  await engine.write(null, (device) => {
    device.activeReplica.putConfirmed(tree, { t: 'meta', id: 'meta', seq: 1, rc: 1, ru: 1, f: { title: ['Before', '1:0:srv'] } });
  }, [tree]);
  engine.close();
  let draws = 0;
  engine = await BrowserSyncEngine.open({ ...env.options, draw: () => { draws++; return 0; } });
  try {
    let loads = 0, decisions = 0;
    const result = await engine.commitAct((context) => {
      loads++;
      try { context.inScope(tree, () => {}); } catch { /* finishLoad must rethrow the retained demand. */ }
      const id = context.mintID('tag', tree);
      context.finishLoad();
      decisions++;
      return { request: null, value: id };
    }, () => assert.fail());
    assert.deepEqual([loads, decisions, draws, result.outcome], [2, 1, 12, null]);
  } finally { engine.close(); }
});

test('a persisted governor with an unpulled child scope blocks unborrowed minting before randomness', async () => {
  const env = environment();
  let engine = await BrowserSyncEngine.open(env.options);
  await engine.write(null, (device) => {
    device.activeReplica.putConfirmed(product, { t: 'board', id: 'b_00000001', seq: 1, rc: 1, ru: 1, born: '1:0:srv', life: ['alive', '1:0:srv'], f: {} });
  }, [product]);
  engine.close();
  let draws = 0;
  engine = await BrowserSyncEngine.open({ ...env.options, draw: () => { draws++; return 0; } });
  try {
    const before = (await engine.store.read()).device.toJSON();
    await assert.rejects(engine.commitAct((context) => ({ request: null, value: context.mintID('tag', tree) }), () => assert.fail()));
    assert.equal(draws, 0);
    assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  } finally { engine.close(); }
});

test('finishLoad is idempotent and a caught late scope read still aborts the act', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open(env.options);
  try {
    const before = (await engine.store.read()).device.toJSON();
    await assert.rejects(engine.commitAct((context) => {
      context.finishLoad(); context.finishLoad();
      try { context.inScope(product, () => {}); } catch { /* A caught phase violation still fails. */ }
      return { request: { scopes: [product], hold: false }, value: null };
    }, () => board));
    assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  } finally { engine.close(); }
});
