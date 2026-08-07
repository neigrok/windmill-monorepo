// The statistics surface's rules, pinned — the window it looks through, the axis each movement's
// line is honestly drawn on, and the one thing a chart of training may never do, which is start its
// scale somewhere flattering.
//
// Every number the surface shows was decided by the domain and arrives on the wire already made, so
// nothing below asserts an e1RM or a top set. What is asserted is the WINDOW and the GEOMETRY —
// which is the whole of what this layer decides, and the whole of what Lift's Progress tab got
// wrong (docs/lift-dossier.md: an unnormalised shared Y axis, and a cache keyed on a collection
// length rather than on the data).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  axisOf, isEmpty, linePlot, movementCard, MOVEMENT_PAGE, PLOT, POINT_WINDOW, statsView, valueOf,
  weekBars, WEEK_WINDOW,
} from '../../../src/products/gym/stats.js';

const CATALOG = [
  { id: 'bench-press', name: 'Bench Press' },
  { id: 'chin-up', name: 'Chin-up' },
];

// Two Mondays, because two kinds of instant land on this surface and only one of them happened to
// anybody. A SESSION ran at a moment a lifter stood in, so its date is read in the lifter's zone; a
// WEEK is a bucket the store made with `date_trunc('week', started_at AT TIME ZONE 'UTC')`, so it
// arrives as a UTC Monday midnight and is read in UTC or it is read a day early.
const MONDAY = new Date(2026, 6, 6, 0, 0).getTime();      // Mon 6 Jul 2026, where the reader stands
const UTC_MONDAY = Date.UTC(2026, 6, 6);                  // Mon 6 Jul 2026, as a week bucket arrives
const WEEK = 7 * 86400000;

function weeks(...counts) {
  return counts.map(([sessions, workingSets], index) => ({
    startedAt: UTC_MONDAY + index * WEEK,
    sessions,
    workingSets,
  }));
}

// A WEEK NOBODY TRAINED IS A ZERO AND NOT A GAP — the store fills the span, so nothing here
// synthesizes a calendar. And the bar for it has no height, because zero has a length and its
// length is zero: drawing a nub for it would be a week of training that never happened.
test('weekBars — a week nobody trained is present at zero, and draws nothing', () => {
  const bars = weekBars(weeks([3, 18], [0, 0], [4, 26]));
  assert.equal(bars.bars.length, 3);
  assert.equal(bars.sessionsMax, 4);
  assert.equal(bars.setsMax, 26);
  assert.deepEqual(bars.bars.map((bar) => bar.sessions), [3, 0, 4]);
  assert.deepEqual(bars.bars.map((bar) => bar.sessionsPct), [75, 0, 100]);
  assert.deepEqual(bars.bars.map((bar) => bar.setsPct), [69.23, 0, 100]);
  assert.equal(bars.older, 0);
  // A bar carries no text, so the label is the whole of what a reader listening to this screen
  // gets — and it is written where the copy is, not interpolated in a view where "1 sessions" is
  // one template away.
  assert.deepEqual(bars.bars.map((bar) => bar.sessionsLabel), [
    'week of Mon 6 Jul: 3 sessions',
    'week of Mon 13 Jul: 0 sessions',
    'week of Mon 20 Jul: 4 sessions',
  ]);
  assert.equal(weekBars(weeks([1, 1])).bars[0].sessionsLabel, 'week of Mon 6 Jul: 1 session');
  assert.equal(weekBars(weeks([1, 1])).bars[0].setsLabel, 'week of Mon 6 Jul: 1 working set');
});

// The two series never share a scale. Sessions peak at 4 and working sets at 26, and each is drawn
// against its own maximum — one plot with two Y axes lets whoever chose the scales decide which
// series looks like it is winning, which is the loudest way to turn a fact into a grade.
test('weekBars — sessions and working sets are scaled apart, never against one axis', () => {
  const bars = weekBars(weeks([2, 26], [4, 13]));
  assert.deepEqual(bars.bars.map((bar) => bar.sessionsPct), [50, 100]);
  assert.deepEqual(bars.bars.map((bar) => bar.setsPct), [100, 50]);
});

test('weekBars — the window is the last twelve, and the ends are named by their day', () => {
  const long = weekBars(weeks(...Array.from({ length: 20 }, (each, index) => [1, index + 1])));
  assert.equal(long.bars.length, WEEK_WINDOW);
  assert.equal(long.older, 8);
  assert.equal(long.olderLabel, '8 earlier weeks not shown');
  assert.equal(weekBars(weeks(...Array.from({ length: 13 }, () => [1, 1]))).olderLabel, '1 earlier week not shown');
  assert.equal(weekBars(weeks([1, 1])).olderLabel, null);
  // Windowed off the END of the series — a quarter is the last quarter, not the first one logged.
  assert.deepEqual(long.bars.map((bar) => bar.workingSets), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(long.from, 'Mon 31 Aug');
  assert.equal(long.to, 'Mon 16 Nov');
});

// A WEEK IS NAMED BY THE BUCKET IT IS, NOT BY WHERE IT IS READ. The start instant is a UTC Monday
// midnight, so a reader west of Greenwich was standing in the Sunday evening before it: every bar
// and both ends of the span read one day early in Los Angeles while the phone, which spells the
// same instant in UTC (Readout.day(_:utc:)), read Monday. One product may not name the same week
// two days.
test('weekBars — the week is named by its UTC Monday, in whatever zone the log is read', () => {
  const zone = process.env.TZ;
  try {
    for (const where of ['America/Los_Angeles', 'UTC', 'Pacific/Auckland']) {
      process.env.TZ = where;
      const bars = weekBars(weeks([3, 18], [4, 26]));
      assert.equal(bars.bars[0].sessionsLabel, 'week of Mon 6 Jul: 3 sessions');
      assert.equal(bars.bars[0].setsLabel, 'week of Mon 6 Jul: 18 working sets');
      assert.equal(bars.bars[1].sessionsLabel, 'week of Mon 13 Jul: 4 sessions');
      assert.equal(bars.from, 'Mon 6 Jul');
      assert.equal(bars.to, 'Mon 13 Jul');
    }
  } finally {
    if (zone == null) delete process.env.TZ; else process.env.TZ = zone;
  }
});

// The series ENDS at the last week trained rather than at this week, so the label is a pair of
// dates and never "the last 12 weeks" — a relative phrase would quietly claim somebody trained
// recently, which is a claim only a clock could make and this data cannot support.
test('weekBars — an empty log names no span at all', () => {
  const none = weekBars([]);
  assert.deepEqual(none.bars, []);
  assert.equal(none.from, null);
  assert.equal(none.to, null);
  assert.equal(none.sessionsMax, 1);
});

// WHICH AXIS THE LINE IS DRAWN ON, decided by the data. Epley has no answer at or below zero, so a
// chin-up has no estimate to plot — and a chart that invented one would be inventing the only
// number on the card.
test('axisOf — an estimate everywhere is e1RM, a missing one falls back to what actually moved', () => {
  assert.equal(axisOf([{ weightKg: 100, reps: 5, e1rm: 116.7 }, { weightKg: 105, reps: 5, e1rm: 122.5 }]), 'e1rm');
  // Band-assisted → bodyweight: no estimate anywhere, but the load moved, and the load is the fact.
  assert.equal(axisOf([{ weightKg: -20, reps: 8 }, { weightKg: 0, reps: 6 }]), 'load');
  // A movement that crossed zero mid-history: the estimate exists on one point and not the other,
  // so the whole line is drawn on the load rather than on a series with a hole in it.
  assert.equal(axisOf([{ weightKg: -5, reps: 8 }, { weightKg: 10, reps: 6, e1rm: 12 }]), 'load');
  // A bodyweight movement at one fixed load: the load is not the story, the reps are — and the
  // point is already the heaviest set, ties going to more reps, so at one load it IS the best set.
  assert.equal(axisOf([{ weightKg: 0, reps: 8 }, { weightKg: 0, reps: 11 }]), 'reps');
  assert.equal(valueOf({ weightKg: 0, reps: 11 }, 'reps'), 11);
  assert.equal(valueOf({ weightKg: 100, reps: 5, e1rm: 116.7 }, 'e1rm'), 116.7);
  assert.equal(valueOf({ weightKg: 100, reps: 5, e1rm: 116.7 }, 'load'), 100);
});

// THE AXIS STARTS AT ZERO. A line from 116.7 to 122.5 drawn on a 116–123 scale is a lifter
// doubling their bench; drawn from zero it is what it is. The zero rule is always in the plot, so
// the reader can SEE where the scale starts rather than having to trust it.
test('linePlot — the scale runs from zero, and the zero rule is inside the plot', () => {
  const plot = linePlot([116.7, 122.5]);
  assert.equal(plot.floor, 0);
  assert.equal(plot.top, 122.5);
  // Top value at the top pad, zero at the bottom pad — the whole box is 0…top and nothing else.
  assert.deepEqual(plot.dots.map((dot) => dot.y), [
    Math.round((PLOT.padY + ((122.5 - 116.7) / 122.5) * (PLOT.height - PLOT.padY * 2)) * 100) / 100,
    PLOT.padY,
  ]);
  assert.equal(plot.zeroY, PLOT.height - PLOT.padY);
  assert.equal(plot.path, `M${PLOT.padX},12.31 L${PLOT.width - PLOT.padX},9`);
});

// A band-assisted load is a real point on this number line, so the axis goes DOWN to it. An axis
// clipped at zero would draw the assistance coming off as nothing happening at all.
test('linePlot — an assisted load pulls the floor below zero and the rule sits inside the plot', () => {
  const plot = linePlot([-20, -5, 0]);
  assert.equal(plot.floor, -20);
  assert.equal(plot.top, 0);
  assert.equal(plot.zeroY, PLOT.padY);
  assert.equal(plot.dots[0].y, PLOT.height - PLOT.padY);
  assert.ok(plot.zeroY < plot.dots[0].y);
});

test('linePlot — one session is one dot in the middle, because a point is not a trend', () => {
  const plot = linePlot([90]);
  assert.equal(plot.dots.length, 1);
  assert.equal(plot.dots[0].x, PLOT.width / 2);
  assert.equal(plot.path, `M${PLOT.width / 2},${PLOT.padY}`);
});

// Nothing to draw is drawn as nothing. A flat line pinned to the middle of an empty box is a chart
// drawn out of politeness, and the facts under it already say what happened.
test('linePlot — a range with no height has no chart, and an empty series has none either', () => {
  assert.equal(linePlot([0, 0, 0]), null);
  assert.equal(linePlot([]), null);
});

test('movementCard — the window is the last twelve sessions and it says so when it cuts', () => {
  const points = Array.from({ length: 15 }, (each, index) => ({
    at: MONDAY + index * 86400000,
    weightKg: 100 + index,
    reps: 5,
    e1rm: 116.7 + index,
  }));
  const card = movementCard(
    { exerciseId: 'bench-press', lastTrainedAt: MONDAY + 14 * 86400000, points },
    CATALOG,
    { now: MONDAY + 16 * 86400000 },
  );
  assert.equal(card.name, 'Bench Press');
  assert.equal(card.sessions, POINT_WINDOW);
  assert.equal(card.older, 3);
  assert.equal(card.axis, 'e1rm');
  assert.equal(card.lastTrained, '2 days ago');
  // The ends are said in words, because there is no hover on this surface to reveal them.
  assert.deepEqual(card.first, { value: '119.7', when: 'Thu 9 Jul' });
  assert.deepEqual(card.last, { value: '130.7', when: 'Mon 20 Jul' });
  // And the axis states its own range beside the chart rather than leaving it to be assumed.
  assert.equal(card.caption, 'e1RM · kg · 0 – 130.7');
  assert.equal(card.summary, 'Bench Press — e1RM · kg · 0 – 130.7, 12 sessions from 119.7 to 130.7');
});

test('movementCard — a chin-up plots its reps, and its bests are facts and not trophies', () => {
  const card = movementCard(
    {
      exerciseId: 'chin-up',
      lastTrainedAt: MONDAY,
      points: [
        { at: MONDAY - WEEK, weightKg: 0, reps: 6 },
        { at: MONDAY, weightKg: 0, reps: 9 },
      ],
      heaviest: { weightKg: 0, reps: 9, at: MONDAY },
    },
    CATALOG,
    { now: MONDAY },
  );
  assert.equal(card.axis, 'reps');
  assert.equal(card.caption, 'top set · reps · 0 – 9');
  assert.equal(card.lastTrained, 'today');
  assert.deepEqual(card.bests, [{ label: 'Heaviest', value: '9 reps', when: 'Mon 6 Jul' }]);
});

// ZERO IS NOT A LOAD BUT THE ABSENCE OF ONE — the rule the finish comparison, a routine's target
// and the e1RM tile all already read. So the heaviest a dip or a push-up has ever been is a number
// of REPS, and "0 kg × 12" was this card printing a weight nobody lifted under the five movements
// the schema seeds as bodyweight. A band-assisted load is a real point on this number line and
// still prints as one.
test('movementCard — a bodyweight best is spelled in reps, and an assisted one still in kilos', () => {
  const heaviest = (weightKg, reps) => movementCard(
    {
      exerciseId: 'dip',
      lastTrainedAt: MONDAY,
      points: [{ at: MONDAY, weightKg, reps }],
      heaviest: { weightKg, reps, at: MONDAY },
    },
    CATALOG,
    { now: MONDAY },
  ).bests[0];
  assert.deepEqual(heaviest(0, 12), { label: 'Heaviest', value: '12 reps', when: 'Mon 6 Jul' });
  assert.equal(heaviest(0, 1).value, '1 rep');
  assert.equal(heaviest(-20, 8).value, '−20 kg × 8');
  assert.equal(heaviest(20, 6).value, '20 kg × 6');
});

// The standing bests are the finish screen's record rules asked with no session to compare against.
// The third rule — more reps at a load you have used before — has no standing form and is absent by
// design: with nothing to compare against, every mark already is the best reps ever done at its
// load. A movement with no honest estimate carries no e1RM best either.
test('movementCard — a best with no estimate is not printed as one', () => {
  const card = movementCard(
    {
      exerciseId: 'bench-press',
      lastTrainedAt: MONDAY,
      points: [{ at: MONDAY, weightKg: 100, reps: 5, e1rm: 116.7 }],
      bestE1rm: { weightKg: 100, reps: 5, at: MONDAY, e1rm: 116.7 },
      heaviest: { weightKg: 110, reps: 1, at: MONDAY - WEEK },
    },
    CATALOG,
    { now: MONDAY },
  );
  assert.deepEqual(card.bests, [
    { label: 'Best e1RM', value: '116.7 kg', when: 'Mon 6 Jul' },
    { label: 'Heaviest', value: '110 kg × 1', when: 'Mon 29 Jun' },
  ]);
  // One point: an end, no beginning, and no arrow between them — and a sentence that says so
  // rather than reading "1 sessions from 116.7 to 116.7".
  assert.equal(card.first, null);
  assert.deepEqual(card.last, { value: '116.7', when: 'Mon 6 Jul' });
  assert.equal(card.summary, 'Bench Press — e1RM · kg · 0 – 116.7, one session at 116.7');
});

test('statsView — the whole surface, and an empty log says so as a state of the log', () => {
  const view = statsView(
    {
      weeks: weeks([2, 12], [3, 20]),
      movements: [{
        exerciseId: 'bench-press',
        lastTrainedAt: MONDAY,
        points: [{ at: MONDAY, weightKg: 100, reps: 5, e1rm: 116.7 }],
      }],
    },
    CATALOG,
    { now: MONDAY },
  );
  assert.equal(isEmpty(view), false);
  assert.equal(view.weeks.bars.length, 2);
  assert.equal(view.movements.length, 1);
  assert.equal(view.movements[0].name, 'Bench Press');

  assert.equal(isEmpty(statsView({ weeks: [], movements: [] }, CATALOG, { now: MONDAY })), true);
  // A reply missing either half entirely is still a screen and never a crash.
  assert.equal(isEmpty(statsView({}, CATALOG, { now: MONDAY })), true);
});

// The card list opens at a page and the rest are one tap away. Nothing is hidden and nothing is
// ranked: the order is the store's — most recently trained first, which is the order the routines
// screen already sorts by.
test('MOVEMENT_PAGE — the movements open at a page and the order is the store’s', () => {
  assert.equal(MOVEMENT_PAGE, 6);
  const view = statsView(
    {
      weeks: [],
      movements: ['a', 'b', 'c'].map((id) => ({
        exerciseId: id, lastTrainedAt: MONDAY, points: [{ at: MONDAY, weightKg: 50, reps: 5, e1rm: 58.3 }],
      })),
    },
    CATALOG,
    { now: MONDAY },
  );
  assert.deepEqual(view.movements.map((movement) => movement.exerciseId), ['a', 'b', 'c']);
});
