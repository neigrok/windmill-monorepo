// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Instant, Moment, FixedZone } from '../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { CoachRoutineImport, ImportCoachRoutineBatch } from '../../../../src/products/gym/domain/coachOnboarding.js';
import { Routine, RoutineEntry, RoutineValue, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @param {import('node:test').TestContext} t @param {boolean} anonymous */
async function phoneOf(t, anonymous) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Routine.scope, anonymous });
  t.after(() => phone.close());
  return phone;
}

/** @param {Harness} phone */
const routines = (phone) => RoutineValue.ordered(phone.drawn(Routine)).map((routine) => ({ id: routine.id.record, name: routine.name, position: routine.position,
  entries: routine.entries.map((entry) => entry.json) }));

const upper = new RoutineEntry(new Id('bench-press', Exercise), [new SetTarget(8, null)]);
const lower = new RoutineEntry(new Id('back-squat', Exercise));

// The Swift domain's own case (CoachOnboardingTests): the same drafts hash to the same fingerprint and key on every surface.
test('drafts normalize into one fingerprint and a receipt key of their result', () => {
  const action = ImportCoachRoutineBatch.of({ replica: 'replica', resultId: 'result', drafts: [new CoachRoutineImport(new Id('routine-a', Routine), ' Upper ', [upper]),
    new CoachRoutineImport(new Id('routine-b', Routine), 'Lower', [lower])], moment: new Moment(new Instant(DEFAULT_NOW), new FixedZone(0)) });
  assert.equal(action.fingerprint, '9ee3ce25ffc283ce32f365fe9bc3db8c3fc96bfc2a9a80f9f5b0b179d87e4b83');
  assert.equal(action.receiptKey, 'rack:coachImportf6a214f7a5fcda0c2cee9660b7fc29f5649e3c68aad48e20');
  assert.deepEqual(action.routines.map((routine) => routine.name), ['Upper', 'Lower']);
  const key = ImportCoachRoutineBatch.receiptKey('x'.repeat(128));
  assert.equal(ImportCoachRoutineBatch.validReceiptKey(key), true);
  assert.notEqual(key, ImportCoachRoutineBatch.receiptKey(`${'x'.repeat(128)}y`));
});

test('every routine and its replay receipt commit together, and a retry replays the receipt with no write', async (t) => {
  const phone = await phoneOf(t, true);
  const replica = phone.runner.read(Routine.scope, (read) => read.replica);
  const drafts = [new CoachRoutineImport(new Id('routine-a', Routine), 'Upper', [upper]), new CoachRoutineImport(new Id('routine-b', Routine), 'Lower', [lower])];
  const apply = () => ImportCoachRoutineBatch.of({ replica, resultId: 'result', drafts, moment: phone.runner.moment() });
  const key = ImportCoachRoutineBatch.receiptKey('result');
  phone.failNextCommit();
  await assert.rejects(phone.runner.run(apply()));
  assert.deepEqual(phone.drawn(Routine), []);
  assert.equal(phone.runner.read(Routine.scope, (read) => read.device(key)), null);
  const first = await phone.runner.run(apply());
  assert.equal(first.kind, 'committed');
  const expected = [{ id: 'routine-a', name: 'Upper', position: 0, entries: [upper.json] }, { id: 'routine-b', name: 'Lower', position: 1, entries: [lower.json] }];
  assert.deepEqual(routines(phone), expected);
  const receipt = first.kind === 'committed' ? first.result : assert.fail('not committed');
  assert.deepEqual(phone.runner.read(Routine.scope, (read) => read.device(key)), receipt.json);
  assert.deepEqual(receipt.routines.map((id) => id.record), ['routine-a', 'routine-b']);
  const retried = await phone.runner.run(apply());
  assert.deepEqual(retried.kind === 'unchanged' && retried.result.json, receipt.json);
  const changed = ImportCoachRoutineBatch.of({ replica, resultId: 'result', drafts: [new CoachRoutineImport(new Id('other001', Routine), 'Other', [upper])],
    moment: phone.runner.moment() });
  assert.equal((await phone.runner.run(changed)).kind, 'refused');
  assert.deepEqual(routines(phone), expected);
});

test('one invalid routine refuses the whole result, a changed seat imports nothing, and an account imports once', async (t) => {
  const phone = await phoneOf(t, true);
  const replica = phone.runner.read(Routine.scope, (read) => read.replica);
  const valid = new CoachRoutineImport(new Id('routine-a', Routine), 'Upper', [lower]);
  const unknown = new CoachRoutineImport(new Id('routine-b', Routine), 'Unknown', [new RoutineEntry(new Id('private-custom-movement', Exercise))]);
  const moment = phone.runner.moment();
  assert.equal((await phone.runner.run(ImportCoachRoutineBatch.of({ replica, resultId: 'result', drafts: [valid, unknown], moment }))).kind, 'refused');
  assert.equal((await phone.runner.run(ImportCoachRoutineBatch.of({ replica: 'old-seat', resultId: 'result', drafts: [valid], moment }))).kind, 'refused');
  assert.deepEqual(phone.drawn(Routine), []);
  assert.equal(phone.runner.read(Routine.scope, (read) => read.device(ImportCoachRoutineBatch.receiptKey('result'))), null);

  const account = await phoneOf(t, false);
  const action = ImportCoachRoutineBatch.of({ replica: account.runner.read(Routine.scope, (read) => read.replica), resultId: 'result', drafts: [valid],
    moment: account.runner.moment() });
  const imported = await account.runner.run(action);
  assert.equal(imported.kind, 'committed');
  assert.deepEqual(routines(account).map((routine) => routine.entries), [[lower.json]]);
  const replayed = await account.runner.run(action);
  assert.deepEqual(replayed.kind === 'unchanged' && replayed.result.json, imported.kind === 'committed' && imported.result.json);
});
