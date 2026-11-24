// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../../src/platform/domain-kit/runner.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { PlanSnapshot, Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session, TrainingSet } from '../../../../src/products/gym/domain/training.js';
import { FinishSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { PlanOperations } from '../../../../src/products/gym/domain/workoutPlan.js';
import { DeleteRoutine } from '../../../../src/products/gym/domain/routines.js';
import {
  FinishWorkout, LogRackSet, RackRows, ReviseWorkout, SettleRack, StartWorkout, TurnRack, WorkoutRack,
} from '../../../../src/products/gym/domain/workoutRack.js';
import { Harness } from '../../../platform/domain-kit/harness.js';

const sessionId = new Id('session1', Session);
const bench = new Id('bench-press', Exercise);
const pullUp = new Id('pull-up', Exercise);
const dip = new Id('dip', Exercise);

// One browser with two tabs on its copy: each tab its own engine and runner over the one store.
/** @param {import('node:test').TestContext} t @param {{ routine?: boolean }} [options] */
async function browser(t, { routine = true } = {}) {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope });
  t.after(() => a.close());
  a.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const upper = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [
    new RoutineEntry(bench, [new SetTarget(8, 16), new SetTarget(8, 16)], 120), new RoutineEntry(pullUp, [new SetTarget(8, 10)])]);
  assert.equal((await a.runner.save(Draft.new(upper), GymRefusals)).result.kind, 'saved');
  assert.equal((await a.runner.run(StartWorkout({ id: sessionId, routineId: routine ? upper.id : null }))).kind, 'committed');
  const engine = await BrowserSyncEngine.open(a.options);
  t.after(() => engine.close());
  engine.observe(Session.scope);
  const tab = new ActionRunner(new EngineReplica(engine), registry, a.world.zone);
  // What the second tab draws once the first tab's write reaches it, as the tabs' coordination tells it.
  const drawn = async () => { await engine.refresh(); return rows(tab); };
  return { a, tab, drawn, plan: PlanSnapshot.fromRoutine(upper) };
}

/** @param {ActionRunner} runner */
const rack = (runner) => runner.read(Session.scope, (read) => WorkoutRack.of(read, sessionId));
/** @param {ActionRunner} runner */
const rows = (runner) => rack(runner).rows;
/** @param {{ kind: string }} outcome @param {string} kind */
const ended = (outcome, kind) => assert.equal(outcome.kind, kind);
/** @param {{ kind: string, refusal?: { kind: string } }} outcome */
const refusal = (outcome) => (outcome.kind === 'refused' ? outcome.refusal?.kind : outcome.kind);

test('a started workout settles on its first movement, the plan’s target on the rack and a set on offer', async (t) => {
  const { a } = await browser(t);
  assert.equal(rack(a.runner).isSettled, false);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  const settled = rows(a.runner);
  assert.deepEqual({ ...settled.rows, offer: typeof settled.offer }, {
    order: ['bench-press', 'pull-up'], movement: 'bench-press', offer: 'string',
    rack: { exerciseId: 'bench-press', weightKg: 16, reps: 8, touched: false, slot: '0:', target: { exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }], restSeconds: 120 } },
  });
  assert.equal(rack(a.runner).isSettled, true);
  ended(await a.runner.run(SettleRack(sessionId)), 'unchanged');
});

test('one tap in each of two tabs on one offer logs one set, and the rack moves to the next slot under a new offer', async (t) => {
  const { a, tab, drawn } = await browser(t);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  const offer = String((await drawn()).offer);
  const [first, second] = await Promise.all([
    a.runner.run(LogRackSet({ sessionId, offer, weightKg: 16, reps: 8 })),
    tab.run(LogRackSet({ sessionId, offer, weightKg: 16, reps: 8 })),
  ]);
  assert.deepEqual([first.kind, second.kind].sort(), ['committed', 'unchanged']);
  assert.deepEqual(a.drawn(TrainingSet).map((set) => [set.id.record, set.exerciseId.record, set.weightKg, set.reps]), [[offer, 'bench-press', 16, 8]]);
  const after = rows(a.runner);
  assert.notEqual(after.offer, offer);
  assert.deepEqual([after.movement?.record, after.rack?.weightKg, after.rack?.reps, after.rack?.slot], ['bench-press', 16, 8, `1:${offer}`]);
});

test('a load set in one tab makes the other tab’s offer stale, and the other tab’s tap logs nothing', async (t) => {
  const { a, tab, drawn } = await browser(t);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  const offer = String((await drawn()).offer);
  ended(await a.runner.run(TurnRack(sessionId, { weightKg: 18 })), 'committed');
  assert.equal(refusal(await tab.run(LogRackSet({ sessionId, offer, weightKg: 16, reps: 8 }))), 'stale');
  assert.deepEqual(a.drawn(TrainingSet), []);
  const turned = await drawn();
  assert.deepEqual([turned.rack?.weightKg, turned.rack?.touched], [18, true]);
  ended(await tab.run(LogRackSet({ sessionId, offer: String(turned.offer), weightKg: 18, reps: 8 })), 'committed');
  assert.deepEqual(tab.read(Session.scope, (read) => read.repository(TrainingSet).all('drawn').map((set) => set.weightKg)), [18]);
});

test('a movement chosen fills the rack from its own plan, and a plan edit a second tab made stale is refused', async (t) => {
  const { a, tab, plan } = await browser(t);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  ended(await a.runner.run(TurnRack(sessionId, { movement: pullUp })), 'committed');
  assert.deepEqual([rows(a.runner).movement?.record, rows(a.runner).rack?.weightKg], ['pull-up', 10]);
  ended(await a.runner.run(ReviseWorkout({ sessionId, base: plan, operations: [PlanOperations.swap(1, dip)] })), 'committed');
  assert.deepEqual(rows(a.runner).rows.order, ['bench-press', 'dip']);
  assert.equal(rows(a.runner).movement?.record, 'dip');
  assert.equal(refusal(await tab.run(ReviseWorkout({ sessionId, base: plan, operations: [PlanOperations.setRest(0, 90)] }))), 'stale');
});

test('a workout with no plan holds the movements it adds, and Finish takes its rows with it', async (t) => {
  const { a } = await browser(t, { routine: false });
  ended(await a.runner.run(SettleRack(sessionId)), 'unchanged');
  assert.deepEqual(rows(a.runner).rows, { order: null, movement: null, rack: null, offer: null });
  ended(await a.runner.run(TurnRack(sessionId, { adding: dip })), 'committed');
  const added = rows(a.runner);
  assert.deepEqual([added.rows.order, added.movement?.record, typeof added.offer], [['dip'], 'dip', 'string']);
  ended(await a.runner.run(LogRackSet({ sessionId, offer: String(added.offer), weightKg: 0, reps: 10 })), 'committed');
  ended(await a.runner.run(FinishWorkout(sessionId)), 'committed');
  assert.deepEqual(rows(a.runner).rows, { order: null, movement: null, rack: null, offer: null });
  assert.equal(a.drawn(Session)[0]?.closedBy, 'finish');
});

test('a step of the ladder or the stepper in each of two tabs at once both count, each taken from the rack as it is written', async (t) => {
  const { a, tab, drawn } = await browser(t);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  await drawn();
  const steps = await Promise.all([
    a.runner.run(TurnRack(sessionId, { stepLoad: { direction: 1, big: false } })),
    tab.run(TurnRack(sessionId, { stepLoad: { direction: 1, big: false } })),
    a.runner.run(TurnRack(sessionId, { stepReps: 1 })),
    tab.run(TurnRack(sessionId, { stepReps: 1 })),
  ]);
  assert.deepEqual(steps.map((step) => step.kind), ['committed', 'committed', 'committed', 'committed']);
  const stepped = await drawn();
  assert.deepEqual([stepped.rack?.weightKg, stepped.rack?.reps, stepped.rack?.touched], [18, 10, true]);
  ended(await a.runner.run(TurnRack(sessionId, { stepLoad: { direction: -1, big: true } })), 'committed');
  assert.deepEqual([rows(a.runner).rack?.weightKg, rows(a.runner).rack?.reps], [15.5, 10], 'a big step down from 18 is the lighter rung’s 2.5');
  ended(await a.runner.run(TurnRack(sessionId, { stepReps: -1 })), 'committed');
  assert.equal(rows(a.runner).rack?.reps, 9);
});

test('the rows a workout that ended elsewhere left are cleared by the next workout’s first write', async (t) => {
  const { a } = await browser(t);
  ended(await a.runner.run(SettleRack(sessionId)), 'committed');
  ended(await a.runner.run(FinishSession({ id: sessionId })), 'committed');
  const left = () => a.runner.read(Session.scope, (read) => Object.values(RackRows.keys('session1')).map((key) => read.device(key)));
  assert.equal(left().filter((row) => row !== null && row !== undefined).length, 4, 'a finish on another device leaves this device’s rows');
  const next = new Id('session2', Session);
  ended(await a.runner.run(StartWorkout({ id: next, routineId: null })), 'committed');
  ended(await a.runner.run(TurnRack(next, { adding: dip })), 'committed');
  assert.deepEqual(left().map((row) => row ?? null), [null, null, null, null]);
  assert.deepEqual(a.runner.read(Session.scope, (read) => WorkoutRack.of(read, next).rows.order.map((id) => id.record)), ['dip']);
});

test('a start from a routine the log no longer draws is refused, and an added movement is refused stale on a workout with a plan', async (t) => {
  const { a, plan } = await browser(t);
  assert.equal(refusal(await a.runner.run(TurnRack(sessionId, { adding: dip }))), 'stale');
  assert.deepEqual(a.drawn(Session)[0]?.plan?.json, plan.json, 'the plan stands as it was');
  ended(await a.runner.run(FinishWorkout(sessionId)), 'committed');
  const routine = new Id('routine1', Routine);
  ended(await a.runner.run(DeleteRoutine(routine)), 'committed');
  assert.equal(refusal(await a.runner.run(StartWorkout({ id: new Id('session2', Session), routineId: routine }))), 'gone');
  assert.deepEqual(a.drawn(Session).map((session) => session.id.record), ['session1']);
});
