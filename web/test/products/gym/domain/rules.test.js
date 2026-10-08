// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { EntityType, Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { Rule, RuleBook } from '../../../../src/platform/domain-kit/rules.js';
import { Check } from '../../../../src/platform/domain-kit/validation.js';
import { NumberSpec, TextSpec } from '../../../../src/platform/domain-kit/values.js';
import { GymRules, GymRefusals, Session } from '../../../../src/products/gym/domain/gymRules.js';
import { WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { Preferences, PreferencesValue } from '../../../../src/products/gym/domain/preferences.js';
import { CheckFailure, RegistryCheck, RuleBookCheck } from '../../../platform/domain-kit/checks.js';
import { Contract } from '../../../platform/domain-kit/vectors.js';

const book = GymRules.book;
const weight = new WeighInValue(new Id('2027-01-15', WeighIn), 82.4);
const preference = new PreferencesValue(new Id('prefs', Preferences));

/** @param {EntityType<any>} type @param {Record<string, any>} patch */
function changed(type, patch) {
  return new EntityType({ type: type.type, scope: type.scope, decode: type.decode,
    ...(type.checks === null ? {} : { checks: [...type.checks] }),
    ...(type.heldRemoval === null ? {} : { heldRemoval: type.heldRemoval }),
    ...(type.savesGuarded === null ? {} : { savesGuarded: type.savesGuarded }),
    ...(type.timestampField === null ? {} : { timestampField: type.timestampField }),
    ...(type.orderField === null ? {} : { orderField: type.orderField }), ...patch });
}

/** @param {() => void} body @param {number} step */
function rejected(body, step) {
  assert.throws(body, (error) => error instanceof CheckFailure && error.check === 'RegistryCheck' && error.step === step);
}

test('registry checks reject missing types, wrong product scopes and invalid life or order declarations', () => {
  rejected(() => RegistryCheck.entity(changed(WeighIn, { type: 'missing' }), null, book), 1);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { scope: 'self/journal' }), null, book), 1);
  rejected(() => RegistryCheck.entity(changed(Preferences, { heldRemoval: true }), null, book), 2);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { orderField: 'kg' }), null, book), 3);
});

test('registry checks reject undeclared writes, orphan checks and a spec that is looser than the registry', () => {
  rejected(() => RegistryCheck.entity(WeighIn, { id: weight.id, fields: () => ({ ...weight.fields(), serverField: 1 }) }, book), 4);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { checks: [...(WeighIn.checks ?? []), new Check('missing', (value) => value)] }), weight, book), 5);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { checks: [] }), weight, book), 6);
  const loose = new RuleBook(book.registry, [WeighIn], [Rule.localSpec(new NumberSpec('weighin.kg', { min: 20, max: 500, quantum: 0.01 }))]);
  rejected(() => RegistryCheck.entity(WeighIn, weight, loose), 6);
  const enumText = new RuleBook(book.registry, [Preferences], [Rule.localSpec(new TextSpec('prefs.units', { unit: 'chars', min: 1, max: 2, trim: false, nfc: false }))]);
  rejected(() => RegistryCheck.entity(Preferences, preference, enumText), 6);
});

test('registry checks reject broken round trips, unpinned quantum and an unchecked string', () => {
  rejected(() => RegistryCheck.entity(changed(WeighIn, { decode: () => new WeighInValue(weight.id, 99) }), weight, book), 7);
  rejected(() => RegistryCheck.entity(WeighIn, weight, new RuleBook(book.registry, [WeighIn], [])), 9);
  rejected(() => RegistryCheck.entity(Preferences, preference, new RuleBook(book.registry, [Preferences], [])), 10);
});

test('registry checks reject partial whole records, guarded whole saves and timestamp checks', () => {
  const partial = new EntityType({ type: WeighIn.type, scope: WeighIn.scope, decode: WeighIn.decode, checks: [...(WeighIn.checks ?? [])] });
  rejected(() => RegistryCheck.entity(partial, { id: weight.id, fields: () => ({ kg: 82.4 }) }, book), 11);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { savesGuarded: true }), weight, book), 11);
  rejected(() => RegistryCheck.entity(changed(WeighIn, { checks: [...(WeighIn.checks ?? []), new Check('recordedAt', (value) => value)] }), weight, book), 11);
});

test('rule book checks reject duplicated or uncovered rules and generic refusal mappings', () => {
  const values = 'gym/domain/values.json';
  const actions = Contract.files('gym/domain').filter((path) => path.endsWith('-actions.json'));
  const duplicate = new RuleBook(book.registry, [], [Rule.localCheck('weighin.day', 'weighin'), Rule.localCheck('weighin.day', 'weighin')]);
  assert.throws(() => RuleBookCheck.check(duplicate, GymRefusals, values, actions), /two rules share the name/);
  const missing = new RuleBook(book.registry, [], [Rule.localCheck('uncovered', 'weighin')]);
  assert.throws(() => RuleBookCheck.check(missing, GymRefusals, values, actions), /has no violation vector/);
  assert.throws(() => RuleBookCheck.check(book, { ...GymRefusals, isGeneric: () => true }, values, actions), /maps to a generic refusal/);
});


test('decoded records own their immutable nested values without freezing the reader source', () => {
  const plan = { routine: 'Lower', entries: [{ exerciseId: 'back-squat' }] };
  const value = Session.decode(Fields.values('session', 'session001', { startedAt: 1000, plan }));
  assert.equal(Object.isFrozen(plan), false);
  assert.equal(Object.isFrozen(plan.entries), false);
  plan.entries.push({ exerciseId: 'dip' });
  assert.deepEqual(value.fields().plan, { routine: 'Lower', entries: [{ exerciseId: 'back-squat' }] });
  assert.ok(value.plan);
  assert.equal(Object.isFrozen(value.plan), true);
  assert.equal(Object.isFrozen(value.plan.entries), true);
  assert.equal(Object.isFrozen(value.plan.entries[0]), true);
});
