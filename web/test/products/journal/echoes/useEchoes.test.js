// `locate` takes an occurrence index, not an offset: a span indexes the UTF-16 string the browser holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { locate } from '../../../../src/products/journal/echoes/useEchoes.js';

const TWICE = "i don't know. and then i don't know.";

test('locate — a passage that is still in the body comes back as its span', () => {
  assert.deepEqual(locate('slept badly. i like c++ now.', 'i like c++ now.', 0), [13, 28]);
  assert.deepEqual(locate('i like c++ now.', 'i like c++ now.', 0), [0, 15]);
});

test('locate — the hint picks WHICH "i don\'t know." the passage is', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", 0), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", 1), [23, 36]);
});

test('locate — no hint, or a hint the server declined to send, is the first occurrence', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", undefined), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", -1), [0, 13]);
  assert.deepEqual(locate(TWICE, "i don't know.", null), [0, 13]);
});

test('locate — a hint that over-counts falls back to the first occurrence', () => {
  assert.deepEqual(locate(TWICE, "i don't know.", 5), [0, 13]);
  assert.deepEqual(locate('i like c++ now.', 'i like c++ now.', 2), [0, 15]);
});

test('locate — text the page no longer holds is not shown, and neither is nothing at all', () => {
  assert.equal(locate('slept badly.', 'i like c++ now.', 0), null);
  assert.equal(locate('', 'i like c++ now.', 0), null);
  assert.equal(locate('slept badly.', '', 0), null);
  assert.equal(locate(undefined, 'i like c++ now.', 0), null);
  assert.equal(locate('slept badly.', undefined, 0), null);
});

test('locate — the span it returns slices the passage back out, accents and emoji included', () => {
  const accented = 'j’étais fatigué. et puis j’étais fatigué encore.';
  const span = locate(accented, 'j’étais fatigué encore.', 0);
  assert.deepEqual(span, [25, 48]);
  assert.equal(accented.slice(span[0], span[1]), 'j’étais fatigué encore.');

  const emoji = 'good day 🌙 and then a bad one 🌙 after it';
  const found = locate(emoji, '🌙', 1);
  assert.deepEqual(found, [31, 33]);
  assert.equal(emoji.slice(found[0], found[1]), '🌙');
});
