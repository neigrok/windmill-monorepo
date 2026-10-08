// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Refusal } from '../../../../../packages/api-contract/sync/reference/server/admit.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { CONSTANTS } from '../../../../../packages/api-contract/sync/reference/core/constants.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Bodyweight, DeleteWeighIn, WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { GymRefusals, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @param {import('node:test').TestContext} t @param {GymProduct} [product] */
async function open(t, product = new GymProduct()) {
  const a = await Harness.open({ registry, product, scope: WeighIn.scope });
  t.after(() => a.close());
  return a;
}

/** @param {Harness} phone @param {number} kg @param {string} [day] */
function draft(phone, kg, day = '2027-01-15') {
  const id = new Id(day, WeighIn);
  return phone.runner.openOrNew(WeighIn, id, new WeighInValue(id)).edit((value) => new WeighInValue(id, kg, value.recordedAt));
}

/** @param {Harness} phone */
const fields = (phone) => phone.drawn(WeighIn).map((value) => ({ id: value.id.record, ...value.fields() }));

test('a weigh-in storage failure keeps its draft, writes nothing durable and can be retried', async (t) => {
  const a = await open(t);
  const editing = draft(a, 82.456);
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  const failed = await a.runner.save(editing, GymRefusals);
  assert.equal(failed.result.kind, 'failed');
  assert.equal(failed.draft, editing);
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(a.drawn(WeighIn), []);
  assert.deepEqual(a.env.failures, ['storage']);
  const saved = await a.runner.save(failed.draft, GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  assert.equal(saved.draft.isNew, false);
  assert.equal(saved.draft.isDirty, false);
  assert.deepEqual(saved.draft.current.fields(), { kg: 82.46, recordedAt: DEFAULT_NOW });
  await a.sync();
  assert.deepEqual(fields(a), [{ id: '2027-01-15', kg: 82.46, recordedAt: DEFAULT_NOW }]);
});

test('a local violation retains the draft and emits no engine intent or storage failure', async (t) => {
  const a = await open(t);
  const editing = draft(a, 82.4, '2027-01-16');
  const result = await a.runner.save(editing, GymRefusals);
  assert.deepEqual(result.result.kind === 'refused' && refusalForm(result.result.refusal), { invalid: { rule: 'weighin.day', path: 'id', reason: 'custom', custom: 'future' } });
  assert.equal(result.draft, editing);
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  assert.deepEqual(a.env.failures, []);
});

test('a held delete keeps stored stance and remote records until Undo or release', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await a.runner.save(draft(a, 82.4), GymRefusals);
  await a.sync();
  const id = new Id('2027-01-15', WeighIn);
  const removed = await a.runner.run(DeleteWeighIn(id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  assert.equal(removed.receipt.releaseAt, DEFAULT_NOW + CONSTANTS.HOLD_MS);
  assert.deepEqual(a.undoOffers(), [{ id: removed.receipt.gestureId, releaseAt: removed.receipt.releaseAt, records: [id.ref] }]);
  assert.deepEqual(fields(a), []);
  assert.equal(a.stored(WeighIn).length, 1);
  assert.equal(a.runner.read(WeighIn.scope, (read) => new Bodyweight(read).stance), 'holding');
  await a.sync();
  assert.deepEqual(fields(b), [{ id: '2027-01-15', kg: 82.4, recordedAt: DEFAULT_NOW }]);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(fields(a), fields(b));
  assert.deepEqual(a.undoOffers(), []);
  const again = await a.runner.run(DeleteWeighIn(id));
  assert.equal(again.kind, 'committed');
  if (again.kind !== 'committed') return;
  await a.advance(CONSTANTS.HOLD_MS - 1);
  assert.equal(a.undoOffers().length, 1);
  await a.advance(1);
  assert.deepEqual(a.undoOffers(), []);
  assert.equal(await a.runner.undo(again.receipt.gestureId), false);
  await a.sync();
  assert.deepEqual(fields(a), []);
  assert.deepEqual(fields(b), []);
  assert.equal(a.runner.read(WeighIn.scope, (read) => new Bodyweight(read).stance), 'empty');
});

test('a whole save retires the held delete and its obsolete Undo cannot erase the replacement', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await a.runner.save(draft(a, 82.4), GymRefusals);
  await a.sync();
  const removed = await a.runner.run(DeleteWeighIn(new Id('2027-01-15', WeighIn)));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  await a.advance(1_000);
  const saved = await a.runner.save(draft(a, 83.456), GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  if (saved.result.kind !== 'saved') return;
  assert.deepEqual(saved.result.receipt?.retired, [removed.receipt.gestureId]);
  assert.deepEqual(a.undoOffers(), []);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), false);
  await a.advance(CONSTANTS.HOLD_MS);
  await a.sync();
  assert.deepEqual(fields(a), [{ id: '2027-01-15', kg: 83.46, recordedAt: DEFAULT_NOW + 1_000 }]);
  assert.deepEqual(fields(b), fields(a));
});

for (const reverse of [false, true]) test(`competing whole-day saves converge as one fact when ${reverse ? 'newer' : 'older'} arrives first`, async (t) => {
  const a = await open(t);
  const b = await a.device();
  await a.sync();
  await a.runner.save(draft(a, 80), GymRefusals);
  await a.advance(1_000);
  await b.runner.save(draft(b, 82), GymRefusals);
  const first = reverse ? b : a;
  const second = reverse ? a : b;
  assert.equal(await first.senderStep(), true);
  assert.equal(await second.senderStep(), true);
  await a.sync();
  const expected = [{ id: '2027-01-15', kg: 82, recordedAt: DEFAULT_NOW + 1_000 }];
  assert.deepEqual(fields(a), expected);
  assert.deepEqual(fields(b), expected);
  const rows = a.server.rowsOf('acct:A/gym');
  assert.equal(rows.length, 1);
  assert.deepEqual({ kg: rows[0].f.kg[0], recordedAt: rows[0].f.recordedAt[0] }, { kg: 82, recordedAt: DEFAULT_NOW + 1_000 });
  assert.equal(rows[0].life[1], rows[0].f.kg[1]);
  assert.equal(rows[0].f.kg[1], rows[0].f.recordedAt[1]);
});

test('leaving releases a held delete and a later whole save revives the same day', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await a.runner.save(draft(a, 81), GymRefusals);
  await a.sync();
  await a.runner.run(DeleteWeighIn(new Id('2027-01-15', WeighIn)));
  await a.leave();
  assert.deepEqual(a.undoOffers(), []);
  await a.sync();
  assert.deepEqual(fields(b), []);
  await a.advance(1_000);
  await b.runner.save(draft(b, 82), GymRefusals);
  await a.sync();
  assert.deepEqual(fields(a), [{ id: '2027-01-15', kg: 82, recordedAt: DEFAULT_NOW + 1_000 }]);
  assert.deepEqual(fields(b), fields(a));
});

test('a process restart retains the committed save and releases its durable held delete', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await a.runner.save(draft(a, 81), GymRefusals);
  await a.restart();
  assert.deepEqual(fields(a), [{ id: '2027-01-15', kg: 81, recordedAt: DEFAULT_NOW }]);
  await a.sync();
  const removed = await a.runner.run(DeleteWeighIn(new Id('2027-01-15', WeighIn)));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  await a.restart();
  assert.deepEqual(a.undoOffers(), []);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), false);
  await a.sync();
  assert.deepEqual(fields(a), []);
  assert.deepEqual(fields(b), []);
});

test('a server refusal restores the saved record and retains the refused values in its mapped notice', async (t) => {
  const product = new GymProduct();
  const a = await open(t, product);
  await a.runner.save(draft(a, 81), GymRefusals);
  await a.sync();
  const check = product.check.bind(product);
  let refuse = true;
  product.check = (...args) => {
    if (refuse) { refuse = false; throw new Refusal('bad-instant'); }
    return check(...args);
  };
  await a.advance(1_000);
  await a.runner.save(draft(a, 82), GymRefusals);
  await a.sync();
  assert.deepEqual(fields(a), [{ id: '2027-01-15', kg: 81, recordedAt: DEFAULT_NOW }]);
  const notices = a.notices(GymRefusals);
  assert.equal(notices.length, 1);
  assert.deepEqual(refusalForm(notices[0].refusal), { future: { subject: { t: 'weighin', id: '2027-01-15' }, path: 'notice' } });
  assert.deepEqual(notices[0].values({ t: 'weighin', id: '2027-01-15' }), { kg: 82, recordedAt: DEFAULT_NOW + 1_000 });
});
