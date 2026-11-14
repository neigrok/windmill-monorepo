import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';

test('strict recovery index reads only records visible to the named holder', () => {
  const storage = { getItem: () => JSON.stringify({
    t_local: { title: 'Local', owner: null, claimed: false, updatedAt: 3 },
    t_own: { title: 'Owned', owner: 'account', claimed: true, updatedAt: 2 },
    t_other: { title: 'Other', owner: 'other', updatedAt: 1 },
    t_unknown: { title: 'Unattributed', updatedAt: 4 },
  }) };
  const registry = new LocalTreeRegistry(storage);
  assert.deepEqual(registry.readList(null), [{ id: 't_local', title: 'Local', claimed: false, updatedAt: 3 }]);
  assert.deepEqual(registry.readList('account'), [
    { id: 't_local', title: 'Local', claimed: false, updatedAt: 3 },
    { id: 't_own', title: 'Owned', claimed: true, updatedAt: 2 },
  ]);
  assert.deepEqual(new LocalTreeRegistry({ getItem: () => null }).readList(null), []);
});

test('strict recovery reads distinguish unreadable and malformed indexes from empty, preserving tolerant entries', () => {
  for (const value of ['{', 'null', '[]', '{"bad":null}', '{"bad":{"title":{}}}']) {
    const registry = new LocalTreeRegistry({ getItem: () => value });
    assert.throws(() => registry.readList(null));
  }
  const refusal = new DOMException('private storage detail', 'SecurityError');
  const registry = new LocalTreeRegistry({ getItem: () => { throw refusal; } });
  assert.throws(() => registry.readList(null), (error) => error === refusal);
  assert.deepEqual(registry.entries(), {});
  assert.deepEqual(registry.list(null), []);
});
