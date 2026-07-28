import test from 'node:test';
import assert from 'node:assert/strict';

import { embed, DIM } from '../../../../src/products/journal/search/embed.js';
import { cosine } from '../../../../src/products/journal/search/cosine.js';

test('embed — deterministic, fixed dimension, unit norm', () => {
  const a = embed('the walk did not happen');
  const b = embed('the walk did not happen');
  assert.equal(a.length, DIM);
  assert.deepEqual([...a], [...b]);
  let norm = 0;
  for (const x of a) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6);
});

test('embed — a passage circling the same thing in other words is closer than an unrelated one', () => {
  const query = embed('I felt behind and everyone seems further along');
  const near = embed('everyone else seems further along and I cannot tell if it is true');
  const far = embed('long walk with no podcast in the quiet');
  assert.ok(cosine(query, near) > cosine(query, far));
});

test('embed — an empty or wordless body is the zero vector', () => {
  const empty = embed('   ');
  assert.ok([...empty].every((x) => x === 0));
});
