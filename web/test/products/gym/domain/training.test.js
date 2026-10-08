// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { DecodeError, Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { Reader, Views } from '../../../../src/platform/domain-kit/reading.js';
import { FixedZone, Instant, Moment } from '../../../../src/platform/domain-kit/time.js';
import { Valid } from '../../../../src/platform/domain-kit/validation.js';
import { Path, Violation } from '../../../../src/platform/domain-kit/values.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { PlanSnapshot } from '../../../../src/products/gym/domain/routines.js';
import { Session, SessionRules, SessionValue, SetRules, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { EstimatedFact, GymEstimate, MovementSessionFact, PerformedFact, ProgressSession, StatsProgress } from '../../../../src/products/gym/domain/trainingReads.js';
import { SignedOutWorkout } from '../../../../src/products/gym/domain/workoutAdoption.js';

const sessionId = new Id('session1', Session);
const exerciseId = new Id('back-squat', Exercise);
const moment = new Moment(new Instant(1_800_000_000_000), new FixedZone(0));

/** @param {string} id @param {Id<SessionValue>} session @param {number} at @param {number | null} number @param {Id<import('../../../../src/products/gym/domain/catalogue.js').ExerciseValue>} exercise */
function performed(id = 'set00001', session = sessionId, at = 2000, number = null, exercise = exerciseId) {
  return new TrainingSetValue(new Id(id, TrainingSet), session, exercise, 80, 5, new Instant(at), 'working', null, '', number);
}

test('an unreadable frozen plan retains its exact JSON while session facts remain usable', () => {
  const values = new SessionValue(sessionId, new Instant(1000)).fields();
  for (const plan of [false, 42, [], { routine: 42, entries: [] }, { routine: 'legacy', entries: 'broken', extra: ['e\u0301', null] }]) {
    const session = Session.decode(Fields.values('session', sessionId.record, { ...values, plan }));
    assert.equal(session.planUnreadable, true);
    assert.equal(session.plan, null);
    assert.equal(session.name, null);
    assert.deepEqual(session.fields(), { ...values, plan });
    assert.deepEqual(SessionRules.drawn(session, [], moment.now).fields().plan, plan);
    assert.deepEqual(SessionRules.finish(session, new Instant(2000)).fields().plan, plan);
    assert.deepEqual(SignedOutWorkout.decode(new SignedOutWorkout(session, []).json).session.fields().plan, plan);
    assert.throws(() => PlanSnapshot.decode(plan), DecodeError);
  }
  assert.equal(Session.decode(Fields.values('session', sessionId.record, values)).planUnreadable, false);
  assert.throws(() => Session.decode(Fields.values('session', sessionId.record, { ...values, startedAt: 'broken', plan: false })), DecodeError);
});

test('indexed progress keeps session and exercise identities separate when their record IDs match', () => {
  const session = new Id('same', Session), exercise = new Id('same', Exercise);
  const set = performed('set00001', session, 2000, null, exercise);
  const fact = new PerformedFact(set);
  const progress = StatsProgress.fromSessions([new ProgressSession(session, new Instant(1000), [
    new MovementSessionFact(exercise, 1, fact, fact, new EstimatedFact(set, /** @type {number} */ (set.e1rm))),
  ])], moment.now);
  assert.equal(progress.movement(exercise).sessions.length, 1);
  assert.equal(progress.sessionEstimate(session), set.e1rm);
  assert.deepEqual(progress.movement(/** @type {any} */ (session)).sessions, []);
  assert.equal(progress.sessionEstimate(/** @type {any} */ (exercise)), null);
});

test('stale closure uses its own last activity and includes the four-hour boundary', () => {
  const session = new SessionValue(sessionId, new Instant(1000));
  const own = performed();
  const foreign = performed('set00002', new Id('session2', Session), 9000);
  assert.equal(SessionRules.lastActivity(session, [foreign]), session.startedAt);
  assert.equal(SessionRules.lastActivity(session, [foreign, own]), own.completedAt);
  assert.equal(SessionRules.autoCloseAt(session, [own], new Instant(2000 + SessionRules.staleAfterMs - 1)), null);
  const drawn = SessionRules.drawn(session, [own, foreign], new Instant(2000 + SessionRules.staleAfterMs));
  assert.deepEqual(drawn, new SessionValue(sessionId, session.startedAt, own.completedAt, 'stale'));
  assert.equal(session.isOpen, true);
  assert.equal(Object.isFrozen(drawn), true);
  assert.equal(SessionRules.autoCloseAt(drawn, [own], moment.now), null);
});

test('start and finish bounds reject the adjacent invalid instants', () => {
  const session = new SessionValue(sessionId, new Instant(1000));
  for (const at of [0, 999, SessionRules.maxInstantMs + 1]) assert.equal(SessionRules.canFinishAt(session, new Instant(at)), false);
  for (const at of [1000, SessionRules.maxInstantMs]) assert.equal(SessionRules.canFinishAt(session, new Instant(at)), true);
  assert.equal(SessionRules.canStartAt(new Instant(1), moment.now), true);
  assert.equal(SessionRules.canStartAt(new Instant(moment.now.ms + SessionRules.maxClockAheadMs), moment.now), true);
  assert.equal(SessionRules.canStartAt(new Instant(moment.now.ms + SessionRules.maxClockAheadMs + 1), moment.now), false);
  assert.equal(SessionRules.canStartAt(new Instant(0), moment.now), false);
  assert.throws(() => SessionRules.finish(session, new Instant(999)), (error) => {
    assert.ok(error instanceof Violation);
    assert.deepEqual(error.json, { rule: 'session.finishedAt', path: 'finishedAt', reason: 'custom', custom: 'badInstant' });
    return true;
  });
  for (const [value, expected] of [[0, { reason: 'below', min: 1 }], [SessionRules.maxInstantMs + 1, { reason: 'above', max: SessionRules.maxInstantMs }]]) {
    assert.throws(() => SessionRules.instant(new Instant(/** @type {number} */ (value)), 'set.completedAt', new Path('completedAt')), (error) => {
      assert.ok(error instanceof Violation);
      assert.deepEqual(error.json, { rule: 'set.completedAt', path: 'completedAt', .../** @type {object} */ (expected) });
      return true;
    });
  }
});

test('only stale closure yields to finishing and late sets stop at its grace boundary', () => {
  const start = new Instant(1000);
  const finish = new Instant(2000);
  const open = new SessionValue(sessionId, start);
  assert.deepEqual(SessionRules.finish(open, finish), new SessionValue(sessionId, start, finish, 'finish'));
  for (const closedBy of [null, 'finish']) {
    const terminal = new SessionValue(sessionId, start, finish, closedBy);
    assert.equal(SessionRules.finish(terminal, new Instant(3000)), terminal);
    assert.equal(SessionRules.lateSetLands(terminal, new Instant(1500)), false);
  }
  const stale = new SessionValue(sessionId, start, finish, 'stale');
  for (const at of [1500, 2000, 2000 + SessionRules.staleAfterMs]) {
    assert.deepEqual(SessionRules.finish(stale, new Instant(at)), new SessionValue(sessionId, start, new Instant(Math.max(at, 2000)), 'finish'));
    assert.equal(SessionRules.lateSetLands(stale, new Instant(at)), true);
  }
  assert.deepEqual(SessionRules.finish(stale, new Instant(2001 + SessionRules.staleAfterMs)), new SessionValue(sessionId, start, finish, 'finish'));
  assert.equal(SessionRules.lateSetLands(stale, new Instant(2001 + SessionRules.staleAfterMs)), false);
  assert.equal(SessionRules.lateSetLands(open, new Instant(SessionRules.maxInstantMs)), true);
});

test('overlap uses half-open spans and one millisecond for zero duration', () => {
  const other = new SessionValue(new Id('session2', Session), new Instant(100), new Instant(200));
  assert.equal(SessionRules.crosses(new Instant(200), new Instant(300), other), false);
  assert.equal(SessionRules.crosses(new Instant(1), new Instant(100), other), false);
  assert.equal(SessionRules.crosses(new Instant(199), new Instant(199), other), true);
  assert.equal(SessionRules.crosses(new Instant(100), new Instant(100), new SessionValue(other.id, other.startedAt, other.startedAt)), true);
  assert.equal(SessionRules.crosses(new Instant(100), new Instant(200), new SessionValue(other.id, other.startedAt)), false);
});

test('set numbers preserve serial assignment, isolate identity pairs and refuse overflow', () => {
  const first = performed('set00001', sessionId, 1000, 1);
  const third = performed('set00003', sessionId, 2000, 3);
  const foreign = performed('set00004', sessionId, 3000, 100, new Id('bench-press', Exercise));
  assert.equal(SetRules.nextNumber([first, third, foreign], sessionId, exerciseId), 4);
  assert.equal(SetRules.nextNumber([first], new Id('session2', Session), exerciseId), 1);
  assert.equal(SetRules.nextNumber([performed('set00005', sessionId, 1000, SetRules.maxNumber)], sessionId, exerciseId), null);
  const decoded = TrainingSet.decode(new Fields({ type: 'set', path: '', id: first.id.record,
    values: { ...first.fields(), setNumber: 999 }, serials: { setNumber: 7 } }));
  assert.equal(decoded.setNumber, 7);
  assert.equal('setNumber' in decoded.fields(), false);
  assert.equal(Object.isFrozen(decoded), true);
});

test('set validation preserves untrimmed notes and serials while normalizing kilograms and effort', () => {
  const raw = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, exerciseId, -20.125, 5,
    new Instant(2000), 'working', 7.25, '  e\u0301  ', 3);
  const normalized = new Valid(raw, moment).value;
  assert.deepEqual(normalized, new TrainingSetValue(raw.id, sessionId, exerciseId, -20.13, 5,
    raw.completedAt, 'working', 7.3, '  e\u0301  ', 3));
  assert.equal(normalized.volumeKg, 0);
  assert.equal(normalized.e1rm, null);
});

test('estimate helpers enforce native finite-number and integer argument boundaries', () => {
  for (const reps of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, 11]) assert.equal(GymEstimate.value(80, reps), null);
  for (const weight of [Number.NaN, Number.POSITIVE_INFINITY, -20, 0]) assert.equal(GymEstimate.value(weight, 5), null);
  for (const rpe of [Number.NaN, Number.POSITIVE_INFINITY, 6.9]) assert.equal(GymEstimate.value(80, 5, 'working', rpe), null);
  assert.equal(GymEstimate.value(80, 1), 80);
});

test('saved workout reads round trip owned sets in deterministic order and reject malformed backups', () => {
  const session = new SessionValue(sessionId, new Instant(1000));
  const earlier = performed('set00001', sessionId, 2000);
  const tied = performed('set00002', sessionId, 2000);
  const foreign = performed('set00003', new Id('session2', Session), 1500);
  const saved = new SignedOutWorkout(session, [tied, foreign, earlier]);
  assert.deepEqual(saved.sets, [earlier, tied]);
  assert.equal(Object.isFrozen(saved.sets), true);
  assert.deepEqual(SignedOutWorkout.decode(saved.json), saved);
  const other = new SignedOutWorkout(new SessionValue(new Id('session0', Session), new Instant(1000)), []);
  const views = Views.ofRecords(registry, { drawn: [], stored: [], devices: { [SignedOutWorkout.key]: { session1: saved.json, session0: other.json } } });
  assert.deepEqual(SignedOutWorkout.read(new Reader(views, Session.scope, moment)), [other, saved]);
  assert.throws(() => SignedOutWorkout.decode({}), DecodeError);
  assert.throws(() => SignedOutWorkout.decode({ session: saved.json.session, sets: null }), DecodeError);
  assert.throws(() => SignedOutWorkout.decode({ session: saved.json.session, sets: [null] }), DecodeError);
});
