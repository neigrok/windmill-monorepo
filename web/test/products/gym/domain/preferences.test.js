// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { Rule, RuleBook } from '../../../../src/platform/domain-kit/rules.js';
import { ChangePreferences, Preferences, PreferencesValue, RestSettings, RestSettingsRules, RestSettingsValue, SaveRestSettings, restSettings }
  from '../../../../src/products/gym/domain/preferences.js';
import { RegistryCheck } from '../../../platform/domain-kit/checks.js';
import { Harness } from '../../../platform/domain-kit/harness.js';

/** @param {RestSettingsValue} rest */
const restOf = (rest) => ({ seconds: rest.seconds, sound: rest.sound });

test('separate preference edits merge from older drafts while preserving rest registers', async (t) => {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: Preferences.scope });
  t.after(() => a.close());
  const b = await a.device();
  const id = new Id('prefs', Preferences);
  await a.engine.commit(Preferences.scope, [{ op: 'write', t: 'prefs', id: 'prefs', f: { units: 'kg', confirmHaptic: true, confirmSound: false, restSeconds: 180, restSound: false } }]);
  await a.sync();
  const first = a.runner.openOrNew(Preferences, id, new PreferencesValue(id));
  const second = b.runner.openOrNew(Preferences, id, new PreferencesValue(id));
  const savedA = await a.runner.save(first.edit((value) => new PreferencesValue(id, 'lb', value.confirmHaptic, value.confirmSound)), GymRefusals);
  assert.equal(savedA.result.kind, 'saved');
  await a.sync();
  const savedB = await b.runner.save(second.edit((value) => new PreferencesValue(id, value.units, value.confirmHaptic, true)), GymRefusals);
  assert.equal(savedB.result.kind, 'saved');
  assert.deepEqual(savedB.draft.current.fields(), { units: 'kg', confirmHaptic: true, confirmSound: true });
  assert.equal(savedB.draft.isDirty, false);
  await a.sync();
  for (const phone of [a, b]) {
    assert.deepEqual(phone.drawn(Preferences).map((value) => value.fields()), [{ units: 'lb', confirmHaptic: true, confirmSound: true }]);
    assert.deepEqual(restOf(phone.runner.read(Preferences.scope, restSettings)), { seconds: 180, sound: false });
  }
  const noChange = await b.runner.save(savedB.draft, GymRefusals);
  assert.deepEqual(noChange.result, { kind: 'saved', receipt: null });
  assert.deepEqual(b.engine.device.activeReplica.entries(), []);
});

test('a refused preferences save preserves both the dirty draft and all stored fields', async (t) => {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: Preferences.scope });
  t.after(() => a.close());
  const id = new Id('prefs', Preferences);
  const initial = await a.runner.save(a.runner.openOrNew(Preferences, id, new PreferencesValue(id)).edit(() => new PreferencesValue(id, 'lb')), GymRefusals);
  assert.equal(initial.result.kind, 'saved');
  const editing = initial.draft.edit(() => new PreferencesValue(id, 'stones', false, true));
  const before = (await a.engine.store.read()).device.toJSON();
  const refused = await a.runner.save(editing, GymRefusals);
  assert.equal(refused.result.kind, 'refused');
  assert.equal(refused.draft, editing);
  assert.deepEqual(a.drawn(Preferences).map((value) => value.fields()), [{ units: 'lb', confirmHaptic: true, confirmSound: false }]);
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
});

test('the rest settings agree with the registry under a rule of their own, and round trip', () => {
  const book = new RuleBook(registry, [RestSettings], [Rule.localSpec(RestSettingsRules.seconds)]);
  RegistryCheck.entity(RestSettings, new RestSettingsValue(new Id('prefs', RestSettings), 120, false), book);
  RegistryCheck.entity(RestSettings, new RestSettingsValue(new Id('prefs', RestSettings), null, true), book);
});

test('a default rest set on one device reaches the other, and a preference changed there meanwhile keeps both', async (t) => {
  const web = await Harness.open({ registry, product: new GymProduct(), scope: Preferences.scope });
  t.after(() => web.close());
  const phone = await web.device();
  assert.deepEqual(restOf(web.runner.read(Preferences.scope, restSettings)), { seconds: null, sound: true });
  assert.equal((await web.runner.run(SaveRestSettings({ restSeconds: 150 }))).kind, 'committed');
  assert.equal((await phone.runner.run(ChangePreferences({ units: 'lb' }))).kind, 'committed');
  await web.sync();
  for (const device of [web, phone]) {
    assert.deepEqual(restOf(device.runner.read(Preferences.scope, restSettings)), { seconds: 150, sound: true });
    assert.deepEqual(device.drawn(Preferences).map((value) => value.fields()), [{ units: 'lb', confirmHaptic: true, confirmSound: false }]);
  }
  assert.equal((await web.runner.run(SaveRestSettings({ restSeconds: null, restSound: false }))).kind, 'committed');
  assert.equal((await web.runner.run(SaveRestSettings({ restSeconds: null }))).kind, 'unchanged');
  await web.sync();
  assert.deepEqual(restOf(phone.runner.read(Preferences.scope, restSettings)), { seconds: null, sound: false });
  assert.deepEqual(phone.drawn(Preferences).map((value) => value.fields()), [{ units: 'lb', confirmHaptic: true, confirmSound: false }]);
});

test('a default rest the store cannot keep fails and leaves the record as it was', async (t) => {
  const web = await Harness.open({ registry, product: new GymProduct(), scope: Preferences.scope });
  t.after(() => web.close());
  assert.equal((await web.runner.run(SaveRestSettings({ restSeconds: 90 }))).kind, 'committed');
  web.failNextCommit();
  await assert.rejects(web.runner.run(SaveRestSettings({ restSeconds: 120 })));
  assert.deepEqual(restOf(web.runner.read(Preferences.scope, restSettings)), { seconds: 90, sound: true });
  const refused = await web.runner.run(SaveRestSettings({ restSeconds: 5 }));
  assert.deepEqual(refused.kind === 'refused' ? refused.refusal.kind : refused.kind, 'invalid');
});
