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

test('§7.4: a 503 sleeps at least its retryAfterMs; a kick wakes the sender no earlier, and past it at once', () => {
  const wait = new SenderWait();
  wait.unavailable(0, 5000, longest);
  assert.deepEqual([wait.k, wait.until, wait.floor], [1, 5000, 5000]);
  wait.kick(2000);
  assert.deepEqual([wait.k, wait.until, wait.due(4999), wait.due(5000)], [0, 5000, false, true]);
  wait.backoff(6000, longest);
  wait.unavailable(7000, 500, longest);
  assert.deepEqual([wait.k, wait.until, wait.floor], [2, 9000, 7500]);
  wait.kick(8000);
  assert.deepEqual([wait.k, wait.until, wait.due(8000)], [0, 8000, true]);
});

test('§7.3 and §7.4: a leave pushes during any backoff, a clock-skew one included, but not during a server-requested wait', () => {
  const wait = new SenderWait();
  wait.results(['clock-skew'], 0, longest);
  assert.deepEqual([wait.due(500), wait.leaveMayPush(500)], [false, true]);
  wait.retry(1000, 1000);
  assert.deepEqual([wait.k, wait.until, wait.leaveMayPush(1999), wait.leaveMayPush(2000)], [1, 2000, false, true]);
  wait.unavailable(3000, 4000, () => 0);
  assert.deepEqual([wait.until, wait.leaveMayPush(6999), wait.leaveMayPush(7000)], [7000, false, true]);
});
