// `locate` takes an occurrence index, not an offset: a span indexes the UTF-16 string the browser holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { locate, stillStanding } from '../../../../src/products/journal/echoes/useEchoes.js';

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

// `stillStanding` is the retraction rule the canvas runs on every keystroke-settled body: an echo
// quoting words the writer has just deleted comes off the page as they delete them, with no fetch
// and no reload. The rule has to be careful in one direction — silence about a body is not evidence
// against the quote inside it — or scrolling away would retire echoes nobody touched.
test('stillStanding — a quote whose words are gone from an edited body is dropped', () => {
  const matches = [
    { day: '2026-08-11', text: 'хочется в сербию', occurrenceHint: 0 },
    { day: '2026-08-11', text: 'еще и заболел', occurrenceHint: 0 },
  ];
  const live = new Map([['2026-08-11', 'еще и заболел вчера.']]);

  assert.deepEqual(stillStanding(matches, live), [matches[1]]);
});

test('stillStanding — a match into a page the canvas is not holding is left alone', () => {
  const matches = [{ day: '2024-01-01', text: 'i want to learn c++.', occurrenceHint: 0 }];

  assert.deepEqual(stillStanding(matches, new Map()), matches);
  assert.deepEqual(stillStanding(matches, new Map([['2026-08-11', 'something else']])), matches);
});

test('stillStanding — the occurrence hint still picks WHICH copy, so an edit to one is not both', () => {
  const twice = { day: '2026-08-11', text: "i don't know.", occurrenceHint: 1 };
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', "i don't know. i don't know."]])),
                   [twice]);
  // One of the two removed: the second occurrence is gone, and the hint falls back to the first.
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', "i don't know."]])), [twice]);
  // Both gone: nothing stands.
  assert.deepEqual(stillStanding([twice], new Map([['2026-08-11', 'nothing like it']])), []);
});

test('stillStanding — an empty body retires every quote into it, which is what deleting a page is', () => {
  const matches = [{ day: '2026-08-11', text: 'хочется в сербию', occurrenceHint: 0 }];
  assert.deepEqual(stillStanding(matches, new Map([['2026-08-11', '']])), []);
});
