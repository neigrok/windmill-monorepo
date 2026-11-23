import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Catalog, JsonSchema } from '../../../src/platform/domain-kit/abilities.js';

test('shared schema patterns match the whole value with backtracking', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/catalog/schema-patterns.json', import.meta.url)));
  for (const { name, schema, value, fault } of vectors) assert.deepEqual(new JsonSchema(schema).fault(value), fault, name);
});

test('shared gym catalog is data consumed without any platform product import', () => {
  const document = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/gym/catalog.json', import.meta.url)));
  const catalog = new Catalog(document);
  assert.equal(catalog.version, document.catalog);
  assert.deepEqual(catalog.abilities.map((ability) => ability.name), document.abilities.map((ability) => ability.name));
  for (const seat of ['anon', 'bound']) assert.deepEqual(catalog.offered(seat).map((ability) => ability.name),
    document.abilities.filter((entry) => entry.agent !== 'withheld' && entry.declared !== false && (entry.seats === 'any' || seat === 'bound')).map((entry) => entry.name));
  assert.equal(catalog.ability('absent'), null);
  assert.throws(() => new Catalog({ ...document, abilities: [document.abilities[0], document.abilities[0]] }), /duplicate-ability/);
  for (const invalid of [[], {}, { ...document, extra: 1 }, { ...document, catalog: 1 }, { ...document, abilities: {} }]) assert.throws(() => new Catalog(invalid));
});

test('each ability is strict as its catalog says, and strict where the catalog is silent', () => {
  const third = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/gym/catalog-3.json', import.meta.url)));
  assert.deepEqual(new Catalog(third).abilities.filter((ability) => ability.strict).map((ability) => ability.name),
    ['create_routine', 'create_exercise', 'propose_routine_change', 'propose_routine_removal', 'propose_workout_change']);
  const second = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/gym/catalog.json', import.meta.url)));
  assert.ok(new Catalog(second).abilities.every((ability) => ability.strict));
  assert.throws(() => new Catalog({ ...third, abilities: [{ ...third.abilities[0], strict: 'yes' }] }), /invalid ability/);
});

test('schema faults recurse at every depth and use canonical member order', () => {
  const schema = new JsonSchema({ properties: { a: { properties: { b: { items: { properties: { c: { items: { properties: { d: { type: 'integer' } } } } } } } } } } });
  assert.deepEqual(schema.fault({ a: { b: [{}, { c: [{}, { d: 1 }, { d: 'x' }] }] } }), { path: 'a.b.1.c.2.d', reason: 'not "integer"' });
  const ordered = new JsonSchema({ required: ['z', 'a'], additionalProperties: false, properties: { z: {}, a: { type: 'string' }, '�': { type: 'string' }, '😀': { type: 'string' } } });
  assert.deepEqual(ordered.fault({ extra: 1 }), { path: 'z', reason: 'required' });
  assert.deepEqual(ordered.fault({ z: 1, a: 2, extra2: 1, extra1: 2 }), { path: 'extra1', reason: 'not a property' });
  assert.deepEqual(ordered.fault({ z: 1, a: '', '�': 1, '😀': 1 }), { path: '😀', reason: 'not "string"' });
});

test('schema subset matches Kotlin types, scalar lengths, bounds, whole patterns and unique JCS', () => {
  const cases = [
    [{ type: ['number', 'null'] }, 'x', { path: '', reason: 'not ["number","null"]' }],
    [{ type: 'integer' }, 1.5, { path: '', reason: 'not "integer"' }],
    [{ type: 5 }, 1, { path: '', reason: 'not 5' }],
    [{ enum: ['a', 'b'] }, 'c', { path: '', reason: 'not one of the enum' }],
    [{ const: true }, false, { path: '', reason: 'not the constant' }],
    [{ minimum: .5 }, 0, { path: '', reason: 'below 0.5' }],
    [{ maximum: 1e21 }, 1e22, { path: '', reason: 'above 1e+21' }],
    [{ minLength: 1, maxLength: 1 }, '😀', null],
    [{ maxLength: 1 }, 'é', { path: '', reason: 'longer than 1' }],
    [{ minLength: 1 }, '', { path: '', reason: 'shorter than 1' }],
    [{ pattern: 'ab|c' }, 'abc', { path: '', reason: 'not ab|c' }],
    [{ pattern: '[a-z]+$' }, 'abc\n', { path: '', reason: 'not [a-z]+$' }],
    [{ pattern: '[' }, 'abc', { path: '', reason: 'not [' }],
    [{ minItems: 1e3 }, [], { path: '', reason: 'fewer than 1000 items' }],
    [{ maxItems: 1 }, [1,2], { path: '', reason: 'more than 1 items' }],
    [{ uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], { path: '1', reason: 'repeats an item' }],
    [{ properties: 1, additionalProperties: false }, { a: 1 }, { path: 'a', reason: 'not a property' }],
  ];
  for (const [schema, value, fault] of cases) assert.deepEqual(new JsonSchema(schema).fault(value), fault);
  for (const schema of [true, false, 1, { multipleOf: .01 }, { oneOf: [{ type: 'string' }] }, { format: 'date' }, { not: {} }, { enum: 'x' }, { minimum: '9' }, { maximum: null }]) assert.equal(new JsonSchema(schema).fault(1.005), null);
  for (const schema of [{ uniqueItems: 'yes', items: 1 }, { minItems: 1.5, maxItems: .5 }, { minItems: 9223372036854775808 }]) assert.equal(new JsonSchema(schema).fault([1, 1]), null);
  assert.equal(new JsonSchema({ additionalProperties: { type: 'string' } }).fault({ extra: 1 }), null);
  assert.equal(new JsonSchema({ minLength: 1e300, pattern: 1 }).fault('a'), null);
});
