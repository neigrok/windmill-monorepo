import test from 'node:test';
import assert from 'node:assert/strict';

import {
  busySpans, chosenSlot, crossedRefusal, DAY_CHIPS, dayChipOf, dayNameOf, defaultSlot, DURATION_CHIPS, refusalOf,
  slotNote, TIME_NEEDED, todayOf, yesterdayOf,
} from '../../../../src/products/gym/backfill/slot.js';

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const span = (startedAt, finishedAt) => ({ startedAt, finishedAt });
const session = (id, startedAt, finishedAt, routine = null) => ({
  id, startedAt, finishedAt, ...(routine ? { plan: { routine, entries: [] } } : {}),
});

// Every default slot below is also asked the lifter's question, and never refused by it.
function slotOf({ day, now, sessions = [], open = null }) {
  const slot = defaultSlot({ day, now, sessions, open });
  if (slot === null) return null;
  assert.equal(slot.finishedAt - slot.startedAt >= 15 * 60_000, true, 'a default slot is at least fifteen minutes');
  assert.equal(new Date(slot.startedAt).getDate(), Number(day.slice(8)), 'and starts on the chosen day');
  assert.equal(refusalOf({ slot, busy: busySpans({ sessions, open, now }), now }), null, 'a default slot never meets a refusal');
  return slot;
}

test('the day chips, the lengths, and the day a chip names', () => {
  const now = at(24, 18, 5);
  assert.deepEqual(DAY_CHIPS, { today: 'Today', yesterday: 'Yesterday', other: 'Other day' });
  assert.deepEqual(DURATION_CHIPS, [
    { minutes: 45, label: '45 min' },
    { minutes: 60, label: '1 h' },
    { minutes: 90, label: '1 h 30' },
  ]);
  assert.deepEqual([todayOf(now), yesterdayOf(now)], ['2026-09-24', '2026-09-23']);
  assert.equal(yesterdayOf(new Date(2026, 0, 1, 0, 10).getTime()), '2025-12-31', 'a year boundary is a day step');
  assert.deepEqual(['2026-09-24', '2026-09-23', '2026-09-22'].map((day) => dayChipOf(day, now)), ['today', 'yesterday', 'other']);
  assert.deepEqual(['2026-09-24', '2026-09-23', '2026-09-22'].map((day) => dayNameOf(day, now)), ['Today', 'Yesterday', '22 Sep']);
  assert.equal(chosenSlot({ day: '2026-09-22', hour: 18, minute: 20, minutes: 60, now }).startedAt, at(22, 18, 20));
});

test('defaultSlot — noon to one on a past day, and on today once the latest end has passed one', () => {
  assert.deepEqual(slotOf({ day: '2026-09-22', now: at(24, 9) }), span(at(22, 12), at(22, 13)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 13, 1) }), span(at(24, 12), at(24, 13)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 20, 45) }), span(at(24, 12), at(24, 13)));
});

test('defaultSlot — today before one, the hour ending at the latest end, never reaching back past midnight', () => {
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 9, 41) + 30_000 }), span(at(24, 8, 40), at(24, 9, 40)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 13) }), span(at(24, 11, 59), at(24, 12, 59)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 0, 40) }), span(at(24, 0), at(24, 0, 39)));
  assert.deepEqual(slotOf({ day: '2026-09-23', now: at(24, 0, 20) }), span(at(23, 12), at(23, 13)), 'yesterday is a whole day');
});

test('defaultSlot — no slot of fifteen minutes fits: null, and the lifter sets the time', () => {
  assert.equal(defaultSlot({ day: '2026-09-24', now: at(24, 0, 10), sessions: [], open: null }), null, 'ten minutes into the day');
  assert.equal(defaultSlot({ day: '2026-09-24', now: at(24, 0), sessions: [], open: null }), null, 'midnight itself');
  assert.equal(defaultSlot({
    day: '2026-09-24', now: at(24, 0, 20), sessions: [session('ses_1', at(23, 23, 50), at(24, 0, 10))], open: null,
  }), null, 'a session over midnight leaves nine minutes, and the walk never takes yesterday');
  assert.equal(defaultSlot({
    day: '2026-09-24', now: at(24, 12, 30), sessions: [], open: session('ses_live', at(24, 0, 5), null),
  }), null, 'the open session has held the day since five past midnight');
  assert.equal(defaultSlot({ day: '2026-09-22', now: at(24, 9), sessions: [session('ses_1', at(22, 0), at(23, 0))], open: null }), null, 'a day the log fills');
  assert.equal(TIME_NEEDED, 'Set a start time for this workout.');
});

test('defaultSlot — a session in the way moves the hour past its finish', () => {
  const sessions = [session('ses_1', at(22, 12, 30), at(22, 13, 10))];
  assert.deepEqual(slotOf({ day: '2026-09-22', now: at(24, 9), sessions }), span(at(22, 13, 10), at(22, 14, 10)));
  const touching = [session('ses_1', at(22, 11), at(22, 12)), session('ses_2', at(22, 13), at(22, 14))];
  assert.deepEqual(slotOf({ day: '2026-09-22', now: at(24, 9), sessions: touching }), span(at(22, 12), at(22, 13)), 'touching ends cross nothing');
});

test('defaultSlot — back-to-back sessions push it past the last of them', () => {
  const sessions = [
    session('ses_1', at(22, 12, 30), at(22, 13, 10)),
    session('ses_2', at(22, 13, 30), at(22, 14, 30)),
    session('ses_3', at(22, 14, 30), at(22, 15)),
  ];
  assert.deepEqual(slotOf({ day: '2026-09-22', now: at(24, 9), sessions }), span(at(22, 15), at(22, 16)));
});

test('defaultSlot — every walk stays inside the chosen day', () => {
  assert.deepEqual(slotOf({ day: '2026-09-22', now: at(24, 18), sessions: [session('ses_1', at(22, 11, 30), at(22, 23, 30))] }), span(at(22, 10, 30), at(22, 11, 30)), 'past its finish would spill into the next day');
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 12, 30), sessions: [session('ses_1', at(24, 11, 40), at(24, 12, 20))] }), span(at(24, 10, 40), at(24, 11, 40)));
  const crowded = [session('ses_0', at(24, 0), at(24, 12, 30)), session('ses_1', at(24, 12, 30), at(24, 13, 40))];
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 14), sessions: crowded }), span(at(24, 13, 40), at(24, 13, 59)), 'what is left after the latest, when nothing else fits');
});

test('defaultSlot — when past the finish runs beyond now, the hour ends at the earliest crossing start instead', () => {
  const sessions = [session('ses_1', at(24, 12, 30), at(24, 13, 40))];
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 14), sessions }), span(at(24, 11, 30), at(24, 12, 30)));
  const morning = [...sessions, session('ses_0', at(24, 11), at(24, 12))];
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 14), sessions: morning }), span(at(24, 10), at(24, 11)));
});

test('defaultSlot — the open session counts from its start until now, and a running one on the page counts too', () => {
  const open = session('ses_live', at(24, 12, 20), null);
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 15), open }), span(at(24, 11, 20), at(24, 12, 20)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 15), sessions: [open] }), span(at(24, 12), at(24, 13)), 'the page’s running row is not a finished session');
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 9, 30), open: session('ses_live', at(24, 9), null) }), span(at(24, 8), at(24, 9)));
  assert.deepEqual(slotOf({ day: '2026-09-24', now: at(24, 15), open: session('ses_live', at(23, 22), null) }), null, 'open since last night');
  assert.deepEqual(slotOf({ day: '2026-09-23', now: at(24, 15), open }), span(at(23, 12), at(23, 13)), 'another day is not in its way');
});

test('the note states the span that will be stored', () => {
  const now = at(24, 18);
  assert.equal(slotNote(span(at(24, 12), at(24, 13)), now), 'Today · 12:00–13:00');
  assert.equal(slotNote(span(at(23, 13, 5), at(23, 14, 5)), now), 'Yesterday · 13:05–14:05');
  assert.equal(slotNote(chosenSlot({ day: '2026-09-22', hour: 18, minute: 20, minutes: 60, now }), now), '22 Sep · 18:20–19:20');
  assert.deepEqual(chosenSlot({ day: '2026-09-22', hour: 18, minute: 20, minutes: 45, now }), span(at(22, 18, 20), at(22, 19, 5)));
});

test('refusalOf — a lifter’s time that crosses a finished session names it, in the words that route to it', () => {
  const now = at(24, 20);
  const pushA = session('ses_1', at(24, 18, 5), at(24, 19, 10), 'Push A');
  const busy = busySpans({ sessions: [pushA], open: null, now });
  assert.deepEqual(refusalOf({ slot: chosenSlot({ day: '2026-09-24', hour: 18, minute: 20, minutes: 60, now }), busy, now }), {
    session: pushA,
    title: 'These times cross a session already in the log.',
    body: 'Push A · today · 18:05 – 19:10 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  });
  assert.equal(refusalOf({ slot: span(at(24, 19, 10), at(24, 19, 55)), busy, now }), null, 'touching its finish crosses nothing');
  assert.equal(refusalOf({ slot: span(at(24, 17, 5), at(24, 18, 5)), busy, now }), null, 'touching its start crosses nothing');
  assert.equal(
    crossedRefusal(session('ses_2', at(20, 9), at(20, 10)), now).body,
    'Free session · Sun 20 Sep · 09:00 – 10:00 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  );
  assert.equal(crossedRefusal(session('ses_3', at(23, 9), at(23, 10), 'Legs'), now).body.startsWith('Legs · yesterday · 09:00 – 10:00 '), true);
});

test('refusalOf — the open session refuses a lifter’s time from its start until now', () => {
  const now = at(24, 19);
  const live = session('ses_live', at(24, 18, 5), null, 'Pull A');
  const busy = busySpans({ sessions: [], open: live, now });
  assert.deepEqual(busy, [{ session: live, startedAt: at(24, 18, 5), finishedAt: now }]);
  assert.equal(
    refusalOf({ slot: span(at(24, 17, 30), at(24, 18, 15)), busy, now }).body,
    'Pull A · today · 18:05 – now is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  );
  assert.equal(refusalOf({ slot: span(at(24, 17), at(24, 18, 5)), busy, now }), null);
});

test('refusalOf — a lifter’s time that ends after now runs past now; one ending in the last minute is taken as ending before it', () => {
  const now = at(16, 0, 10);
  assert.deepEqual(refusalOf({ slot: span(at(15, 23, 30), at(16, 1)), busy: [], now }), {
    session: null,
    title: 'These times run past now.',
    body: 'Tue 15 Sep · 23:30 for 1h 30m ends after now. Shorten it, or start it earlier.',
  });
  assert.deepEqual(chosenSlot({ day: '2026-09-15', hour: 23, minute: 30, minutes: 40, now }), span(at(15, 23, 30), at(16, 0, 9)), 'ending at now is clamped a minute back');
  assert.equal(refusalOf({ slot: chosenSlot({ day: '2026-09-15', hour: 23, minute: 30, minutes: 40, now }), busy: [], now }), null);
  assert.equal(refusalOf({ slot: chosenSlot({ day: '2026-09-15', hour: 23, minute: 30, minutes: 45, now }), busy: [], now }).title, 'These times run past now.');
  assert.equal(refusalOf({ slot: span(at(15, 23, 30), now), busy: [], now }).title, 'These times run past now.', 'a span ending in the minute now is in runs past the latest end');
  assert.deepEqual(chosenSlot({ day: '2026-09-15', hour: 23, minute: 30, minutes: 30, now }), span(at(15, 23, 30), at(16, 0)), 'one that ends before is kept');
});
