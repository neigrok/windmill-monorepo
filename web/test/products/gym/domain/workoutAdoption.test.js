// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { Session, TrainingSet, TrainingSetValue } from '../../../../src/products/gym/domain/training.js';
import { AppendSet, CorrectSet, FinishSession, StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { AdoptWorkout, SignedOutWorkout } from '../../../../src/products/gym/domain/workoutAdoption.js';
import { ProposeWorkout, WorkoutProposal } from '../../../../src/products/gym/domain/workoutProposals.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @param {import('node:test').TestContext} t */
async function signedOut(t) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope, anonymous: true });
  t.after(() => phone.close());
  return phone;
}

/** @param {{ kind: string }} outcome */
function committed(outcome) { assert.equal(outcome.kind, 'committed'); }

/** @param {Harness} phone */
const commands = (phone) => phone.runner.read(Session.scope, (read) => read.commands());
/** @param {Harness} phone */
const saved = (phone) => phone.runner.read(Session.scope, (read) => SignedOutWorkout.read(read));

test('a finished signed-out workout becomes one import that supersedes its whole chain, once', async (t) => {
  const phone = await signedOut(t);
  const id = new Id('session1', Session), start = new Instant(DEFAULT_NOW - 10_000);
  committed(await phone.runner.run(StartSession({ id, startedAt: start })));
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), id, new Id('bench-press', Exercise), 60, 8, new Instant(start.ms + 1_000), 7.5, 'Durable full set');
  committed(await phone.runner.run(AppendSet(set)));
  const corrected = new TrainingSetValue(set.id, id, set.exerciseId, 62.5, 8, set.completedAt, 7.5, set.note);
  committed(await phone.runner.run(CorrectSet(corrected)));
  committed(await phone.runner.run(FinishSession({ id, finishedAt: new Instant(start.ms + 2_000) })));
  phone.failNextCommit();
  await assert.rejects(phone.runner.run(AdoptWorkout(id, 'prepare')));
  assert.deepEqual(phone.drawn(TrainingSet).map((value) => value.fields()), [corrected.fields()]);
  assert.deepEqual(saved(phone), []);
  assert.equal(commands(phone).filter((queued) => queued.command.name === 'gym.start').length, 1);
  committed(await phone.runner.run(AdoptWorkout(id, 'prepare')));
  const [imported, ...rest] = commands(phone);
  assert.deepEqual([imported?.command.name, rest], ['gym.importSession', []]);
  assert.equal(/** @type {any} */ (imported?.command.args.sets)?.[0]?.weightKg, 62.5);
  assert.equal((await phone.runner.run(AdoptWorkout(id, 'prepare'))).kind, 'unchanged');
  const [copy, ...others] = saved(phone);
  assert.ok(copy);
  assert.deepEqual(others, []);
  assert.deepEqual(copy.sets.map((value) => value.weightKg), [62.5]);
  assert.equal(jcs(SignedOutWorkout.decode(copy.json).json), jcs(copy.json));
  assert.deepEqual(phone.drawn(TrainingSet).map((value) => value.id.record), ['set00001']);
});

test('an open signed-out workout keeps its start, which does not join, and its sets, and is saved for recovery', async (t) => {
  const phone = await signedOut(t);
  const id = new Id('session1', Session);
  committed(await phone.runner.run(StartSession({ id })));
  const set = new TrainingSetValue(new Id('set00001', TrainingSet), id, new Id('bench-press', Exercise), 20, 5, new Instant(DEFAULT_NOW));
  committed(await phone.runner.run(AppendSet(set)));
  assert.notEqual((await phone.runner.run(AdoptWorkout(id, 'prepare'))).kind, 'refused');
  const [copy, ...others] = saved(phone);
  assert.ok(copy);
  assert.deepEqual(others, []);
  assert.equal(copy.session.isOpen, true);
  assert.deepEqual(copy.finishedAt, set.completedAt);
  assert.deepEqual(copy.sets.map((value) => value.fields()), [set.fields()]);
  assert.deepEqual(phone.drawn(TrainingSet).map((value) => value.fields()), [set.fields()]);
  assert.notEqual((await phone.runner.run(AdoptWorkout(id, 'prepare'))).kind, 'refused');
  assert.equal(jcs(saved(phone).map((each) => each.json)), jcs([copy.json]));
  assert.deepEqual(commands(phone).map((queued) => [queued.command.name, queued.command.args.joinOpenSession]), [['gym.start', false]]);
  assert.equal((await phone.runner.run(AdoptWorkout(id, 'keep'))).kind, 'refused');
  assert.equal(commands(phone).length, 1);
});

// An open copy holds the proposals waiting on it for the account, which reissues them once it takes the workout; they stay
// queued behind the copy's start, which does not join, so a refused start folds them into its notice.
test('an open copy holds the proposals waiting on it, and a finished one none', async (t) => {
  /** @param {import('node:test').TestContext} context */
  const workout = async (context) => {
    const phone = await signedOut(context);
    const routine = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [
      new RoutineEntry(new Id('bench-press', Exercise), [new SetTarget(5, 80)], 120),
      new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, null)])]);
    assert.equal((await phone.runner.save(Draft.new(routine), GymRefusals)).result.kind, 'saved');
    committed(await phone.runner.run(StartSession({ id: new Id('session1', Session), routineId: routine.id })));
    const proposal = new Id('wproposal1', WorkoutProposal);
    committed(await phone.runner.run(ProposeWorkout({ id: proposal, sessionId: new Id('session1', Session), entries: [...routine.entries].reverse(),
      summary: 'Sore shoulder' })));
    return { phone, proposal, entries: [...routine.entries].reverse() };
  };
  const { phone, proposal, entries } = await workout(t);
  assert.notEqual((await phone.runner.run(AdoptWorkout(new Id('session1', Session), 'prepare'))).kind, 'refused');
  const [held] = saved(phone);
  assert.ok(held);
  assert.deepEqual(held.proposals.map((each) => each.id.record), [proposal.record]);
  assert.equal(jcs(held.proposals[0]?.document.map((entry) => entry.json) ?? null), jcs(entries.map((entry) => entry.json)));
  assert.equal(jcs(SignedOutWorkout.decode(held.json).json), jcs(held.json));
  assert.deepEqual(phone.stored(WorkoutProposal).map((each) => each.id.record), [proposal.record]);
  assert.deepEqual(phone.notices(GymRefusals), []);

  const finishing = await workout(t);
  committed(await finishing.phone.runner.run(FinishSession({ id: new Id('session1', Session), finishedAt: new Instant(DEFAULT_NOW) })));
  assert.notEqual((await finishing.phone.runner.run(AdoptWorkout(new Id('session1', Session), 'prepare'))).kind, 'refused');
  assert.deepEqual(saved(finishing.phone)[0]?.proposals, []);
});
