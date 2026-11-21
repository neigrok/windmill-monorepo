import test from 'node:test';
import assert from 'node:assert/strict';
import { composeRegistry } from '../../core/composition.js';
import { RegistryError } from '../../core/registry.js';

function document(name) {
  return { registry: name, version: 3, minVersion: 2, products: { [name]: {} }, types: [{
    type: name, scope: `product:${name}`, identity: 'singleton', singletonId: name,
    idPattern: `^${name}$`, life: false, origins: ['server', 'replica'],
    fields: { value: { kind: 'lww', writer: 'client', domain: { type: 'string' } } },
  }], commands: [{ name: `${name}.set`, scope: `product:${name}`, origins: ['server'], serverInternal: false, args: {} }] };
}

test('three registered documents join in manifest order, preserving every literal', () => {
  const alpha = document('alpha'), beta = document('beta'), gamma = document('gamma');
  gamma.types[0].fields.value.default = 'quote " slash \\ newline\n dollar $ café 🌳';
  const documents = { 'gamma.registry.json': gamma, 'unused.registry.json': {}, 'alpha.registry.json': alpha, 'beta.registry.json': beta };
  const manifest = { composition: 'three', registries: ['beta.registry.json', 'gamma.registry.json', 'alpha.registry.json'] };
  const before = structuredClone({ documents, manifest });
  assert.deepEqual(composeRegistry(manifest, documents), {
    registry: 'three', version: 3, minVersion: 2, products: { beta: {}, gamma: {}, alpha: {} },
    types: [beta.types[0], gamma.types[0], alpha.types[0]], commands: [beta.commands[0], gamma.commands[0], alpha.commands[0]],
  });
  assert.deepEqual({ documents, manifest }, before);
});

test('an invalid third member cannot hide behind the first two', () => {
  const manifest = { composition: 'three', registries: ['alpha.registry.json', 'beta.registry.json', 'gamma.registry.json'] };
  for (const breakThird of [
    (gamma) => { gamma.version = 4; },
    (gamma) => { gamma.minVersion = 1; },
    (gamma) => { gamma.products.alpha = {}; },
    (gamma) => { gamma.types[0].type = 'alpha'; },
    (gamma) => { gamma.commands[0].name = 'alpha.set'; },
    (gamma) => { gamma.types.push(gamma.types[0]); },
    (gamma) => { gamma.types[0].fields.value.domain = { type: 'number', quantum: 0.3 }; },
  ]) {
    const documents = Object.fromEntries(['alpha', 'beta', 'gamma'].map((name) => [`${name}.registry.json`, document(name)]));
    breakThird(documents['gamma.registry.json']);
    assert.throws(() => composeRegistry(manifest, documents), RegistryError);
  }
});

test('manifest members must be unique, present, and named safely', () => {
  const documents = { 'alpha.registry.json': document('alpha') };
  assert.throws(() => composeRegistry({ composition: 'Three', registries: ['alpha.registry.json'] }, documents), RegistryError);
  for (const registries of [[], ['alpha.registry.json', 'alpha.registry.json'], ['missing.registry.json'], ['../alpha.registry.json']]) {
    assert.throws(() => composeRegistry({ composition: 'three', registries }, documents), RegistryError);
  }
});
