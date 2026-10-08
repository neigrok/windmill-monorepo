// @ts-check
// The runner over the real browser engine (fake IndexedDB, the probe registry): what the vectors cannot
// pin, because they run over a commit double.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSTANTS } from '../../../../packages/api-contract/sync/reference/core/constants.js';
import { ZERO_DIGEST } from '../../../../packages/api-contract/sync/reference/core/digest.js';
import { Cursor } from '../../../../packages/api-contract/sync/reference/core/wire.js';
import { epochChange } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { Decision } from '../../../src/platform/domain-kit/actions.js';
import { Draft } from '../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../src/platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../src/platform/domain-kit/plans.js';
import { Placement } from '../../../src/platform/domain-kit/reading.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { Remove } from '../../../src/platform/domain-kit/standardActions.js';
import { FixedZone } from '../../../src/platform/domain-kit/time.js';
import { Fault } from '../../../src/platform/domain-kit/values.js';
import { environment } from '../sync/fakes.js';
import { PROBE_SCOPE, Probe, ProbeRefusals, probeCommand, probeValue } from './probe.js';

/** @typedef {import('./probe.js').ProbeRefusal} ProbeRefusal */

/** @param {Record<string, unknown>} [options] */
async function open(options = {}) {
  const env = environment();
  const engine = await BrowserSyncEngine.open({ ...env.options, ...options });
  const runner = new ActionRunner(new EngineReplica(engine), env.options.registry, new FixedZone(0));
  return { env, engine, runner };
}

/**
 * @template T
 * @param {string} scope
 * @param {(read: import('../../../src/platform/domain-kit/reading.js').Reader) => T} body
 * @param {(loaded: T) => import('../../../src/platform/domain-kit/actions.js').Decision<T, ProbeRefusal>} decide
 * @returns {import('../../../src/platform/domain-kit/actions.js').Decider<T, T, ProbeRefusal>}
 */
const action = (scope, body, decide) => ({ scope, refusals: ProbeRefusals, load: body, decide });

test('a new card saves through the engine, its removal is held with its releaseAt, and Undo brings it back', async () => {
  const { env, engine, runner } = await open();
  const cards = () => runner.read(PROBE_SCOPE, (read) => ({ drawn: read.repository(Probe.card).all('drawn'), stored: read.repository(Probe.card).all('stored') }));
  const id = runner.mint(Probe.card);
  const draft = Draft.new(probeValue(Probe.card, id.record), Placement.bottom).edit((card) => probeValue(Probe.card, id.record, { ...card.fields(), title: '  Plan  ' }));

  const saved = await runner.save(draft, ProbeRefusals);
  assert.equal(saved.result.kind, 'saved');
  assert.equal(saved.result.kind === 'saved' && saved.result.receipt?.localIds.length, 1);
  assert.equal(saved.result.kind === 'saved' && saved.result.receipt?.releaseAt, null);
  assert.equal(saved.draft.isNew, false);
  assert.deepEqual(saved.draft.base.fields(), { title: 'Plan', body: '', size: null, claim: null, tier: 'draft' });
  assert.deepEqual(cards().drawn.map((card) => card.fields().title), ['Plan']);

  const again = await runner.save(saved.draft, ProbeRefusals);
  assert.deepEqual(again.result, { kind: 'saved', receipt: null });

  const removed = await runner.run(new Remove(id, ProbeRefusals));
  assert.equal(removed.kind, 'committed');
  const receipt = removed.kind === 'committed' ? removed.receipt : assert.fail('not committed');
  assert.equal(receipt.releaseAt, env.timers.time + CONSTANTS.HOLD_MS);
  assert.deepEqual(cards(), { drawn: [], stored: cards().stored });
  assert.equal(cards().stored.length, 1);

  assert.equal(await runner.undo(receipt.gestureId), true);
  assert.equal(cards().drawn.length, 1);
  assert.equal(engine.observe(PROBE_SCOPE).getSnapshot().drawn.length, 1);
  engine.close();
});

test('a device write commits with no record and is read back inside the next run, with the first-pull state', async () => {
  const { engine, runner } = await open();
  const written = await runner.run(action(PROBE_SCOPE, () => null, () => {
    const plan = new Plan();
    plan.device('rack', { n: 1 });
    return Decision.write(plan, null);
  }));
  assert.equal(written.kind, 'committed');
  assert.deepEqual(written.kind === 'committed' && written.receipt.localIds, []);

  const read = await runner.run(action(PROBE_SCOPE, (reader) => ({ rack: reader.device('rack'), pulled: reader.firstPullComplete(), today: reader.moment.today.text }),
    (loaded) => Decision.unchanged(loaded)));
  assert.deepEqual(read, { kind: 'unchanged', result: { rack: { n: 1 }, pulled: engine.observe(PROBE_SCOPE).getSnapshot().firstPullComplete, today: runner.moment().today.text } });
  assert.deepEqual(runner.read(PROBE_SCOPE, (reader) => reader.device('rack')), { n: 1 });
  engine.close();
});

test('a commit reads the current tab transaction, including confirmed values beneath predictions and scoped device metadata', async () => {
  const { env, engine, runner } = await open();
  const peer = await BrowserSyncEngine.open(env.options);
  const peerRunner = new ActionRunner(new EngineReplica(peer), env.options.registry, new FixedZone(0));
  const id = new Id('run00001', Probe.run);
  const command = probeCommand('probe.start', { id: id.record, label: 'Pending', startedAt: 1000, join: false });
  const confirmed = { t: 'run', id: id.record, life: ['alive', '1:0:srv'], born: '1:0:srv',
    f: { startedAt: [1, '1:0:srv'], label: ['Confirmed', '1:0:srv'] } };
  /** @param {import('../../../src/platform/domain-kit/reading.js').Reader} read */
  const metadata = (read) => ({ confirmed: read.confirmed(Probe.run, id),
    drawn: read.repository(Probe.run).find(id, 'drawn')?.fields() ?? null, devices: read.devices('picture:'),
    commands: read.commands(), checkpoint: read.checkpoint(), actor: read.actor,
    isAnonymous: read.isAnonymous, complete: read.firstPullComplete() });
  const before = runner.read(PROBE_SCOPE, metadata);
  await peer.write(null, (/** @type {any} */ device) => {
    device.activeReplica.putConfirmed(PROBE_SCOPE, { ...confirmed, seq: 5, rc: 1, ru: 1 });
  }, [PROBE_SCOPE]);
  const queued = await peerRunner.run(action(PROBE_SCOPE, () => null, () => {
    const plan = Plan.running(command, [Prediction.update(id, { label: 'Pending' })]);
    plan.device('picture:abcdefgh', { kept: true });
    plan.device('rack', { excluded: true });
    return Decision.write(plan, null);
  }));
  const receipt = queued.kind === 'committed' ? queued.receipt : assert.fail('not committed');
  await peer.write(null, (/** @type {any} */ device) => {
    const replica = device.activeReplica;
    Object.assign(replica.meta, { state: 'bound', account: 'A', serverEpoch: 'ep-current' });
    replica.cursors[PROBE_SCOPE] = { cursor: Cursor.encode({ e: 'ep-current', m: 'live', s: 5 }), digest: ZERO_DIGEST, booted: true };
    Object.assign(replica.entry(receipt.localIds[0]), { state: 'acked', n: 1, resultEpoch: 'ep-current', resultSeq: 6 });
  }, [PROBE_SCOPE]);
  assert.deepEqual(runner.read(PROBE_SCOPE, metadata), before, 'the first tab has received no peer refresh');
  const loaded = await runner.run(action(PROBE_SCOPE, metadata, (value) => Decision.unchanged(value)));
  assert.deepEqual(loaded, { kind: 'unchanged', result: {
    confirmed: { ...confirmed, rc: 1 },
    drawn: { startedAt: 1, label: 'Pending' },
    devices: { 'picture:abcdefgh': { kept: true } },
    commands: [{ gestureId: receipt.gestureId, command: { name: command.name, args: command.args }, canSupersede: false, isAdmitted: true }],
    checkpoint: { epoch: 'ep-current', cleanSeq: 5 }, actor: engine.actor, isAnonymous: false, complete: true,
  } });
  await engine.refresh(false, [PROBE_SCOPE]);
  assert.deepEqual(runner.read(PROBE_SCOPE, metadata), loaded.kind === 'unchanged' && loaded.result);
  engine.close(); peer.close();
});

test('a checkpoint covers only a complete same-epoch live pull with no staging or failed digest', async () => {
  const { engine, runner } = await open();
  /** @param {import('../../../src/platform/domain-kit/reading.js').Reader} read */
  const metadata = (read) => ({ checkpoint: read.checkpoint(), complete: read.firstPullComplete() });
  assert.deepEqual(runner.read(PROBE_SCOPE, metadata), { checkpoint: { epoch: null, cleanSeq: null }, complete: true });
  await engine.write(null, (/** @type {any} */ device) => {
    Object.assign(device.activeReplica.meta, { state: 'bound', account: 'A', serverEpoch: 'ep-current' });
  });
  assert.deepEqual(runner.read(PROBE_SCOPE, metadata), { checkpoint: { epoch: 'ep-current', cleanSeq: null }, complete: false });
  const live = Cursor.encode({ e: 'ep-current', m: 'live', s: 5 });
  const cases = [
    { name: 'boot', cursor: Cursor.encode({ e: 'ep-current', m: 'boot', s: 0, a: 5 }), booted: false },
    { name: 'complete', cursor: live, cleanSeq: 5 },
    { name: 'partial transaction', cursor: Cursor.encode({ e: 'ep-current', m: 'live', s: 5, k: ['run', 'run00001'] }) },
    { name: 'wrong epoch', cursor: Cursor.encode({ e: 'ep-old', m: 'live', s: 5 }) },
    { name: 'behind', cursor: live, behind: true },
    { name: 'staging', cursor: live, staging: true },
    { name: 'digest reset', cursor: live, mismatchReset: true },
    { name: 'digest stop', cursor: live, digestStop: '1' },
    { name: 'no cursor', cursor: null },
  ];
  for (const { name, staging = false, cleanSeq = null, booted = true, ...record } of cases) {
    await engine.write(null, (/** @type {any} */ device) => {
      const replica = device.activeReplica;
      replica.cursors[PROBE_SCOPE] = { digest: ZERO_DIGEST, booted, ...record };
      if (staging) replica.staging[PROBE_SCOPE] = { digest: ZERO_DIGEST, rows: {} };
      else delete replica.staging[PROBE_SCOPE];
    }, [PROBE_SCOPE]);
    const expected = { checkpoint: { epoch: 'ep-current', cleanSeq }, complete: booted };
    assert.deepEqual(runner.read(PROBE_SCOPE, metadata), expected, name);
    assert.deepEqual(await runner.run(action(PROBE_SCOPE, metadata, (value) => Decision.unchanged(value))),
      { kind: 'unchanged', result: expected }, name);
  }
  await engine.write(null, (/** @type {any} */ device, /** @type {any} */ ctx) => epochChange(device.activeReplica, ctx, 'ep-next'), [PROBE_SCOPE]);
  assert.deepEqual(runner.read(PROBE_SCOPE, metadata), { checkpoint: { epoch: 'ep-next', cleanSeq: null }, complete: true });
  engine.close();
});

test('anonymous command replacement and its device snapshot survive an aborted commit unchanged, then supersede together', async () => {
  const { env, engine, runner } = await open();
  /** @param {string} label */
  const save = (label) => action(PROBE_SCOPE, (read) => read.commands(), (commands) => {
    const plan = Plan.running(probeCommand('probe.start', { id: 'run00001', label, startedAt: 1000, join: false }));
    plan.supersede(commands.filter((queued) => queued.canSupersede).map((queued) => queued.gestureId));
    plan.device('rack', { label });
    return Decision.write(plan, commands);
  });
  const first = await runner.run(save('First'));
  const firstReceipt = first.kind === 'committed' ? first.receipt : assert.fail('not committed');
  const before = (await engine.store.read()).device.toJSON();
  const transact = engine.store.transact.bind(engine.store);
  engine.store.transact = (/** @type {any} */ change, /** @type {any} */ options) => {
    engine.store.transact = transact;
    return transact(change, { ...options, beforeCommit: (/** @type {any} */ { transaction }) => transaction.abort() });
  };
  await assert.rejects(runner.run(save('Latest')));
  assert.deepEqual((await engine.store.read()).device.toJSON(), before);
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.deepEqual((await reopened.store.read()).device.toJSON(), before);
  reopened.close();
  const second = await runner.run(save('Latest'));
  const secondReceipt = second.kind === 'committed' ? second.receipt : assert.fail('not committed');
  assert.deepEqual(secondReceipt.superseded, [firstReceipt.gestureId]);
  assert.deepEqual(second.kind === 'committed' && second.result, [{ gestureId: firstReceipt.gestureId,
    command: { name: 'probe.start', args: { id: 'run00001', label: 'First', startedAt: 1000, join: false } }, canSupersede: true, isAdmitted: false }]);
  assert.deepEqual(engine.device.activeReplica.entries(PROBE_SCOPE).map((/** @type {any} */ entry) => entry.intent.cmd),
    [{ name: 'probe.start', args: { id: 'run00001', label: 'Latest', startedAt: 1000, join: false } }]);
  assert.deepEqual(runner.read(PROBE_SCOPE, (read) => read.device('rack')), { label: 'Latest' });
  const removed = await runner.run(action(PROBE_SCOPE, () => null, () => {
    const plan = new Plan();
    plan.supersede([secondReceipt.gestureId]);
    return Decision.write(plan, null);
  }));
  assert.equal(removed.kind, 'committed');
  assert.deepEqual(removed.kind === 'committed' && { localIds: removed.receipt.localIds, superseded: removed.receipt.superseded },
    { localIds: [], superseded: [secondReceipt.gestureId] });
  engine.close();
});

test('opaque ids are minted at the engine boundary and retained with the same device commit', async () => {
  const { engine, runner } = await open();
  const saved = await runner.run({ scope: PROBE_SCOPE, refusals: ProbeRefusals, load: () => null,
    decide: (_loaded, ids) => {
      const opaque = [ids.opaqueID(), ids.opaqueID()];
      const plan = new Plan();
      plan.device('rack', opaque);
      return Decision.write(plan, opaque);
    } });
  assert.equal(saved.kind, 'committed');
  if (saved.kind !== 'committed') return;
  assert.deepEqual(runner.read(PROBE_SCOPE, (read) => read.device('rack')), saved.result);
  assert.equal(new Set([...saved.result, saved.receipt.gestureId]).size, 3);
  for (const opaque of saved.result) assert.match(opaque, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  engine.close();
});

for (const phase of ['load', 'decide', 'refusal']) for (const operation of ['run', 'save']) for (const shared of [true, false]) {
  test(`a nested ${operation} in ${phase} on ${shared ? 'the same' : 'another'} runner cannot queue a write after the outer fault`, async () => {
    const { env, engine, runner } = await open();
    const inner = shared ? runner : new ActionRunner(new EngineReplica(engine), env.options.registry, new FixedZone(0));
    const draft = Draft.new(probeValue(Probe.card, runner.mint(Probe.card).record, { title: 'Nested' }), Placement.bottom);
    const write = action(PROBE_SCOPE, () => null, () => {
      const plan = new Plan();
      plan.device('rack', { unexpected: 'persisted' });
      return Decision.write(plan, null);
    });
    const before = (await engine.store.read()).device.toJSON();
    /** @type {Promise<unknown> | undefined} */
    let nested;
    const enter = () => {
      nested = operation === 'run' ? inner.run(write) : inner.save(draft, ProbeRefusals);
      void nested.catch(() => {});
      return nested;
    };
    const outer = action(PROBE_SCOPE, phase === 'load' ? enter : () => null,
      /** @type {any} */ (phase === 'decide' ? enter : () => {
        if (phase !== 'refusal') return Decision.unchanged(null);
        const plan = new Plan();
        plan.remove(draft.current.id);
        return Decision.write(plan, null);
      }));
    if (phase === 'refusal') outer.refusals = { ...ProbeRefusals, ofRefused: () => {
      enter();
      throw new Fault('the outer refusal failed');
    } };
    const [outerResult] = await Promise.allSettled([runner.run(outer)]);
    assert.ok(nested);
    const [innerResult] = await Promise.allSettled([nested]);
    const after = (await engine.store.read()).device.toJSON();
    engine.close();
    const reopened = await BrowserSyncEngine.open(env.options);
    const restored = (await reopened.store.read()).device.toJSON();
    reopened.close();
    assert.deepEqual(after, before);
    assert.deepEqual(restored, before);
    assert.equal(outerResult?.status, 'rejected');
    assert.ok(outerResult?.status === 'rejected' && outerResult.reason instanceof Fault);
    assert.equal(innerResult?.status, 'rejected');
    assert.ok(innerResult?.status === 'rejected' && innerResult.reason instanceof Fault);
    assert.equal(innerResult?.status === 'rejected' && innerResult.reason.message, 'a run cannot enter inside a run');
  });
}

test('independent queued runs commit and a decider that awaits writes nothing', async () => {
  const { engine, runner } = await open();
  const outcomes = await Promise.all([1, 2].map((n) => runner.run(action(PROBE_SCOPE, () => null, () => {
    const plan = new Plan();
    plan.device('rack', n);
    return Decision.write(plan, null);
  }))));
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['committed', 'committed']);
  assert.equal(runner.read(PROBE_SCOPE, (reader) => reader.device('rack')), 2);
  const awaiting = action(PROBE_SCOPE, async () => null, () => Decision.unchanged(null));
  await assert.rejects(runner.run(/** @type {any} */ (awaiting)), Fault);
  assert.deepEqual(engine.observe(PROBE_SCOPE).getSnapshot().drawn, []);
  engine.close();
});

test('mapping an engine refusal cannot queue an inner write after the outer fault', async () => {
  const { env, engine, runner } = await open({ limits: { PUSH_MAX_BYTES: 64 } });
  const draft = Draft.new(probeValue(Probe.card, runner.mint(Probe.card).record, { title: 'Plan' }), Placement.bottom);
  /** @type {Promise<unknown> | undefined} */
  let nested;
  const refusals = { ...ProbeRefusals, ofRefused: () => {
    nested = runner.run(action(PROBE_SCOPE, () => null, () => {
      const plan = new Plan();
      plan.device('rack', { unexpected: 'persisted' });
      return Decision.write(plan, null);
    }));
    void nested.catch(() => {});
    throw new Fault('the outer refusal failed');
  } };
  await assert.rejects(runner.save(draft, refusals), Fault);
  assert.ok(nested);
  const [inner] = await Promise.allSettled([nested]);
  const after = (await engine.store.read()).device.toJSON().replicas[0];
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  const restored = (await reopened.store.read()).device.toJSON().replicas[0];
  reopened.close();
  for (const replica of [after, restored]) {
    assert.equal(replica.device, undefined);
    assert.equal(replica.outbox, undefined);
    assert.equal(replica.notices?.length, 1);
    assert.equal(replica.notices?.[0].dismissed, true);
  }
  assert.equal(inner?.status, 'rejected');
  assert.ok(inner?.status === 'rejected' && inner.reason instanceof Fault);
});

test('a too-large commit is refused once, with the record as its subject, and its notice is dismissed', async () => {
  const { engine, runner } = await open({ limits: { PUSH_MAX_BYTES: 64 } });
  const id = runner.mint(Probe.card);
  const draft = Draft.new(probeValue(Probe.card, id.record, { title: 'Plan' }), Placement.bottom);
  const { result, draft: after } = await runner.save(draft, ProbeRefusals);
  assert.equal(result.kind, 'refused');
  const refusal = result.kind === 'refused' ? result.refusal : assert.fail('not refused');
  assert.equal(refusal.kind, 'rejected');
  if (refusal.kind !== 'rejected') return;
  assert.deepEqual({ code: refusal.refused.code, subject: refusal.refused.subject, path: refusal.refused.path },
    { code: 'too-large', subject: { t: 'card', id: id.record }, path: 'predicted' });
  assert.equal(after, draft);
  const notices = engine.observe(PROBE_SCOPE).getSnapshot().notices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].dismissed, true);
  engine.close();
});
