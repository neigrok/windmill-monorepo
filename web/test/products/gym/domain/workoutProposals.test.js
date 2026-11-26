// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { EditExercise, Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, RoutineRules } from '../../../../src/products/gym/domain/gymRules.js';
import { Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session } from '../../../../src/products/gym/domain/training.js';
import { StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { ApplyWorkoutProposal, ProposeWorkout, WorkoutProposal, WorkoutProposalState } from '../../../../src/products/gym/domain/workoutProposals.js';
import { Harness } from '../../../platform/domain-kit/harness.js';

test('a workout proposal reads under its floor exactly when its Apply refuses a load under a movement\'s floor, and is never out of date for it', async (t) => {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const pullUp = new Id('pull-up', Exercise);
  const routine = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [new RoutineEntry(pullUp, [new SetTarget(8, 10)])]);
  assert.equal((await phone.runner.save(Draft.new(routine), GymRefusals)).result.kind, 'saved');
  const sessionId = new Id('session1', Session);
  assert.equal((await phone.runner.run(StartSession({ id: sessionId, routineId: routine.id }))).kind, 'committed');
  await phone.sync();
  const id = new Id('proposal1', WorkoutProposal);
  assert.equal((await phone.runner.run(ProposeWorkout({ id, sessionId, entries: [new RoutineEntry(pullUp, [new SetTarget(8, -20)])],
    summary: '' }))).kind, 'committed');
  const read = () => phone.runner.read(Session.scope, (reader) => {
    const state = WorkoutProposalState.of(reader, id);
    return { underFloor: state.underFloor, outOfDate: state.outOfDate };
  });
  const assisted = read();
  const seed = SeedExercises.all.find((exercise) => exercise.id.equals(pullUp)) ?? assert.fail();
  assert.equal((await phone.runner.run(new EditExercise(seed, seed.name, 'barbell', 1))).kind, 'committed');
  const barbell = read();
  const applied = await phone.runner.run(ApplyWorkoutProposal(id));
  assert.deepEqual({ assisted, barbell, applied: applied.kind === 'refused' && applied.refusal.kind === 'invalid' ? applied.refusal.violation.rule : applied.kind },
    { assisted: { underFloor: false, outOfDate: null }, barbell: { underFloor: true, outOfDate: null }, applied: RoutineRules.loadFloor });
});
