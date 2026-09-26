import assert from 'node:assert/strict';
import test from 'node:test';
import { diff, generate } from '../generate.mjs';

test('regenerating the corpus reproduces every committed file byte for byte', () => {
  const first = generate();
  assert.deepEqual(diff(first), []);
  assert.deepEqual(generate(), first);
});
