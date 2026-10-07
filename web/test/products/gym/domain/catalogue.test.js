// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Catalogue, CreateExercise, Exercise, ExerciseName, ExerciseValue, RenameExercise } from '../../../../src/products/gym/domain/catalogue.js';
import { refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Harness } from '../../../platform/domain-kit/harness.js';

/** @param {import('node:test').TestContext} t */
async function open(t) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Exercise.scope });
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((value) => [value.id.record, value.fields()]));
  t.after(() => phone.close());
  return phone;
}

/** @param {Harness} phone @param {Id<ExerciseValue>} id */
function exercise(phone, id) {
  const value = phone.runner.read(Exercise.scope, (read) => new Catalogue(read).find(id));
  assert.ok(value);
  return { id: value.id.record, ...value.fields(), aliases: value.aliases };
}

test('a failed catalogue create writes nothing and retry retains its id through restart and sync', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const id = new Id('exercise1', Exercise);
  const create = new CreateExercise(new ExerciseValue(id, ' Cafe\u0301 squat ', 'squat', 'barbell', 2.125, ['Untrusted alias']));
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  await assert.rejects(a.runner.run(create));
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.drawn(Exercise), []);
  assert.deepEqual(a.env.failures, ['storage']);

  const saved = await a.runner.run(create);
  assert.equal(saved.kind, 'committed');
  assert.equal(saved.kind === 'committed' && saved.result.equals(id), true);
  const expected = { id: 'exercise1', name: 'Café squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.13, aliases: [] };
  assert.deepEqual(exercise(a, id), expected);
  await a.restart();
  assert.deepEqual(exercise(a, id), expected);
  await a.sync();
  assert.deepEqual(exercise(a, id), expected);
  assert.deepEqual(exercise(b, id), expected);
  assert.equal(a.server.rowsOf('acct:A/gym').filter((/** @type {{ t: string }} */ row) => row.t === 'exercise').length, 1);
});

test('custom and seed renames converge with server aliases while refused and unchanged names add no intent', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const custom = new Id('exercise1', Exercise);
  const seed = new Id('back-squat', Exercise);
  await a.runner.run(new CreateExercise(new ExerciseValue(custom, 'Old squat', 'squat', 'barbell', 2.5)));
  await a.sync();

  const blank = await a.runner.run(new RenameExercise(custom, ' \u3000 '));
  assert.deepEqual(blank.kind === 'refused' && refusalForm(blank.refusal), {
    invalid: { rule: 'exercise.name', path: 'name', reason: 'blank' },
  });
  const gone = await a.runner.run(new RenameExercise(new Id('missing1', Exercise), 'New squat'));
  assert.deepEqual(gone.kind === 'refused' && refusalForm(gone.refusal), {
    gone: { subject: { t: 'exercise', id: 'missing1' }, path: 'predicted' },
  });
  assert.deepEqual(await a.runner.run(new RenameExercise(seed, ' Back Squat ')), { kind: 'unchanged', result: null });
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);

  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  await assert.rejects(a.runner.run(new RenameExercise(custom, 'New squat')));
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.equal(exercise(a, custom).name, 'Old squat');
  assert.equal((await a.runner.run(new RenameExercise(custom, 'New squat'))).kind, 'committed');
  assert.equal((await a.runner.run(new RenameExercise(seed, 'My squat'))).kind, 'committed');
  assert.deepEqual(a.drawn(ExerciseName).map((value) => ({ id: value.id.record, ...value.fields() })), [{ id: 'back-squat', name: 'My squat' }]);
  await a.sync();

  const customExpected = { id: 'exercise1', name: 'New squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, aliases: ['Old squat'] };
  const seedExpected = { id: 'back-squat', name: 'My squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, aliases: ['Back Squat'] };
  for (const phone of [a, b]) {
    assert.deepEqual(exercise(phone, custom), customExpected);
    assert.deepEqual(exercise(phone, seed), seedExpected);
    assert.deepEqual(phone.runner.read(Exercise.scope, (read) => new Catalogue(read).search('OLD SQUAT')).map((value) => value.id.record), ['exercise1']);
  }
});
