import test from 'node:test';
import assert from 'node:assert/strict';

import { chunk } from '../../../../src/products/journal/search/chunk.js';

test('chunk — every passage span slices back to its exact text', () => {
  const body = 'Rain all morning. The walk did not happen.\nI noticed how much I counted on it.';
  const passages = chunk(body);
  assert.ok(passages.length >= 3);
  for (const passage of passages) assert.equal(body.slice(passage.lo, passage.hi), passage.text);
});

test('chunk — splits on sentence terminators and newlines, whitespace trimmed off the span', () => {
  const passages = chunk('One. Two!  Three?');
  assert.deepEqual(passages.map((p) => p.text), ['One.', 'Two!', 'Three?']);
});
