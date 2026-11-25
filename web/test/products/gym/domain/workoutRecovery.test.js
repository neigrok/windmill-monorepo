// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Decision } from '../../../../src/platform/domain-kit/actions.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Plan } from '../../../../src/platform/domain-kit/plans.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Catalogue, Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session, SessionValue, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, CorrectSet, FinishSession, ImportedSet, ImportSession, StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { TrainingLog } from '../../../../src/products/gym/domain/trainingReads.js';
import { AdoptWorkout, ReconcileAdoptedWorkouts, SignedOutWorkout } from '../../../../src/products/gym/domain/workoutAdoption.js';
import { DiscardSignedOutWorkout, RecoverStrandedSets, SaveRefusedStart, SetFix, WorkoutFix, WorkoutRecovery } from '../../../../src/products/gym/domain/workoutRecovery.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

const minute = 60_000;
const bench = new Id('bench-press', Exercise);

// The saved copies a device holds after a sign-in, written straight into the device key.
/** @param {readonly SignedOutWorkout[]} workouts */
function SaveSignedOutWorkouts(workouts) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {import('../../../../src/platform/domain-kit/reading.js').Reader} read */
    load: (read) => SignedOutWorkout.read(read),
    /** @param {readonly SignedOutWorkout[]} saved */
    decide: (saved) => {
      const plan = new Plan();
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(saved, workouts));
      return Decision.write(plan, null);
    },
  });
}

// A saved copy of one movement, its sets at the offsets from its start, finished when `finish` is given.
/** @param {string} id @param {number} start @param {readonly number[]} offsets @param {number | null} [finish] */
function copyOf(id, start, offsets, finish = null) {
  const session = new SessionValue(new Id(id, Session), new Instant(start), finish === null ? null : new Instant(finish), finish === null ? null : 'finish');
  return new SignedOutWorkout(session, offsets.map((offset, index) =>
    new TrainingSetValue(new Id(`${id}-set-${index}`, TrainingSet), session.id, bench, 60 + index, 5, new Instant(start + offset))));
}

/** @param {import('node:test').TestContext} t */
async function account(t) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  return phone;
}

/** @param {{ kind: string }} outcome */
function committed(outcome) { assert.equal(outcome.kind, 'committed'); }

/** @param {Harness} phone */
function review(phone) {
  const notices = phone.notices(GymRefusals);
  return phone.runner.read(Session.scope, (read) => WorkoutRecovery.review(SignedOutWorkout.read(read), notices, new TrainingLog(read), new Catalogue(read)));
}

/** @param {WorkoutRecovery} recovery */
const row = (recovery) => ({ id: recovery.id.record, reason: recovery.reason, retry: recovery.retry, notices: recovery.noticeIds.length,
  stranded: recovery.strandedSets.map((set) => set.id.record) });

/** @param {Harness} phone */
const saved = (phone) => phone.runner.read(Session.scope, (read) => SignedOutWorkout.read(read));

// A signed-out workout restarted while another device's start is on its way: the account refuses it `session-open` with
// its sets, the copy waits while that workout is open, and once it finishes the retry lands the workout whole.
test('an open copy that loses the race for the account\'s open workout waits while it stands, then lands with every set', async (t) => {
  const phone = await account(t);
  const browser = await phone.device();
  await phone.sync();
  const accountOpen = new Id('account-open', Session);
  committed(await phone.runner.run(StartSession({ id: accountOpen, startedAt: new Instant(DEFAULT_NOW - 10 * minute) })));
  const copy = copyOf('copyC001', DEFAULT_NOW - 30 * minute, [minute, 2 * minute]);
  committed(await browser.runner.run(SaveSignedOutWorkouts([copy])));
  committed(await browser.runner.run(AdoptWorkout(copy.session.id, 'restart')));
  await phone.sync();
  assert.deepEqual(browser.drawn(Session).map((session) => session.id.record), ['account-open']);
  assert.deepEqual(browser.drawn(TrainingSet), []);
  assert.deepEqual(review(browser).map(row), [{ id: 'copyC001', reason: 'session-open', retry: 'restartWorkout', notices: 1, stranded: [] }]);
  assert.equal((await browser.runner.run(AdoptWorkout(copy.session.id, 'restart'))).kind, 'refused');

  committed(await phone.runner.run(FinishSession({ id: accountOpen })));
  await phone.sync();
  assert.deepEqual(review(browser).map(row), [{ id: 'copyC001', reason: 'unsent', retry: 'restartWorkout', notices: 1, stranded: [] }]);
  committed(await browser.runner.run(AdoptWorkout(copy.session.id, 'restart')));
  await phone.sync();
  for (const device of [phone, browser]) {
    assert.deepEqual(device.drawn(TrainingSet).map((set) => [set.id.record, set.sessionId.record]), [['copyC001-set-0', 'copyC001'], ['copyC001-set-1', 'copyC001']]);
  }
  committed(await browser.runner.run(ReconcileAdoptedWorkouts()));
  assert.deepEqual(saved(browser), []);
  assert.deepEqual(review(browser), []);
});

// Two devices start with no connection at once and the phone's start lands first: the browser's is refused `session-open`,
// its sets folded into the notice. Saved from the notice, they wait under the account's open workout, and Keep as finished
// lands them as a workout of their own while that one is still open.
test('a start that lost the race keeps its sets: saved from its notice, reviewed under the account\'s open workout and kept as finished', async (t) => {
  const phone = await account(t);
  const browser = await phone.device();
  await phone.sync();
  const theirs = new Id('phoneOpen', Session), lost = new Id('lostS001', Session);
  committed(await phone.runner.run(StartSession({ id: theirs, startedAt: new Instant(DEFAULT_NOW - 30 * minute) })));
  committed(await browser.runner.run(StartSession({ id: lost, startedAt: new Instant(DEFAULT_NOW - 25 * minute) })));
  const first = new TrainingSetValue(new Id('setS0001', TrainingSet), lost, bench, 60, 5, new Instant(DEFAULT_NOW - 20 * minute));
  const second = new TrainingSetValue(new Id('setS0002', TrainingSet), lost, bench, 62.5, 5, new Instant(DEFAULT_NOW - 15 * minute));
  committed(await browser.runner.run(AppendSet(first)));
  committed(await browser.runner.run(AppendSet(second)));
  committed(await browser.runner.run(CorrectSet(new TrainingSetValue(first.id, lost, bench, 65, 5, first.completedAt))));
  await phone.sync();
  assert.deepEqual(browser.drawn(Session).map((session) => session.id.record), ['phoneOpen']);
  assert.deepEqual(browser.drawn(TrainingSet), []);
  const [notice, ...others] = browser.notices(GymRefusals);
  assert.ok(notice);
  assert.deepEqual([notice.notice.code, others], ['session-open', []]);

  committed(await browser.runner.run(SaveRefusedStart(notice)));
  assert.equal((await browser.runner.run(SaveRefusedStart(notice))).kind, 'unchanged');
  assert.deepEqual(saved(browser).map((copy) => [copy.session.id.record, copy.session.isOpen, copy.sets.map((set) => [set.id.record, set.weightKg])]),
    [['lostS001', true, [['setS0001', 65], ['setS0002', 62.5]]]]);
  const [recovery] = review(browser);
  assert.ok(recovery);
  assert.deepEqual(row(recovery), { id: 'lostS001', reason: 'session-open', retry: 'restartWorkout', notices: 1, stranded: [] });
  assert.equal((await browser.runner.run(AdoptWorkout(lost, 'restart'))).kind, 'refused');

  committed(await browser.runner.run(AdoptWorkout(lost, 'keep', WorkoutFix.ofRecovery(recovery).markFinished().workout)));
  await phone.sync();
  for (const device of [phone, browser]) {
    assert.deepEqual(device.drawn(Session).map((session) => [session.id.record, session.finishedAt?.ms ?? null]),
      [['lostS001', second.completedAt.ms], ['phoneOpen', null]]);
    assert.deepEqual(device.drawn(TrainingSet).map((set) => [set.id.record, set.weightKg]), [['setS0001', 65], ['setS0002', 62.5]]);
  }
  committed(await browser.runner.run(ReconcileAdoptedWorkouts()));
  assert.deepEqual([saved(browser), review(browser)], [[], []]);
});

test('a finished copy crossing a workout on the log is refused before the account sees it, fixed, kept and let go once taken', async (t) => {
  const phone = await account(t);
  const onTheLog = new Id('on-the-log', Session);
  committed(await phone.runner.run(ImportSession({ id: onTheLog, startedAt: new Instant(DEFAULT_NOW - 60 * minute), finishedAt: new Instant(DEFAULT_NOW - 30 * minute),
    sets: [new ImportedSet({ id: new Id('logged01', TrainingSet), exerciseId: bench, weightKg: 80, reps: 5, completedAt: new Instant(DEFAULT_NOW - 45 * minute) })] })));
  await phone.sync();
  const copy = copyOf('copyA001', DEFAULT_NOW - 40 * minute, [minute], DEFAULT_NOW - 35 * minute);
  committed(await phone.runner.run(SaveSignedOutWorkouts([copy])));
  const [recovery] = review(phone);
  assert.ok(recovery);
  assert.deepEqual(row(recovery), { id: 'copyA001', reason: 'session-overlap', retry: 'importWorkout', notices: 0, stranded: [] });
  const keep = await phone.runner.run(AdoptWorkout(copy.session.id, 'keep'));
  assert.deepEqual(keep.kind === 'refused' && refusalForm(keep.refusal),
    { sessionOverlap: { code: 'session-overlap', subject: { t: 'session', id: 'copyA001' }, detail: { sessionId: 'on-the-log' }, path: 'predicted' } });

  const fix = WorkoutFix.ofRecovery(recovery).with({ startedAt: new Instant(DEFAULT_NOW - 20 * minute), finishedAt: new Instant(DEFAULT_NOW - 10 * minute),
    sets: [new SetFix({ id: new Id('copyA001-set-0', TrainingSet), exerciseId: bench, weightKg: 62.5, reps: 5, rpe: null, note: '', completedAt: new Instant(DEFAULT_NOW - 15 * minute) })] });
  const log = phone.runner.read(Session.scope, (read) => ({ log: new TrainingLog(read), catalogue: new Catalogue(read) }));
  assert.equal(fix.isChanged, true);
  assert.equal(fix.refusal(log.log.moment, log.log.drawnSessions, log.catalogue), null);
  committed(await phone.runner.run(AdoptWorkout(copy.session.id, 'keep', fix.workout)));
  assert.equal(jcs(saved(phone).map((each) => each.json)), jcs([fix.workout.json]));
  await phone.sync();
  assert.deepEqual(phone.drawn(Session).find((session) => session.id.equals(copy.session.id))?.finishedAt, new Instant(DEFAULT_NOW - 10 * minute));
  committed(await phone.runner.run(ReconcileAdoptedWorkouts()));
  assert.deepEqual(saved(phone), []);
});

test('a landed workout takes its stranded sets back, and the sets outside its window become a copy of their own that lands', async (t) => {
  const phone = await account(t);
  const landed = copyOf('sessionL', DEFAULT_NOW - 60 * minute, [10 * minute, 20 * minute, 40 * minute], DEFAULT_NOW - 30 * minute);
  const [first] = landed.sets;
  assert.ok(first);
  committed(await phone.runner.run(ImportSession({ id: landed.session.id, startedAt: landed.session.startedAt, finishedAt: new Instant(DEFAULT_NOW - 30 * minute),
    sets: [new ImportedSet({ id: first.id, exerciseId: bench, weightKg: first.weightKg, reps: first.reps, completedAt: first.completedAt, note: '', rpeNamed: true })] })));
  await phone.sync();
  committed(await phone.runner.run(SaveSignedOutWorkouts([landed])));
  assert.deepEqual(review(phone).map(row), [{ id: 'sessionL', reason: 'unsent', retry: 'restoreSets', notices: 0, stranded: ['sessionL-set-1', 'sessionL-set-2'] }]);

  committed(await phone.runner.run(RecoverStrandedSets(landed.session.id, 'intoWorkout')));
  committed(await phone.runner.run(RecoverStrandedSets(landed.session.id, 'separately')));
  await phone.sync();
  const sets = phone.drawn(TrainingSet);
  assert.deepEqual(sets.filter((set) => set.sessionId.equals(landed.session.id)).map((set) => [set.id.record, set.setNumber]),
    [['sessionL-set-0', 1], ['sessionL-set-1', 2]]);
  const separate = sets.find((set) => set.id.record === 'sessionL-set-2');
  assert.ok(separate && !separate.sessionId.equals(landed.session.id));
  assert.deepEqual(phone.drawn(Session).find((session) => session.id.equals(separate.sessionId))?.finishedAt, separate.completedAt);
  committed(await phone.runner.run(ReconcileAdoptedWorkouts()));
  assert.deepEqual(saved(phone), []);
  assert.deepEqual(review(phone), []);
});

test('discard drops one saved copy, and the device row with the last', async (t) => {
  const phone = await account(t);
  const one = copyOf('copyA001', DEFAULT_NOW - 40 * minute, [minute], DEFAULT_NOW - 35 * minute);
  const two = copyOf('copyB001', DEFAULT_NOW - 30 * minute, [minute], DEFAULT_NOW - 25 * minute);
  committed(await phone.runner.run(SaveSignedOutWorkouts([one, two])));
  committed(await phone.runner.run(DiscardSignedOutWorkout(one.session.id)));
  assert.deepEqual(saved(phone).map((each) => each.session.id.record), ['copyB001']);
  committed(await phone.runner.run(DiscardSignedOutWorkout(two.session.id)));
  assert.equal(phone.runner.read(Session.scope, (read) => read.device(SignedOutWorkout.key)), null);
  assert.equal((await phone.runner.run(DiscardSignedOutWorkout(two.session.id))).kind, 'unchanged');
});
