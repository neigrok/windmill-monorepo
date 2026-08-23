import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyBetween, nKeysBetween } from '../../../../src/products/roadmap/sync/fractionalIndex.js';

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// A seeded PRNG (mulberry32) so "thousands of iterations" are reproducible run to run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertValidKey(key) {
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0, 'key is non-empty');
  for (const ch of key) assert.ok(DIGITS.includes(ch), `char "${ch}" is in the alphabet`);
}

function assertStrictlyAscendingUnique(keys) {
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1] < keys[i], `keys[${i - 1}] (${keys[i - 1]}) < keys[${i}] (${keys[i]})`);
  }
  assert.equal(new Set(keys).size, keys.length, 'no collisions');
}

test('keyBetween(null, null) is a valid mid key', () => {
  const key = keyBetween(null, null);
  assertValidKey(key);
  assert.equal(key, 'a0');
});

test('open-end cases put the key on the correct side of its anchor', () => {
  const mid = keyBetween(null, null);
  const after = keyBetween(mid, null);
  const before = keyBetween(null, mid);
  assertValidKey(after);
  assertValidKey(before);
  assert.ok(mid < after, `${mid} < ${after}`);
  assert.ok(before < mid, `${before} < ${mid}`);
  const between = keyBetween(before, after);
  assert.ok(before < between && between < after, `${before} < ${between} < ${after}`);
});

test('keyBetween throws when a >= b (no room to insert)', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  assert.throws(() => keyBetween(b, a));   // a > b reversed
  assert.throws(() => keyBetween(a, a));   // a == b
});

test('keyBetween is a pure function — identical inputs give identical output', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  assert.equal(keyBetween(a, b), keyBetween(a, b));
  assert.equal(keyBetween(null, a), keyBetween(null, a));
  assert.equal(keyBetween(b, null), keyBetween(b, null));
});

test('5000 random neighbor inserts never violate ordering or collide', () => {
  const random = rng(0x1234abcd);
  const keys = [keyBetween(null, null)];
  const seen = new Set(keys);

  for (let iter = 0; iter < 5000; iter++) {
    const at = Math.floor(random() * (keys.length + 1));
    const left = at > 0 ? keys[at - 1] : null;
    const right = at < keys.length ? keys[at] : null;

    const key = keyBetween(left, right);
    assertValidKey(key);
    if (left !== null) assert.ok(left < key, `left ${left} < key ${key} (iter ${iter})`);
    if (right !== null) assert.ok(key < right, `key ${key} < right ${right} (iter ${iter})`);
    assert.ok(!seen.has(key), `key ${key} is new (iter ${iter})`);

    seen.add(key);
    keys.splice(at, 0, key);
  }

  assert.equal(keys.length, 5001);
  assertStrictlyAscendingUnique(keys);
});

test('500 successive inserts against a fixed left anchor stay ordered and unique', () => {
  const left = keyBetween(null, null);
  let right = keyBetween(left, null);
  const collected = [left, right];
  for (let i = 0; i < 500; i++) {
    const mid = keyBetween(left, right);   // always subdivide [left, right), pushing toward left
    assertValidKey(mid);
    assert.ok(left < mid && mid < right, `${left} < ${mid} < ${right} (iter ${i})`);
    collected.push(mid);
    right = mid;
  }
  assertStrictlyAscendingUnique([...collected].sort());
  assert.equal(new Set(collected).size, collected.length);
});

test('500 successive inserts against a fixed right anchor stay ordered and unique', () => {
  const right = keyBetween(null, null);
  let left = keyBetween(null, right);
  const collected = [left, right];
  for (let i = 0; i < 500; i++) {
    const mid = keyBetween(left, right);   // always subdivide (left, right], pushing toward right
    assertValidKey(mid);
    assert.ok(left < mid && mid < right, `${left} < ${mid} < ${right} (iter ${i})`);
    collected.push(mid);
    left = mid;
  }
  assertStrictlyAscendingUnique([...collected].sort());
  assert.equal(new Set(collected).size, collected.length);
});

test('1000 appends are strictly increasing; 1000 prepends are strictly decreasing', () => {
  let prev = keyBetween(null, null);
  const appended = [prev];
  for (let i = 0; i < 1000; i++) {
    const next = keyBetween(prev, null);
    assertValidKey(next);
    assert.ok(prev < next, `append ${prev} < ${next} (iter ${i})`);
    appended.push(next);
    prev = next;
  }
  assertStrictlyAscendingUnique(appended);

  let head = keyBetween(null, null);
  const prepended = [head];
  for (let i = 0; i < 1000; i++) {
    const before = keyBetween(null, head);
    assertValidKey(before);
    assert.ok(before < head, `prepend ${before} < ${head} (iter ${i})`);
    prepended.push(before);
    head = before;
  }
  assertStrictlyAscendingUnique([...prepended].reverse());
});

test('nKeysBetween seeds n evenly-spaced, ascending, unique keys', () => {
  for (const n of [0, 1, 2, 5, 20, 100]) {
    const keys = nKeysBetween(null, null, n);
    assert.equal(keys.length, n);
    keys.forEach(assertValidKey);
    assertStrictlyAscendingUnique(keys);
  }
});

test('nKeysBetween respects both bounds and the open ends', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);

  const inside = nKeysBetween(a, b, 30);
  assert.equal(inside.length, 30);
  inside.forEach(assertValidKey);
  assertStrictlyAscendingUnique([a, ...inside, b]);

  const tail = nKeysBetween(a, null, 30);
  assertStrictlyAscendingUnique([a, ...tail]);
  tail.forEach(assertValidKey);

  const head = nKeysBetween(null, b, 30);
  assertStrictlyAscendingUnique([...head, b]);
  head.forEach(assertValidKey);
});

test('a seeded group accepts an insert between every adjacent pair', () => {
  const seeded = nKeysBetween(null, null, 50);
  const merged = [];
  for (let i = 0; i < seeded.length; i++) {
    merged.push(seeded[i]);
    if (i + 1 < seeded.length) {
      const between = keyBetween(seeded[i], seeded[i + 1]);
      assert.ok(seeded[i] < between && between < seeded[i + 1]);
      merged.push(between);
    }
  }
  assertStrictlyAscendingUnique(merged);
});
