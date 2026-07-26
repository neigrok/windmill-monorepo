// An edge's selection identity is its ordered (from, to) endpoint pair, folded to a string key
// so it lives in a Set alongside node-id keys. These pin the round-trip and the direction/collision
// guarantees the desktop edge multi-select leans on (React selection state ⇄ ConnectorBatch highlight).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, parseEdgeKey } from '../../../../src/products/roadmap/scene/edgeKey.js';

test('edgeKey is deterministic and direction-sensitive (a prerequisite arrow has a direction)', () => {
  assert.equal(edgeKey('root', 'a'), edgeKey('root', 'a'));
  assert.notEqual(edgeKey('root', 'a'), edgeKey('a', 'root'));
});

test('parseEdgeKey inverts edgeKey exactly, across the id shapes in use', () => {
  const pairs = [
    ['root', 'a'],
    ['n-1720000000000', 'n-1720000000001'],
    ['3f2a4b1c-0000-4000-8000-000000000001', '3f2a4b1c-0000-4000-8000-000000000002'],
    ['t_9362d9bc883e0a1e', 'n-child'],
  ];
  for (const [from, to] of pairs) {
    assert.deepEqual(parseEdgeKey(edgeKey(from, to)), { from, to });
  }
});

test('distinct edges never collide on a key', () => {
  const keys = new Set([
    edgeKey('a', 'b'),
    edgeKey('a', 'c'),
    edgeKey('b', 'c'),
    edgeKey('b', 'a'),
  ]);
  assert.equal(keys.size, 4);
});
