// `locate` is where ECHOES.md's third rule is actually enforced: a quote is re-located in the live
// page body at render, or it is not shown. Everything else about an echo is presentation; this is
// the one function that can put the wrong sentence on screen under a real date.
//
// It takes an occurrence index rather than a character offset on purpose — the server counts bytes
// and the browser slices UTF-16 code units, so an offset parts company with the body at the first
// non-ASCII character and again at the first emoji. An occurrence has no encoding in it to
// disagree about, which is what the last two cases here are for.

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

// The hint is a hint. A page that said something three times and now says it once must still show
// the quote it does have, rather than dropping a passage the reader can plainly see.
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

// The span is handed to the canvas to light, so it has to index the string the browser holds — not
// the bytes the server counted. Both of these have a byte length larger than their code-unit
// length, and the span still slices back to the passage.
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
