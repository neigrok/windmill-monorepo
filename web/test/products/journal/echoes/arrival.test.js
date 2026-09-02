// The arming rule decides a claim about TIME — that this is news — and a claim about time is exactly
// what a test can pin and a browser cannot. Every case here is a way the arrival could lie: lighting
// what was already on screen, lighting the same news twice because a poll re-read it, lighting a
// page because a passage was taken AWAY from it, or lighting three at once.
//
// The mount's first read is NOT a case here. It is not a flag this rule reads — the read seeds the
// memory with its own reply as it lands (useEchoes.js), because a flag read one commit later is a
// flag that two reads landing in one batch walk straight past, and a tab return starts exactly two.

import test from 'node:test';
import assert from 'node:assert/strict';

import { KINDLE_MS, armArrival, resumedOnMount } from '../../../../src/products/journal/echoes/arrival.js';

const TODAY = '2026-09-01';

// Pages as the hook hands them over. A passage is the day it came from AND its words; `verified`
// means the quotes have been re-located in the live bodies, which is the only state in which the
// client can be said to HOLD an echo.
const page = (day, passages, verified = true) => ({ day, passages, verified });
const from = (day, ...texts) => texts.map((text) => `${day} ${text}`);

const arm = (over = {}) => armArrival({
  shown: new Map(), pages: [], openDay: null, nearest: null, today: TODAY, ...over,
});

const presented = (result) => [...result.shown].map(([day, seen]) => [day, [...seen].sort()]);
const memory = (day, ...passages) => new Map([[day, new Set(passages)]]);

test('a passage the reader has not been shown is an arrival, naming the page and its whole count', () => {
  const landed = arm({
    shown: memory('2026-08-11', ...from('2026-05-02', 'older words')),
    pages: [page('2026-08-11', [...from('2026-05-02', 'older words'), ...from('2026-01-19', 'older still')])],
  });

  assert.deepEqual(landed.arrival, { day: '2026-08-11', count: 2 });
  assert.deepEqual(presented(landed), [['2026-08-11', [
    '2026-01-19 older still', '2026-05-02 older words',
  ]]]);
});

test('an arrival arms EXACTLY ONCE — no re-read, no poll beat and no re-derivation arms it twice', () => {
  const shown = memory('2026-08-11', ...from('2026-05-02', 'older words'));
  const pages = [page('2026-08-11', [...from('2026-05-02', 'older words'), ...from('2026-01-19', 'older still')])];

  const first = arm({ shown, pages });
  assert.equal(first.arrival.day, '2026-08-11');

  for (let beat = 0; beat < 5; beat += 1) {
    const again = arm({ shown: first.shown, pages });
    assert.equal(again.arrival, null, 'the union happened at the moment of arming');
    assert.deepEqual(presented(again), presented(first));
  }
});

// The memory is keyed by the passage, not by the day it came from. `maxPerMatchDay` is a live server
// knob, so a page CAN quote one past day twice — and keyed by the day, showing the first would
// present the second for free, and the second would never be news at all.
test('two passages out of one past day are two pieces of news, not one', () => {
  const both = from('2026-05-02', 'the first thing', 'the second thing');

  const one = arm({ pages: [page('2026-08-11', [both[0]])] });
  assert.deepEqual(one.arrival, { day: '2026-08-11', count: 1 });

  const two = arm({ shown: one.shown, pages: [page('2026-08-11', both)] });
  assert.deepEqual(two.arrival, { day: '2026-08-11', count: 2 },
    'the second passage from that day was presented for free');
  assert.deepEqual(presented(two), [['2026-08-11', [...both].sort()]]);
});

test('the same words from two different days are two passages; the same words twice are one', () => {
  const seen = arm({ pages: [page('2026-08-11', from('2026-05-02', 'the same words'))] });

  const otherDay = arm({
    shown: seen.shown,
    pages: [page('2026-08-11',
      [...from('2026-05-02', 'the same words'), ...from('2026-01-19', 'the same words')])],
  });
  assert.equal(otherDay.arrival.count, 2);

  const repeated = arm({
    shown: seen.shown,
    pages: [page('2026-08-11',
      [...from('2026-05-02', 'the same words'), ...from('2026-05-02', 'the same words')])],
  });
  assert.equal(repeated.arrival, null, 'one passage sent twice is one passage');
});

test('ARM ON verified, NOT ON PRESENCE: an unverified page waits, and is not presented either', () => {
  const waiting = arm({ pages: [page('2026-08-11', from('2026-05-02', 'older words'), false)] });

  assert.equal(waiting.arrival, null, 'the client does not hold this echo yet');
  assert.deepEqual(presented(waiting), [], 'and it has not been shown, so it can still be news');

  const held = arm({ shown: waiting.shown, pages: [page('2026-08-11', from('2026-05-02', 'older words'))] });
  assert.deepEqual(held.arrival, { day: '2026-08-11', count: 1 });
});

test('a shrinking match set arms nothing — retirement and dismissal are silent, and stay presented', () => {
  const shown = memory('2026-08-11',
    ...from('2026-05-02', 'older words'), ...from('2026-01-19', 'older still'));

  const fewer = arm({ shown, pages: [page('2026-08-11', from('2026-05-02', 'older words'))] });
  assert.equal(fewer.arrival, null);
  assert.deepEqual(presented(fewer), [['2026-08-11', [
    '2026-01-19 older still', '2026-05-02 older words',
  ]]], 'a passage that comes back after a repair pass is a repair, not news');

  assert.equal(arm({ shown, pages: [] }).arrival, null);
});

test('nothing arms on the page whose ink is open — the new row own entrance is the event', () => {
  const shown = memory('2026-08-11', ...from('2026-05-02', 'older words'));
  const open = arm({
    shown,
    openDay: '2026-08-11',
    pages: [page('2026-08-11', [...from('2026-05-02', 'older words'), ...from('2026-01-19', 'older still')])],
  });

  assert.equal(open.arrival, null);
  assert.deepEqual(presented(open), [['2026-08-11', [
    '2026-01-19 older still', '2026-05-02 older words',
  ]]], 'it was presented, so closing the ink cannot make it news again');
});

// THE CALM CEILING. A repair pass can drop echoes onto several old pages in one read; three lights
// is three transients, which is the one thing the whole design refuses to spend.
test('several pages landing in one read light ONE tab, and the rest are presented silently', () => {
  const three = arm({
    nearest: '2026-08-20',
    pages: [
      page('2026-03-03', from('2025-01-01', 'a')),
      page('2026-08-20', from('2025-02-02', 'b')),
      page('2026-06-06', from('2025-03-03', 'c')),
    ],
  });

  assert.deepEqual(three.arrival, { day: '2026-08-20', count: 1 }, 'the page at the reading waterline');
  assert.deepEqual(presented(three), [
    ['2026-03-03', ['2025-01-01 a']],
    ['2026-08-20', ['2025-02-02 b']],
    ['2026-06-06', ['2025-03-03 c']],
  ], 'the other two took their resting face, and neither is news any more');
});

test('tonight page outranks the waterline; with neither in the read, the newest takes the light', () => {
  assert.equal(arm({
    nearest: '2026-03-03',
    pages: [page('2026-03-03', from('2025-01-01', 'a')), page(TODAY, from('2025-02-02', 'b'))],
  }).arrival.day, TODAY);

  assert.equal(arm({
    nearest: '2026-08-20',
    pages: [page('2026-03-03', from('2025-01-01', 'a')), page('2026-06-06', from('2025-02-02', 'b'))],
  }).arrival.day, '2026-06-06');
});

test('an empty read, and a read carrying only pages already presented, arm nothing', () => {
  assert.equal(arm({ pages: [] }).arrival, null);
  assert.equal(arm({
    shown: memory('2026-08-11', ...from('2026-05-02', 'older words')),
    pages: [page('2026-08-11', from('2026-05-02', 'older words'))],
  }).arrival, null);
});

test('a page carrying no passages arms nothing and throws nothing, however it is malformed', () => {
  assert.equal(arm({ pages: [page('2026-08-11', [])] }).arrival, null);
  assert.equal(arm({ pages: [{ day: '2026-08-11', verified: true }] }).arrival, null);

  // A page carrying nothing has been shown nothing, so it does not enter the memory at all. That
  // memory now also decides whether a TAB is a new object on screen, so a day written into it for an
  // empty page would suppress the ramp as well as the light.
  const empty = arm({ pages: [page('2026-08-11', [])] });
  assert.deepEqual(presented(empty), []);

  const later = arm({ shown: empty.shown, pages: [page('2026-08-11', from('2026-05-02', 'x'))] });
  assert.deepEqual(later.arrival, { day: '2026-08-11', count: 1 });
});

test('arming never mutates the memory it was handed — the caller decides when to keep it', () => {
  const shown = memory('2026-08-11', ...from('2026-05-02', 'older words'));
  arm({
    shown,
    pages: [page('2026-08-11', [...from('2026-05-02', 'older words'), ...from('2026-01-19', 'b')])],
  });

  assert.deepEqual([...shown.get('2026-08-11')], ['2026-05-02 older words']);
});

// A remount is a scroll, a re-render or a canvas that grew — none of them is the writer surfacing,
// so none of them may re-fire a light that is already burning.
test('resumedOnMount — a tab mounting past the kindle resumes; one still kindling does not', () => {
  const now = 1000000;
  assert.equal(resumedOnMount(now - KINDLE_MS - 1, now), true);
  assert.equal(resumedOnMount(now - KINDLE_MS, now), false, 'still inside the ramp — it is the same kindle');
  assert.equal(resumedOnMount(now, now), false);
  assert.equal(resumedOnMount(null, now), false, 'a light held under an overlay has not kindled at all');
  assert.equal(resumedOnMount(undefined, now), false);
});
