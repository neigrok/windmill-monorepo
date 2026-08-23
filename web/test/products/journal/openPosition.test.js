// The opening position is the whole of the "canvas opens in the middle of the diary" bug: a dated
// hash a hop wrote is not a destination the writer chose, and a reload taken mid-walk must not
// resurrect it. These cases are the rule as plain values — no DOM, no canvas, no browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOP_MARK,
  dayOfHash,
  markedAsHop,
  openPosition,
  documentEntry,
} from '../../../src/products/journal/openPosition.js';

const DAY = '#/journal/2026-07-14';
const HOPPED = { hash: DAY, marked: true };            // the document loaded on an entry a hop stamped
const ARRIVED = { hash: DAY, marked: false };          // the same URL, pasted or sent
const TONIGHT = { hash: '#/journal', marked: false };

test('a plain #/journal opens on tonight, whatever the entry was', () => {
  assert.equal(openPosition('#/journal', TONIGHT), null);
  assert.equal(openPosition('#/journal', ARRIVED), null);
  assert.equal(openPosition('#/journal', HOPPED), null);
  assert.equal(openPosition('#/journal', { hash: '#/journal', marked: true }), null);
});

test('a dated hash the document did not enter on is a deep link — that day', () => {
  assert.equal(openPosition(DAY, TONIGHT), '2026-07-14');
  assert.equal(openPosition(DAY, { hash: '#/journal/2026-01-02', marked: true }), '2026-07-14');
});

test('an unmarked entry is a real deep link: the day someone was sent still opens', () => {
  assert.equal(openPosition(DAY, ARRIVED), '2026-07-14');
  assert.equal(openPosition(DAY, { hash: DAY }), '2026-07-14');
  assert.equal(openPosition(DAY, { hash: DAY, marked: 'true' }), '2026-07-14');
});

test('the entry a hop stamped opens on tonight', () => {
  assert.equal(openPosition(DAY, HOPPED), null);
});

test('an in-session hop off a stamped entry still resolves its day', () => {
  assert.equal(openPosition('#/journal/2026-05-02', HOPPED), '2026-05-02');
  assert.equal(openPosition('#/journal', HOPPED), null);
  // ...and Back onto the entry hash is the front door again, so it opens on tonight
  assert.equal(openPosition(DAY, HOPPED), null);
});

test('the answer is stable: repeated reads never drift, and no reader spends it', () => {
  for (let n = 0; n < 5; n += 1) {
    assert.equal(openPosition(DAY, HOPPED), null, 'the stamped entry stopped opening on tonight');
    assert.equal(openPosition(DAY, ARRIVED), '2026-07-14', 'the deep link stopped resolving');
  }
  // interleaved, in either order, and it is the same rule for whoever asks first
  assert.equal(openPosition('#/journal/2026-05-02', HOPPED), '2026-05-02');
  assert.equal(openPosition(DAY, HOPPED), null);
  assert.equal(openPosition('#/journal/2026-05-02', HOPPED), '2026-05-02');
  assert.equal(openPosition(DAY, HOPPED), null);
});

test('a missing entry decides nothing — the hash alone is read', () => {
  assert.equal(openPosition(DAY, null), '2026-07-14');
  assert.equal(openPosition(DAY, undefined), '2026-07-14');
  assert.equal(openPosition('#/journal', null), null);
});

test('the document entry is one frozen fact, the same object every time it is asked for', () => {
  const first = documentEntry();
  assert.equal(documentEntry(), first);
  assert.equal(documentEntry(), first);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first, { hash: '', marked: false });   // no window here: nothing was entered on
  assert.equal(openPosition(DAY, first), '2026-07-14');
});

test('only the hop mark itself counts — a look-alike state is not a hop', () => {
  assert.equal(markedAsHop({ [HOP_MARK]: true }), true);
  assert.equal(markedAsHop({ [HOP_MARK]: 'true' }), false);
  assert.equal(markedAsHop({ [HOP_MARK]: 1 }), false);
  assert.equal(markedAsHop({ [HOP_MARK]: false }), false);
  assert.equal(markedAsHop({}), false);
  assert.equal(markedAsHop(null), false);
  assert.equal(markedAsHop(undefined), false);
});

test('a hash that is not a whole ISO day is not a day, and opens on tonight', () => {
  assert.equal(dayOfHash('#/journal/2026-7-4'), null);
  assert.equal(dayOfHash('#/journal/2026-07'), null);
  assert.equal(dayOfHash('#/journal/tonight'), null);
  assert.equal(dayOfHash('#/journal/'), null);
  assert.equal(dayOfHash('#/gym/2026-07-14'), null);
  assert.equal(dayOfHash(''), null);
  assert.equal(dayOfHash(null), null);
  assert.equal(dayOfHash(undefined), null);
  assert.equal(openPosition('#/journal/tonight', TONIGHT), null);
  assert.equal(openPosition(undefined, HOPPED), null);
});

test('the day is read out of a hash that carries more after it', () => {
  assert.equal(dayOfHash(DAY), '2026-07-14');
  assert.equal(dayOfHash('#/journal/2026-07-14/'), '2026-07-14');
  assert.equal(dayOfHash('#/journal/2026-07-14?from=echo'), '2026-07-14');
});
