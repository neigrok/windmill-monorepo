import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registry } from '../../../src/platform/sync/schema.js';

test('the browser schema preserves manifest member order and its exact interval', () => {
  const directory = new URL('../../../../packages/api-contract/sync/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('composition.json', directory)));
  const parts = manifest.registries.map((name) => JSON.parse(readFileSync(new URL(name, directory))));
  assert.equal(registry.name, manifest.composition);
  assert.deepEqual([...registry.types.keys()], parts.flatMap((part) => part.types.map((type) => type.type)));
  assert.deepEqual([...registry.commands.keys()], parts.flatMap((part) => part.commands.map((command) => command.name)));
  assert.deepEqual(Object.keys(registry.products), parts.flatMap((part) => Object.keys(part.products)));
  assert.deepEqual(parts.map((part) => [part.version, part.minVersion]), parts.map(() => [registry.version, registry.minVersion]));
});
