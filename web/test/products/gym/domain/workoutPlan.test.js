// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { PlanSnapshot, Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { OpenWorkout, PlanOperations, ReviseWorkoutPlan } from '../../../../src/products/gym/domain/workoutPlan.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../src/products/gym/domain/gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('../../../../src/platform/domain-kit/refusals.js').DomainNotice<GymRefusal>} Notice */

/** @param {import('node:test').TestContext} t */
async function inFlight(t) {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope });
  t.after(() => a.close());
  a.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const routine = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [
    new RoutineEntry(new Id('bench-press', Exercise), [new SetTarget(5, 80), new SetTarget(5, 80)], 120),
    new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, null)])]);
  assert.equal((await a.runner.save(Draft.new(routine), GymRefusals)).result.kind, 'saved');
  assert.equal((await a.runner.run(StartSession({ id: new Id('session1', Session), routineId: routine.id }))).kind, 'committed');
  await a.sync();
  const b = await a.device();
  await a.sync();
  const base = PlanSnapshot.fromRoutine(routine);
  assert.deepEqual(b.runner.read(Session.scope, (read) => OpenWorkout.of(read, new Id('session1', Session)).plan), base);
  return { a, b, base, sessionId: new Id('session1', Session) };
}

/** @param {{ kind: string }} outcome */
function committed(outcome) { assert.equal(outcome.kind, 'committed'); }

test('a revised plan lands on every phone and the second revision of one base returns stale', async (t) => {
  const { a, b, base, sessionId } = await inFlight(t);
  committed(await a.runner.run(ReviseWorkoutPlan({ sessionId, base, operations: [PlanOperations.setRest(1, 90)] })));
  committed(await b.runner.run(ReviseWorkoutPlan({ sessionId, base, operations: [PlanOperations.addMovement(new Id('dip', Exercise))] })));
  await a.sync();
  const revised = new PlanSnapshot(base.routine, [base.entries[0] ?? assert.fail(), new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, null)], 90)]);
  for (const phone of [a, b]) assert.deepEqual(phone.drawn(Session).map((session) => session.plan?.json), [revised.json]);
  assert.deepEqual(a.notices(GymRefusals), []);
  assert.deepEqual(b.notices(GymRefusals).map((/** @type {Notice} */ notice) => notice.refusal.kind), ['stale']);
  const again = await b.runner.run(ReviseWorkoutPlan({ sessionId, base, operations: [PlanOperations.addMovement(new Id('dip', Exercise))] }));
  assert.equal(again.kind === 'refused' ? again.refusal.kind : again.kind, 'stale');
});

test('a movement logged on one phone refuses another phone\'s revision of it as plan-logged and keeps its plan', async (t) => {
  const { a, b, base, sessionId } = await inFlight(t);
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), sessionId, new Id('bench-press', Exercise), 80, 5, new Instant(DEFAULT_NOW));
  committed(await a.runner.run(AppendSet(set)));
  committed(await b.runner.run(ReviseWorkoutPlan({ sessionId, base, operations: [PlanOperations.retarget(0, 1, new SetTarget(5, 85))] })));
  await a.sync();
  for (const phone of [a, b]) assert.deepEqual(phone.drawn(Session).map((session) => session.plan?.json), [base.json]);
  assert.deepEqual(b.notices(GymRefusals).map((/** @type {Notice} */ notice) => refusalForm(notice.refusal)),
    [{ planLogged: { code: 'plan-logged', subject: { t: 'session', id: 'session1' }, detail: { exerciseId: 'bench-press' }, path: 'notice' } }]);
  const refused = await b.runner.run(ReviseWorkoutPlan({ sessionId, base, operations: [PlanOperations.retarget(0, 1, new SetTarget(5, 85))] }));
  assert.deepEqual(refused.kind === 'refused' ? refusalForm(refused.refusal) : refused.kind,
    { planLogged: { code: 'plan-logged', subject: { t: 'session', id: 'session1' }, detail: { exerciseId: 'bench-press' }, path: 'predicted' } });
});
