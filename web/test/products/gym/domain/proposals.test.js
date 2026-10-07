// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Id } from '../../../../src/platform/domain-kit/entities.js';
import { Reader, Views } from '../../../../src/platform/domain-kit/reading.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { AcknowledgeRoutineRemoval, ApplyProposalKeepingReceipt, Proposal, ProposeRoutine,
  REMOVAL_RECEIPTS, removalReceipts } from '../../../../src/products/gym/domain/proposals.js';
import { Routine, RoutineEntry, RoutineValue } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { Contract, momentOf, viewRecords } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../src/platform/domain-kit/reading.js').QueuedCommand} QueuedCommand */

const vector = Contract.vectors('gym/domain/proposals-actions.json').find((value) => value.name === 'applying a removal predicts settlement and routine deletion');
assert.ok(vector);
const records = viewRecords(vector.input.records.drawn);
const moment = momentOf(vector.input);
const id = new Id('proposal1', Proposal);
const queued = { gestureId: 'removal1', command: { name: 'gym.applyProposal', args: { proposalId: 'proposal1' } }, canSupersede: false };

/** @param {{ rows?: Record<string, Json>, commands?: QueuedCommand[], gone?: boolean, anonymous?: boolean }} options */
function read({ rows = {}, commands = [], gone = false, anonymous = false } = {}) {
  return new Reader(Views.ofRecords(registry, { drawn: gone ? [] : records, stored: gone ? [] : records,
    devices: { [REMOVAL_RECEIPTS]: rows }, commands, isAnonymous: anonymous }), Proposal.scope, moment);
}

function pendingRows() {
  const action = ApplyProposalKeepingReceipt(id);
  const decided = action.decide(action.load(read()));
  assert.equal(decided.kind, 'write');
  if (decided.kind !== 'write') throw new Error('the removal writes its receipt');
  assert.deepEqual(decided.plan.command, queued.command);
  assert.equal(decided.plan.deviceWrites.length, 1);
  assert.equal(decided.plan.deviceWrites[0]?.key, REMOVAL_RECEIPTS);
  const rows = /** @type {Record<string, Json>} */ (decided.plan.deviceWrites[0]?.value);
  const receipt = /** @type {Record<string, Json>} */ (rows.proposal1);
  return { rows, receipt };
}

test('a removal receipt survives missing records and cannot be acknowledged before its command leaves the queue', () => {
  const { rows, receipt } = pendingRows();
  const apply = ApplyProposalKeepingReceipt(id);
  const acknowledge = AcknowledgeRoutineRemoval(id);
  assert.deepEqual(apply.decide(apply.load(read({ rows, gone: true }))), { kind: 'unchanged', result: null });
  assert.deepEqual(acknowledge.decide(acknowledge.load(read({ rows, gone: true }))), { kind: 'unchanged', result: null });
  const applied = { proposal1: { ...receipt, status: 'applied' } };
  for (const command of [queued, { ...queued, isAdmitted: true }]) {
    const waiting = read({ rows: applied, commands: [command], gone: true });
    assert.deepEqual(removalReceipts(waiting).map((value) => ({ outcome: value.outcome, state: value.proposal.state })),
      [{ outcome: 'pending', state: 'pending' }]);
    assert.deepEqual(acknowledge.decide(acknowledge.load(waiting)), { kind: 'unchanged', result: null });
  }
  const settled = read({ rows: applied, gone: true });
  const staleAcknowledgment = AcknowledgeRoutineRemoval(id, 'refused');
  assert.deepEqual(staleAcknowledgment.decide(staleAcknowledgment.load(settled)), { kind: 'unchanged', result: null });
  assert.deepEqual(removalReceipts(settled).map((value) => ({ id: value.proposal.id.record, intent: value.proposal.intent,
    outcome: value.outcome, state: value.proposal.state, code: value.code, detail: value.detail })),
  [{ id: 'proposal1', intent: 'remove', outcome: 'applied', state: 'applied', code: null, detail: null }]);
  const acknowledged = acknowledge.decide(acknowledge.load(settled));
  assert.equal(acknowledged.kind, 'write');
  if (acknowledged.kind !== 'write') return;
  assert.deepEqual(acknowledged.plan.deviceWrites, [{ key: REMOVAL_RECEIPTS, value: null }]);
  assert.deepEqual(acknowledged.plan.operations, []);
  assert.equal(acknowledged.plan.command, null);
});

test('refused removal receipts retain the server refusal, allow retry and acknowledge only their own row', () => {
  const { receipt } = pendingRows();
  const refused = { ...receipt, status: 'refused', code: 'proposal-superseded', detail: { reason: 'routine-changed' } };
  const other = { ...receipt, status: 'pending' };
  const rows = { proposal1: refused, proposal2: other };
  const current = read({ rows });
  assert.deepEqual(removalReceipts(current).map((value) => ({ id: value.proposal.id.record, outcome: value.outcome,
    code: value.code, detail: value.detail })), [
    { id: 'proposal1', outcome: 'refused', code: 'proposal-superseded', detail: { reason: 'routine-changed' } },
    { id: 'proposal2', outcome: 'pending', code: null, detail: null },
  ]);
  const apply = ApplyProposalKeepingReceipt(id);
  const retried = apply.decide(apply.load(current));
  assert.equal(retried.kind, 'write');
  if (retried.kind !== 'write') return;
  assert.deepEqual(retried.plan.deviceWrites, [{ key: REMOVAL_RECEIPTS, value: { proposal1: receipt, proposal2: other } }]);
  const acknowledge = AcknowledgeRoutineRemoval(id);
  const dismissed = acknowledge.decide(acknowledge.load(current));
  assert.equal(dismissed.kind, 'write');
  if (dismissed.kind !== 'write') return;
  assert.deepEqual(dismissed.plan.deviceWrites, [{ key: REMOVAL_RECEIPTS, value: { proposal2: other } }]);
  assert.deepEqual(removalReceipts(read({ rows, anonymous: true })), []);
  assert.throws(() => removalReceipts(read({ rows: { proposal1: { ...receipt, status: 'lost' } } })), DecodeError);
});

test('a removal receipt and command commit together, survive restart and do not duplicate after a storage failure', async (t) => {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Proposal.scope });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const routine = new RoutineValue(new Id('routine1', Routine), 'Strength', 0, [new RoutineEntry(new Id('bench-press', Exercise))]);
  assert.equal((await phone.runner.save(Draft.new(routine), GymRefusals)).result.kind, 'saved');
  await phone.sync();
  assert.equal((await phone.runner.run(ProposeRoutine({ id, routineId: routine.id, name: '', entries: [], summary: 'Remove this routine', removing: true }))).kind, 'committed');
  await phone.sync();
  const before = (await phone.engine.store.read()).device.toJSON();
  phone.failNextCommit();
  await assert.rejects(phone.runner.run(ApplyProposalKeepingReceipt(id)), { message: 'the device store did not commit' });
  assert.deepEqual((await phone.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(phone.runner.read(Proposal.scope, removalReceipts), []);
  assert.deepEqual(phone.env.failures, ['storage']);
  assert.equal((await phone.runner.run(ApplyProposalKeepingReceipt(id))).kind, 'committed');
  const receipts = phone.runner.read(Proposal.scope, removalReceipts);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.outcome, 'pending');
  assert.deepEqual(phone.drawn(Routine), []);
  await phone.restart();
  assert.deepEqual(phone.runner.read(Proposal.scope, removalReceipts), receipts);
  assert.deepEqual(await phone.runner.run(ApplyProposalKeepingReceipt(id)), { kind: 'unchanged', result: null });
  assert.deepEqual(await phone.runner.run(AcknowledgeRoutineRemoval(id)), { kind: 'unchanged', result: null });
  assert.equal(phone.engine.device.activeReplica.entries().filter((/** @type {any} */ entry) => entry.intent.cmd?.name === 'gym.applyProposal').length, 1);
});
