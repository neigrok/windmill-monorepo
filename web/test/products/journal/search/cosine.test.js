import test from 'node:test';
import assert from 'node:assert/strict';

import { cosine, topK } from '../../../../src/products/journal/search/cosine.js';

test('cosine — identical vectors score 1, orthogonal 0, zero-norm guarded to 0', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1, 0], [1, 0, 0]) - Math.SQRT1_2) < 1e-9);
});

test('topK — highest first, above the floor, capped at k', () => {
  const items = [{ v: 1 }, { v: 9 }, { v: 5 }, { v: 0.05 }];
  const ranked = topK(items, (x) => x.v, 2, 0.1);
  assert.deepEqual(ranked.map((r) => r.item.v), [9, 5]);
});
