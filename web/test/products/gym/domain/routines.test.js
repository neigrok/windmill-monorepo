// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Catalogue, Exercise, ExerciseName, ExerciseValue } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { DeleteRoutine, PlanSnapshot, ReorderRoutines, Routine, RoutineEntry, RoutineValue, SaveRoutinePlan, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Harness } from '../../../platform/domain-kit/harness.js';

/** @param {import('node:test').TestContext} t */
async function open(t) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Routine.scope });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  return phone;
}

/** @param {string} id @param {number} position */
function draft(id = 'routine1', position = 0) {
  return Draft.new(new RoutineValue(new Id(id, Routine))).edit((value) => new RoutineValue(value.id, 'Lower A', position,
    [new RoutineEntry(new Id('back-squat', Exercise))]));
}

/** @param {RoutineValue} value @param {string} name */
function renamed(value, name) {
  return new RoutineValue(value.id, name, value.position, value.entries, value.revision, value.createdEntries, value.createdDoor);
}

/** @param {Harness} phone */
const fields = (phone) => RoutineValue.ordered(phone.drawn(Routine)).map((value) => ({ id: value.id.record, ...value.fields() }));

test('a stale routine keeps its draft and Keep mine rebases only the touched fields', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const created = draft();
  assert.equal((await a.runner.save(created, GymRefusals)).result.kind, 'saved');
  await a.sync();
  const original = a.runner.open(Routine, created.id);
  const remote = b.runner.open(Routine, created.id);
  assert.ok(original);
  assert.ok(remote);
  const mine = original.edit((value) => renamed(value, 'My lower'));
  const entries = [new RoutineEntry(new Id('dip', Exercise), [new SetTarget(8, 0)])];
  const theirs = remote.edit((value) => new RoutineValue(value.id, 'Another lower', 4, entries));
  assert.equal((await b.runner.save(theirs, GymRefusals)).result.kind, 'saved');
  await a.sync();
  const stale = await a.runner.save(mine, GymRefusals);
  assert.deepEqual(stale.result.kind === 'refused' && refusalForm(stale.result.refusal), {
    stale: { subject: created.id.ref, path: 'predicted' },
  });
  assert.equal(stale.draft, mine);
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  const latest = a.runner.open(Routine, created.id);
  assert.ok(latest);
  const rebased = stale.draft.rebased(latest.current);
  const kept = { name: 'My lower', position: 4, entries: [{ exerciseId: 'dip', sets: [{ reps: 8, weightKg: 0 }] }] };
  assert.deepEqual(rebased.touched, ['name']);
  assert.deepEqual(rebased.current.fields(), kept);
  const saved = await a.runner.save(rebased, GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  assert.equal(saved.draft.isDirty, false);
  assert.equal(saved.draft.isNew, false);
  assert.deepEqual(saved.draft.current.fields(), kept);
  const again = await a.runner.save(saved.draft.edit((value) => renamed(value, 'My next lower')), GymRefusals);
  assert.equal(again.result.kind, 'saved');
  await a.sync();
  assert.deepEqual(fields(a), [{ id: 'routine1', ...kept, name: 'My next lower' }]);
  assert.deepEqual(fields(b), fields(a));
  assert.deepEqual(a.notices(GymRefusals), []);
});

test('a failed routine save retains the draft and retry commits the same record', async (t) => {
  const a = await open(t);
  const editing = draft().edit((value) => renamed(value, ' Lower A '));
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  const failed = await a.runner.save(editing, GymRefusals);
  assert.equal(failed.result.kind, 'failed');
  assert.equal(failed.draft, editing);
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(fields(a), []);
  assert.deepEqual(a.env.failures, ['storage']);
  const saved = await a.runner.save(failed.draft, GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  assert.equal(saved.draft.isNew, false);
  assert.equal(saved.draft.isDirty, false);
  assert.deepEqual(saved.draft.current.fields(), { name: 'Lower A', position: 0, entries: [{ exerciseId: 'back-squat' }] });
  const unchanged = await a.runner.save(saved.draft, GymRefusals);
  assert.deepEqual(unchanged.result, { kind: 'saved', receipt: null });
  await a.sync();
  assert.deepEqual(fields(a), [{ id: 'routine1', ...saved.draft.current.fields() }]);
});

test('a routine plan retries one atomic catalogue and targets save after storage failure and survives restart', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const custom = new ExerciseValue(new Id('exercise1', Exercise), ' Single press ', 'press', 'dumbbell', 2, [], 1);
  const base = new RoutineValue(new Id('routine1', Routine));
  const current = new RoutineValue(base.id, ' Push ', 0, [new RoutineEntry(custom.id, [new SetTarget(8, 16)])]);
  const action = new SaveRoutinePlan(base, current, true, [{ base: null, current: custom }]);
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  await assert.rejects(a.runner.run(action));
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.env.failures, ['storage']);
  assert.deepEqual([a.drawn(Routine), a.drawn(Exercise), a.drawn(ExerciseName)], [[], [], []]);
  const saved = await a.runner.run(action);
  assert.equal(saved.kind, 'committed');
  assert.equal(saved.kind === 'committed' && saved.result.equals(base.id), true);
  assert.equal(a.engine.device.activeReplica.entries().length, 1);
  await a.restart();
  await a.sync();
  for (const phone of [a, b]) {
    assert.deepEqual(fields(phone), [{ id: 'routine1', name: 'Push', position: 0,
      entries: [{ exerciseId: 'exercise1', sets: [{ reps: 8, weightKg: 16 }] }] }]);
    assert.deepEqual(phone.drawn(Exercise).map((value) => ({ id: value.id.record, ...value.fields() })),
      [{ id: 'exercise1', name: 'Single press', pattern: 'press', equipment: 'dumbbell', stepKg: 2 }]);
    assert.deepEqual(phone.drawn(ExerciseName).map((value) => ({ id: value.id.record, ...value.fields() })),
      [{ id: 'exercise1', loadCount: 1 }]);
    const movement = phone.runner.read(Exercise.scope, (read) => new Catalogue(read).find(custom.id));
    assert.equal(movement?.loadCount, 1);
    assert.deepEqual(phone.notices(GymRefusals), []);
  }
});

test('a concurrent equipment edit refuses the entire routine plan with one notice and no renamed movement or new targets', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const seed = SeedExercises.all.find((exercise) => exercise.id.record === 'bench-press');
  assert.ok(seed);
  const base = new RoutineValue(new Id('routine1', Routine), 'Push', 0, [new RoutineEntry(seed.id)]);
  assert.equal((await a.runner.run(new SaveRoutinePlan(base, base, true, []))).kind, 'committed');
  await a.sync();
  const equipment = new ExerciseValue(seed.id, seed.name, seed.pattern, 'dumbbell', seed.stepKg, seed.aliases, 1);
  assert.equal((await a.runner.run(new SaveRoutinePlan(base, base, false, [{ base: seed, current: equipment }]))).kind, 'committed');
  const current = new RoutineValue(base.id, base.name, 0, [new RoutineEntry(seed.id, [new SetTarget(8, 60)])]);
  const rename = new ExerciseValue(seed.id, 'My press', seed.pattern, seed.equipment, seed.stepKg, seed.aliases, seed.loadCount);
  assert.equal((await b.runner.run(new SaveRoutinePlan(base, current, false, [{ base: seed, current: rename }]))).kind, 'committed');
  assert.deepEqual(b.runner.read(Exercise.scope, (read) => new Catalogue(read).find(seed.id)?.aliases), ['Bench Press']);
  await a.sync();
  assert.deepEqual(b.notices(GymRefusals).map((/** @type {import('../../../../src/platform/domain-kit/refusals.js').DomainNotice<import('../../../../src/products/gym/domain/gymRules.js').GymRefusal>} */ notice) => refusalForm(notice.refusal)),
    [{ stale: { subject: base.id.ref, path: 'notice' } }]);
  for (const phone of [a, b]) {
    assert.deepEqual(fields(phone), [{ id: 'routine1', ...base.fields() }]);
    const movement = phone.runner.read(Exercise.scope, /** @returns {ExerciseValue | null} */ (read) => new Catalogue(read).find(seed.id));
    assert.deepEqual(movement, equipment);
    assert.deepEqual(phone.drawn(ExerciseName).map((value) => ({ id: value.id.record, ...value.fields() })),
      [{ id: 'bench-press', equipment: 'dumbbell', loadCount: 1 }]);
  }
});

test('successive routine edits preserve local former names and count while no-op and hidden routine saves write nothing', async (t) => {
  const a = await open(t);
  const seed = SeedExercises.all.find((exercise) => exercise.id.record === 'bench-press');
  assert.ok(seed);
  const custom = new ExerciseValue(new Id('exercise1', Exercise), 'Single press', 'press', 'dumbbell', 2, [], 1);
  const base = new RoutineValue(new Id('routine1', Routine), 'Push', 0, [new RoutineEntry(seed.id), new RoutineEntry(custom.id)]);
  assert.equal((await a.runner.run(new SaveRoutinePlan(base, base, true, [{ base: null, current: custom }]))).kind, 'committed');
  const firstSeed = new ExerciseValue(seed.id, 'My press', seed.pattern, seed.equipment, seed.stepKg, seed.aliases, seed.loadCount);
  const firstCustom = new ExerciseValue(custom.id, 'First press', custom.pattern, custom.equipment, custom.stepKg, custom.aliases, custom.loadCount);
  assert.equal((await a.runner.run(new SaveRoutinePlan(base, base, false,
    [{ base: seed, current: firstSeed }, { base: custom, current: firstCustom }]))).kind, 'committed');
  const next = new ExerciseValue(custom.id, 'Next press', custom.pattern, custom.equipment, custom.stepKg, [], 1);
  assert.equal((await a.runner.run(new SaveRoutinePlan(base, base, false, [{ base: firstCustom, current: next }]))).kind, 'committed');
  await a.restart();
  const catalogue = a.runner.read(Exercise.scope, (read) => new Catalogue(read));
  assert.deepEqual(catalogue.find(custom.id), new ExerciseValue(custom.id, 'Next press', 'press', 'dumbbell', 2, ['First press', 'Single press'], 1));
  assert.deepEqual(catalogue.find(seed.id), new ExerciseValue(seed.id, 'My press', seed.pattern, seed.equipment, seed.stepKg, ['Bench Press'], 1));
  const beforeNoOp = (await a.engine.store.read()).device.toJSON();
  assert.deepEqual(await a.runner.run(new SaveRoutinePlan(base, base, false, [{ base: next, current: next }])),
    { kind: 'unchanged', result: base.id });
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), beforeNoOp);
  const removed = await a.runner.run(DeleteRoutine(base.id));
  assert.equal(removed.kind, 'committed');
  const beforeRefusal = (await a.engine.store.read()).device.toJSON();
  const refused = await a.runner.run(new SaveRoutinePlan(base, base, false, [{ base: next, current: custom }]));
  assert.deepEqual(refused.kind === 'refused' && refusalForm(refused.refusal), { gone: { subject: base.id.ref, path: 'predicted' } });
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), beforeRefusal);
  if (removed.kind === 'committed') assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(fields(a), [{ id: 'routine1', ...base.fields() }]);
});

test('routine reordering counts held deletions until Undo restores them', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const first = draft('routine1', 0);
  const second = draft('routine2', 1);
  await a.runner.save(first, GymRefusals);
  await a.runner.save(second, GymRefusals);
  await a.sync();
  const removed = await a.runner.run(DeleteRoutine(first.id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  assert.deepEqual(a.drawn(Routine).map((value) => value.id.record), ['routine2']);
  assert.equal(a.stored(Routine).length, 2);
  const reorder = await a.runner.run(ReorderRoutines([second.id]));
  assert.deepEqual(reorder.kind === 'refused' && refusalForm(reorder.refusal), {
    invalid: { rule: 'routine.order', path: 'order', reason: 'custom', custom: 'notPermutation' },
  });
  await a.sync();
  assert.equal(b.drawn(Routine).length, 2);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.equal((await a.runner.run(ReorderRoutines([second.id, first.id]))).kind, 'committed');
  await a.sync();
  const expected = [
    { id: 'routine2', name: 'Lower A', position: 0, entries: [{ exerciseId: 'back-squat' }] },
    { id: 'routine1', name: 'Lower A', position: 1, entries: [{ exerciseId: 'back-squat' }] },
  ];
  assert.deepEqual(fields(a), expected);
  assert.deepEqual(fields(b), expected);
});

test('routine reads preserve server metadata and own nested values without freezing the input', () => {
  const source = [{ exerciseId: 'dip', sets: [{ reps: 0, weightKg: 20.125 }], restSeconds: 14 }];
  const value = Routine.decode(Fields.values('routine', 'routine1', {
    name: 'History', entries: source, revision: 7, createdEntries: 3, createdDoor: 'ask',
  }));
  assert.deepEqual({ revision: value.revision, createdEntries: value.createdEntries, createdDoor: value.createdDoor }, {
    revision: 7, createdEntries: 3, createdDoor: 'ask',
  });
  assert.equal(Object.isFrozen(source), false);
  source.push({ exerciseId: 'back-squat', sets: [], restSeconds: 20 });
  const expected = { name: 'History', position: 0, entries: [{ exerciseId: 'dip', sets: [{ reps: 0, weightKg: 20.125 }], restSeconds: 14 }] };
  assert.deepEqual(value.fields(), expected);
  assert.deepEqual(PlanSnapshot.fromRoutine(value).json, { routine: 'History', entries: expected.entries });
  assert.equal(Object.isFrozen(value.entries), true);
  assert.equal(Object.isFrozen(value.entries[0]?.sets), true);
  assert.equal(Object.isFrozen(value.entries[0]?.sets?.[0]), true);
});

test('a performed routine groups sets in logged order, never by set number, and retains actual zero load', () => {
  const sets = [
    { exerciseId: 'dip', reps: 900, weightKg: 0, completedAt: 30, setNumber: 2 },
    { exerciseId: 'back-squat', reps: 5, weightKg: 80, completedAt: 20, setNumber: 1 },
    { exerciseId: 'dip', reps: 0, weightKg: -10, completedAt: 10, setNumber: 1 },
    { exerciseId: 'dip', reps: null, weightKg: 15, completedAt: 5 },
  ];
  const value = RoutineValue.fromSession({ id: new Id('routine1', Routine), name: 'Performed', sets });
  assert.deepEqual(value.fields(), { name: 'Performed', position: 0, entries: [
    { exerciseId: 'dip', sets: [{ weightKg: 15 }, { reps: 1, weightKg: -10 }, { reps: 100, weightKg: 0 }] },
    { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 80 }] },
  ] });
  const many = Array.from({ length: 21 }, (_, index) => ({ exerciseId: 'dip', reps: index + 1, weightKg: 0, completedAt: index }));
  assert.deepEqual(RoutineValue.fromSession({ id: new Id('routine2', Routine), name: 'Long', sets: many }).fields(), {
    name: 'Long', position: 0, entries: [{ exerciseId: 'dip', sets: many.slice(0, 20).map((set) => ({ reps: set.reps, weightKg: 0 })) }],
  });
});
