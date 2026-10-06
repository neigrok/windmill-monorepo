// @ts-check
// The runner over the real browser engine (fake IndexedDB, the probe registry): what the vectors cannot
// pin, because they run over a commit double.

import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSTANTS } from '../../../src/platform/sync/core/constants.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { Decision } from '../../../src/platform/domain-kit/actions.js';
import { Draft } from '../../../src/platform/domain-kit/drafts.js';
import { Plan } from '../../../src/platform/domain-kit/plans.js';
import { Placement } from '../../../src/platform/domain-kit/reading.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { Remove } from '../../../src/platform/domain-kit/standardActions.js';
import { FixedZone } from '../../../src/platform/domain-kit/time.js';
import { Fault } from '../../../src/platform/domain-kit/values.js';
import { environment } from '../sync/fakes.js';
import { PROBE_SCOPE, Probe, ProbeRefusals, probeValue } from './probe.js';

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

test('a run inside a run and a decider that awaits are faults, and write nothing', async () => {
  const { engine, runner } = await open();
  const nested = action(PROBE_SCOPE, () => runner.run(action(PROBE_SCOPE, () => null, () => Decision.unchanged(null))), () => Decision.unchanged(null));
  await assert.rejects(runner.run(nested), Fault);
  const awaiting = action(PROBE_SCOPE, async () => null, () => Decision.unchanged(null));
  await assert.rejects(runner.run(/** @type {any} */ (awaiting)), Fault);
  assert.equal(runner.insideRun, false);
  assert.deepEqual(engine.observe(PROBE_SCOPE).getSnapshot().drawn, []);
  engine.close();
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
