import assert from 'node:assert/strict';
import test from 'node:test';
import { SenderWait } from '../../client/sender.js';

// A draw that answers its bound, the longest sleep a backoff can take.
const longest = (bound) => bound;

test('§7.4: a clock-skew recovery backs off, and neither a kick nor the next skew cuts that short or resets k', () => {
  const wait = new SenderWait();
  wait.results(['clock-skew'], 0, longest);
  assert.deepEqual([wait.k, wait.until, wait.due(999)], [1, 1000, false]);
  wait.kick(500);
  assert.deepEqual([wait.k, wait.until, wait.due(999)], [1, 1000, false]);
  wait.results(['clock-skew'], 1000, longest);
  assert.deepEqual([wait.k, wait.until], [2, 3000]);
  wait.results(['ok'], 3000, longest);
  assert.equal(wait.k, 0);
});

test('§7.4: a kick wakes the sender at once from any other backoff and resets k', () => {
  const wait = new SenderWait();
  wait.backoff(0, longest);
  wait.backoff(1000, longest);
  assert.deepEqual([wait.k, wait.until], [2, 3000]);
  wait.kick(1500);
  assert.deepEqual([wait.k, wait.until, wait.due(1500)], [0, 1500, true]);
});
