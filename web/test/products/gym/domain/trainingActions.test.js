// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Refusal } from '../../../../../packages/api-contract/sync/reference/server/admit.js';
import { Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { Stamp } from '../../../../../packages/api-contract/sync/reference/core/stamp.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session, SessionRules, SessionValue, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, CorrectedSet, CorrectSession, CorrectSet, DeleteSet, DiscardSession, FinishSession, ImportedSet, ImportSession, StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../../src/products/gym/domain/gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('../../../../src/platform/domain-kit/refusals.js').DomainNotice<GymRefusal>} Notice */

const sessionId = new Id('session1', Session);
const exerciseId = new Id('bench-press', Exercise);
const startedAt = new Instant(DEFAULT_NOW - 60_000);
const finishedAt = new Instant(DEFAULT_NOW);

/** @param {import('node:test').TestContext} t @param {GymProduct} [product] */
async function open(t, product = new GymProduct()) {
  const phone = await Harness.open({ registry, product, scope: Session.scope });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  return phone;
}

/** @template T @param {import('../../../../src/platform/domain-kit/actions.js').Outcome<T, GymRefusal>} result */
function committed(result) {
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('the training action did not commit');
  return result;
}

/** @param {string} id @param {Partial<ImportedSet>} [changes] */
function imported(id, changes = {}) {
  return new ImportedSet({ id: new Id(id, TrainingSet), exerciseId, weightKg: 80, reps: 5,
    completedAt: new Instant(DEFAULT_NOW - 1_000), ...changes });
}

/** @param {TrainingSetValue} value @param {Record<string, Json>} changes */
function editing(value, changes) {
  return TrainingSet.decode(Fields.values('set', value.id.record, { ...value.fields(), setNumber: value.setNumber, ...changes }));
}

/** @param {Harness} phone @param {Id<TrainingSetValue>} id */
function setOf(phone, id) {
  const set = phone.drawn(TrainingSet).find((value) => value.id.equals(id));
  assert.ok(set);
  return set;
}

/** @param {TrainingSetValue} value @param {Partial<CorrectedSet>} [changes] */
function correction(value, changes = {}) {
  assert.ok(value.setNumber !== null);
  return new CorrectedSet({ id: value.id, exerciseId: value.exerciseId, setNumber: value.setNumber, weightKg: value.weightKg,
    reps: value.reps, completedAt: value.completedAt, ...changes });
}

/** @param {Harness} phone @param {readonly ImportedSet[]} sets */
async function importWorkout(phone, sets) {
  committed(await phone.runner.run(ImportSession({ id: sessionId, startedAt, finishedAt, sets })));
  await phone.sync();
  assert.deepEqual(phone.notices(GymRefusals), []);
}

/** @param {Harness} phone @param {Id<TrainingSetValue>} id */
const recordOf = (phone, id) => phone.runner.read(Session.scope, (read) => read.repository(TrainingSet).record(id.record, 'drawn'));

test('concurrent starts join one workout and rewrite the queued set parent before assigning its serial', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const other = new Id('session2', Session);
  assert.deepEqual(committed(await a.runner.run(StartSession({ id: sessionId }))).result, sessionId);
  assert.deepEqual(committed(await b.runner.run(StartSession({ id: other }))).result, other);
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), other, exerciseId, 80, 5, finishedAt);
  committed(await b.runner.run(AppendSet(set)));
  assert.deepEqual(b.drawn(TrainingSet), [set]);
  await a.sync();
  const admitted = new TrainingSetValue(set.id, sessionId, exerciseId, 80, 5, finishedAt, 'working', null, '', 1);
  assert.deepEqual(a.drawn(TrainingSet), [admitted]);
  assert.deepEqual(b.drawn(TrainingSet), [admitted]);
  assert.deepEqual(a.drawn(Session), [new SessionValue(sessionId, finishedAt)]);
  assert.deepEqual(b.drawn(Session), a.drawn(Session));
  assert.deepEqual(a.notices(GymRefusals), []);
  assert.deepEqual(b.notices(GymRefusals), []);
});

test('a pending start, complete set and finish survive restart and settle without dropping accepted set details', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, exerciseId, 82.5, 5,
    finishedAt, 'drop', 7.5, 'Keep this set');
  committed(await a.runner.run(StartSession({ id: sessionId, startedAt })));
  committed(await a.runner.run(AppendSet(set)));
  committed(await a.runner.run(FinishSession({ id: sessionId, finishedAt })));
  assert.deepEqual(a.drawn(TrainingSet), [set]);
  assert.deepEqual(a.drawn(Session), [new SessionValue(sessionId, startedAt, finishedAt, 'finish')]);
  await a.restart();
  assert.deepEqual(a.drawn(TrainingSet), [set]);
  await a.sync();
  const admitted = editing(set, { setNumber: 1 });
  assert.deepEqual(a.drawn(TrainingSet), [admitted]);
  assert.deepEqual(b.drawn(TrainingSet), [admitted]);
  assert.deepEqual(b.drawn(Session), a.drawn(Session));
  assert.deepEqual(a.notices(GymRefusals), []);
});

test('a failed finish keeps the open workout and accepted set durable until the same finish retries', async (t) => {
  const a = await open(t);
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, exerciseId, 80, 5, finishedAt);
  committed(await a.runner.run(StartSession({ id: sessionId, startedAt })));
  committed(await a.runner.run(AppendSet(set)));
  await a.sync();
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  await assert.rejects(a.runner.run(FinishSession({ id: sessionId, finishedAt })), { message: 'the device store did not commit' });
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.drawn(Session), [new SessionValue(sessionId, startedAt)]);
  assert.deepEqual(a.env.failures, ['storage']);
  await a.restart();
  committed(await a.runner.run(FinishSession({ id: sessionId, finishedAt })));
  await a.sync();
  assert.deepEqual(a.drawn(TrainingSet), [editing(set, { setNumber: 1 })]);
  assert.deepEqual(a.drawn(Session), [new SessionValue(sessionId, startedAt, finishedAt, 'finish')]);
  assert.deepEqual(await a.runner.run(FinishSession({ id: sessionId })), { kind: 'unchanged', result: null });
});

test('CorrectSet accepts an admission serial but refuses concurrent changes and edits to identity', async (t) => {
  const a = await open(t);
  committed(await a.runner.run(StartSession({ id: sessionId, startedAt })));
  const pending = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, exerciseId, 80, 5, finishedAt);
  committed(await a.runner.run(AppendSet(pending)));
  const original = setOf(a, pending.id);
  assert.equal(original.setNumber, null);
  await a.sync();
  committed(await a.runner.run(CorrectSet(editing(original, { weightKg: 82.125, rpe: 9.25 }), original)));
  const corrected = editing(original, { weightKg: 82.13, rpe: 9.3, setNumber: 1 });
  assert.deepEqual(setOf(a, original.id), corrected);
  const concurrent = editing(corrected, { note: 'Another correction' });
  committed(await a.runner.run(CorrectSet(concurrent)));
  const stale = await a.runner.run(CorrectSet(editing(corrected, { reps: 8 }), corrected));
  assert.deepEqual(stale.kind === 'refused' && refusalForm(stale.refusal), { stale: { subject: original.id.ref, path: 'predicted' } });
  for (const change of [{ sessionId: 'session2' }, { exerciseId: 'back-squat' }, { completedAt: DEFAULT_NOW - 1 }, { setNumber: 9 }]) {
    const refused = await a.runner.run(CorrectSet(editing(concurrent, change), concurrent));
    assert.deepEqual(refused.kind === 'refused' && refusalForm(refused.refusal),
      { invalid: { rule: 'set.identity', path: 'id', reason: 'custom', custom: 'immutable' } });
  }
  assert.deepEqual(setOf(a, original.id), concurrent);
  await a.sync();
  assert.deepEqual(setOf(a, original.id), concurrent);
  assert.deepEqual(await a.runner.run(CorrectSet(concurrent)), { kind: 'unchanged', result: null });
});

test('a held set deletion refuses corrections, restores exactly on Undo and expires at its original deadline', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const input = imported('set00001', { kind: 'drop', rpe: 8, note: 'Kept' });
  await importWorkout(a, [input]);
  const before = setOf(a, input.id);
  const removed = committed(await a.runner.run(DeleteSet(input.id)));
  assert.equal(removed.receipt.releaseAt, DEFAULT_NOW + CONSTANTS.HOLD_MS);
  assert.deepEqual(a.drawn(TrainingSet), []);
  assert.deepEqual(a.stored(TrainingSet), [before]);
  const refused = await a.runner.run(CorrectSet(editing(before, { weightKg: 90 })));
  assert.deepEqual(refused.kind === 'refused' && refusalForm(refused.refusal), { gone: { subject: input.id.ref, path: 'predicted' } });
  await a.sync();
  assert.deepEqual(b.drawn(TrainingSet), [before]);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(a.drawn(TrainingSet), [before]);
  const again = committed(await a.runner.run(DeleteSet(input.id)));
  await a.advance(CONSTANTS.HOLD_MS - 1);
  assert.deepEqual(a.undoOffers(), [{ id: again.receipt.gestureId, releaseAt: again.receipt.releaseAt, records: [input.id.ref] }]);
  await a.advance(1);
  assert.equal(await a.runner.undo(again.receipt.gestureId), false);
  await a.sync();
  assert.deepEqual(a.stored(TrainingSet), []);
  assert.deepEqual(b.drawn(TrainingSet), []);
});

test('discarding a stale workout is held, refuses Finish while hidden and cascades set deletion only after release', async (t) => {
  const a = await open(t);
  const b = await a.device();
  committed(await a.runner.run(StartSession({ id: sessionId })));
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, exerciseId, 80, 5, finishedAt);
  committed(await a.runner.run(AppendSet(set)));
  await a.sync();
  const openRefusal = await a.runner.run(DiscardSession(sessionId));
  assert.deepEqual(openRefusal.kind === 'refused' && refusalForm(openRefusal.refusal),
    { sessionOpen: { code: 'session-open', subject: sessionId.ref, detail: null, path: 'predicted' } });
  await a.advance(SessionRules.staleAfterMs);
  const before = a.drawn(Session);
  const sets = a.drawn(TrainingSet);
  const removal = committed(await a.runner.run(DiscardSession(sessionId)));
  const finishRefusal = await a.runner.run(FinishSession({ id: sessionId }));
  assert.deepEqual(finishRefusal.kind === 'refused' && refusalForm(finishRefusal.refusal), { gone: { subject: sessionId.ref, path: 'predicted' } });
  assert.deepEqual(a.drawn(Session), []);
  assert.deepEqual(a.drawn(TrainingSet), sets);
  assert.equal(await a.runner.undo(removal.receipt.gestureId), true);
  assert.deepEqual(a.drawn(Session), before);
  assert.deepEqual(a.drawn(TrainingSet), sets);
  committed(await a.runner.run(DiscardSession(sessionId)));
  await a.advance(CONSTANTS.HOLD_MS);
  await a.sync();
  for (const phone of [a, b]) {
    assert.deepEqual(phone.drawn(Session), []);
    assert.deepEqual(phone.drawn(TrainingSet), []);
    assert.deepEqual(phone.notices(GymRefusals), []);
  }
});

test('an import storage failure writes no prediction and retry persists the complete workout across restart', async (t) => {
  const a = await open(t);
  const sets = [imported('set00001', { weightKg: 80.125 }), imported('set00002')];
  const action = ImportSession({ id: sessionId, startedAt, finishedAt, sets });
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  await assert.rejects(a.runner.run(action), { message: 'the device store did not commit' });
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.drawn(Session), []);
  assert.deepEqual(a.drawn(TrainingSet), []);
  assert.deepEqual(a.env.failures, ['storage']);
  committed(await a.runner.run(action));
  const predicted = a.drawn(TrainingSet);
  assert.deepEqual(predicted.map((set) => ({ id: set.id.record, weightKg: set.weightKg, setNumber: set.setNumber })),
    [{ id: 'set00001', weightKg: 80.13, setNumber: null }, { id: 'set00002', weightKg: 80, setNumber: null }],
    'an import predicts normalized fields while serials remain unassigned');
  assert.deepEqual(a.engine.device.activeReplica.entries().at(-1).intent.cmd, {
    name: 'gym.importSession', args: { id: 'session1', startedAt: startedAt.ms, finishedAt: finishedAt.ms, sets: [
      { id: 'set00001', exerciseId: 'bench-press', weightKg: 80.13, reps: 5, completedAt: DEFAULT_NOW - 1_000 },
      { id: 'set00002', exerciseId: 'bench-press', weightKg: 80, reps: 5, completedAt: DEFAULT_NOW - 1_000 },
    ] },
  });
  await a.restart();
  assert.deepEqual(a.drawn(TrainingSet), predicted);
  await a.sync();
  assert.deepEqual(a.drawn(TrainingSet), predicted.map((set, index) => editing(set, { setNumber: index + 1 })));
  assert.deepEqual(a.notices(GymRefusals), []);
});

test('import receipt replay distinguishes omitted RPE from explicit null and retains accepted data after refusal', async (t) => {
  const a = await open(t);
  const input = imported('set00001');
  const action = ImportSession({ id: sessionId, startedAt, finishedAt, sets: [input] });
  committed(await a.runner.run(action));
  await a.sync();
  const before = a.drawn(TrainingSet);
  committed(await a.runner.run(action));
  await a.sync();
  assert.deepEqual(a.notices(GymRefusals), []);
  committed(await a.runner.run(ImportSession({ id: sessionId, startedAt, finishedAt,
    sets: [new ImportedSet({ ...input, rpeNamed: true })] })));
  await a.sync();
  assert.deepEqual(a.drawn(TrainingSet), before);
  assert.deepEqual(a.notices(GymRefusals).map((/** @type {Notice} */ notice) => refusalForm(notice.refusal)),
    [{ payloadConflict: { code: 'payload-conflict', subject: sessionId.ref, detail: null, path: 'notice' } }]);
});

for (const refused of [false, true]) test(`a correction removal preserves born and ${refused ? 'rolls back its prediction on refusal' : 'converges after admission'}`, async (t) => {
  const product = new GymProduct();
  const a = await open(t, product);
  const b = await a.device();
  const one = imported('set00001', { kind: 'drop', rpe: 8, note: 'Kept detail' });
  const two = imported('set00002');
  await importWorkout(a, [one, two]);
  const original = setOf(a, one.id);
  const before = recordOf(a, two.id);
  assert.ok(before?.life);
  if (refused) {
    const check = product.check.bind(product);
    let pending = true;
    product.check = (...args) => {
      if (pending) { pending = false; throw new Refusal('invalid'); }
      return check(...args);
    };
  }
  committed(await a.runner.run(CorrectSession({ id: sessionId, requestId: 'request1', startedAt, finishedAt, routineName: 'Corrected',
    sets: [correction(original, { setNumber: 7, weightKg: 82.125, reps: 6 })] })));
  assert.deepEqual(a.engine.device.activeReplica.entries().at(-1).intent.cmd, {
    name: 'gym.correctSession', args: { sessionId: 'session1', requestId: 'request1', startedAt: startedAt.ms, finishedAt: finishedAt.ms,
      routineName: 'Corrected', sets: [{ id: 'set00001', exerciseId: 'bench-press', setNumber: 7, weightKg: 82.13, reps: 6,
        completedAt: DEFAULT_NOW - 1_000 }] },
  });
  const pending = recordOf(a, two.id);
  assert.ok(pending?.life);
  assert.equal(pending.life[0], 'dead');
  assert.ok(Stamp.compare(pending.life[1], before.life[1]) > 0);
  assert.equal(pending.born, before.born);
  assert.deepEqual(a.drawn(TrainingSet), [editing(original, { weightKg: 82.13, reps: 6 })]);
  assert.equal(setOf(a, one.id).setNumber, 1, 'the pending correction retains the confirmed serial until the server assigns 7');
  await a.sync();
  if (refused) {
    assert.deepEqual(recordOf(a, two.id), before);
    assert.deepEqual(a.drawn(TrainingSet), [original, setOf(b, two.id)]);
    assert.deepEqual(a.notices(GymRefusals).map((/** @type {Notice} */ notice) => refusalForm(notice.refusal)),
      [{ other: { code: 'invalid', subject: sessionId.ref, detail: null, path: 'notice' } }]);
  } else {
    assert.equal(recordOf(a, two.id), undefined);
    assert.deepEqual(a.drawn(TrainingSet), [editing(original, { weightKg: 82.13, reps: 6, setNumber: 7 })]);
    assert.deepEqual(a.drawn(Session), [new SessionValue(sessionId, startedAt, finishedAt, 'finish', null, null, null, 'Corrected')]);
    assert.deepEqual(a.notices(GymRefusals), []);
  }
  assert.deepEqual(b.drawn(TrainingSet), a.drawn(TrainingSet));
});

test('a held deletion remains undoable while a workout correction waits for server admission', async (t) => {
  const a = await open(t);
  const input = imported('set00001');
  await importWorkout(a, [input]);
  const before = setOf(a, input.id);
  const removed = committed(await a.runner.run(DeleteSet(input.id)));
  committed(await a.runner.run(CorrectSession({ id: sessionId, requestId: 'request1', startedAt, finishedAt, routineName: null,
    sets: [correction(before, { weightKg: 90 })] })));
  assert.deepEqual(a.drawn(TrainingSet), []);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  await a.sync();
  assert.deepEqual(a.drawn(TrainingSet), [editing(before, { weightKg: 90 })]);
  assert.deepEqual(a.notices(GymRefusals), []);
});

test('registry v6 recovery preserves unmentioned sets and concurrent edits while adding a recovered set', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await importWorkout(a, [imported('set00001'), imported('set00002')]);
  const before = a.drawn(TrainingSet);
  const retained = before[1];
  assert.ok(retained);
  const changed = editing(retained, { reps: 9, note: 'Edited on another device' });
  committed(await a.runner.run(CorrectSet(changed)));
  const added = new CorrectedSet({ ...imported('set00003', { kind: 'drop', rpe: 7.5, note: 'Recovered detail' }), setNumber: 3 });
  committed(await b.runner.run(CorrectSession({ id: sessionId, requestId: 'recover1', startedAt, finishedAt, routineName: null,
    sets: [added], preserveOtherSets: true })));
  const command = b.engine.device.activeReplica.entries().at(-1).intent.cmd;
  assert.deepEqual(command, {
    name: 'gym.correctSession', args: { sessionId: 'session1', requestId: 'recover1', startedAt: startedAt.ms, finishedAt: finishedAt.ms,
      routineName: null, preserveOtherSets: true, sets: [{ id: 'set00003', exerciseId: 'bench-press', setNumber: 3, weightKg: 80,
        reps: 5, completedAt: DEFAULT_NOW - 1_000, kind: 'drop', rpe: 7.5, note: 'Recovered detail' }] },
  });
  assert.deepEqual(b.drawn(TrainingSet).filter((set) => !set.id.equals(added.id)), before);
  assert.deepEqual(setOf(b, added.id), new TrainingSetValue(added.id, sessionId, exerciseId, 80, 5, added.completedAt,
    'drop', 7.5, 'Recovered detail'), 'a recovered set receives its serial only when the server admits it');
  await a.sync();
  const expected = [before[0], changed, new TrainingSetValue(added.id, sessionId, exerciseId, 80, 5, added.completedAt, 'drop', 7.5, 'Recovered detail', 3)];
  assert.deepEqual(a.drawn(TrainingSet), expected);
  assert.deepEqual(b.drawn(TrainingSet), expected);
  assert.deepEqual(a.notices(GymRefusals), []);
  assert.deepEqual(b.notices(GymRefusals), []);
});

test('recovery validates retained timestamps and serial collisions without imposing a total 200-set cap', async (t) => {
  const a = await open(t);
  const sets = Array.from({ length: 200 }, (_, index) => imported(`set${String(index + 1).padStart(5, '0')}`));
  await importWorkout(a, sets);
  for (const number of [201, 202]) {
    const added = new CorrectedSet({ ...imported(`set${String(number).padStart(5, '0')}`), setNumber: number });
    committed(await a.runner.run(CorrectSession({ id: sessionId, requestId: `recover${number}`, startedAt, finishedAt,
      routineName: null, sets: [added], preserveOtherSets: true })));
    await a.sync();
  }
  const before = a.drawn(TrainingSet);
  assert.deepEqual(before.map((set) => ({ id: set.id.record, number: set.setNumber })),
    Array.from({ length: 202 }, (_, index) => ({ id: `set${String(index + 1).padStart(5, '0')}`, number: index + 1 })));
  const added = new CorrectedSet({ ...imported('set00203'), setNumber: 1 });
  const collision = await a.runner.run(CorrectSession({ id: sessionId, requestId: 'recover203', startedAt, finishedAt,
    routineName: null, sets: [added], preserveOtherSets: true }));
  assert.deepEqual(collision.kind === 'refused' && refusalForm(collision.refusal),
    { invalid: { rule: 'session.sets', path: 'sets', reason: 'custom', custom: 'invalid' } });
  const interval = await a.runner.run(CorrectSession({ id: sessionId, requestId: 'recover204', startedAt: finishedAt, finishedAt,
    routineName: null, sets: [new CorrectedSet({ ...added, completedAt: finishedAt, setNumber: 203 })], preserveOtherSets: true }));
  assert.deepEqual(interval.kind === 'refused' && refusalForm(interval.refusal),
    { badInstant: { code: 'bad-instant', subject: sessionId.ref, detail: null, path: 'predicted' } });
  assert.deepEqual(a.drawn(TrainingSet), before);
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  assert.deepEqual(a.notices(GymRefusals), []);
});

for (const correcting of [false, true]) test(`${correcting ? 'correction' : 'import'} receipt replay after deletion and clock rollback never revives a set`, async (t) => {
  const a = await open(t);
  const input = imported('set00001');
  const importedAction = ImportSession({ id: sessionId, startedAt, finishedAt, sets: [input] });
  committed(await a.runner.run(importedAction));
  await a.sync();
  const correctedAction = CorrectSession({ id: sessionId, requestId: 'request1', startedAt, finishedAt, routineName: 'Corrected',
    sets: [correction(setOf(a, input.id), { weightKg: 90 })] });
  if (correcting) { committed(await a.runner.run(correctedAction)); await a.sync(); }
  const before = a.drawn(Session);
  committed(await a.runner.run(DeleteSet(input.id)));
  await a.advance(CONSTANTS.HOLD_MS);
  await a.sync();
  await a.advance(-CONSTANTS.HOLD_MS - 1_000);
  committed(await (correcting ? a.runner.run(correctedAction) : a.runner.run(importedAction)));
  await a.sync();
  assert.deepEqual(a.drawn(Session), before);
  assert.deepEqual(a.drawn(TrainingSet), []);
  assert.deepEqual(a.notices(GymRefusals), []);
});
