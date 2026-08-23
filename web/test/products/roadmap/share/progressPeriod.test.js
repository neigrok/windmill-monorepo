import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProgressPeriod,
  newThisPeriod,
  ledgerDeltas,
  sinceLabel,
  PERIOD_MS,
  DAY_MS,
  WEEK_UNIT,
  DAY_UNIT,
} from '../../../../src/products/roadmap/share/progressPeriod.js';

const PLANTED = 1_700_000_000_000; // a Tuesday, so the weeks close on Tuesdays

const states = (...ids) => new Map(ids.map((id) => [id, 'complete']));

test('the period counts from planting: day one is week 1, and every seventh day turns it', () => {
  const week = (offset) => new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + offset }).index;

  assert.equal(week(0), 1);
  assert.equal(week(DAY_MS * 6 + DAY_MS - 1), 1);   // the last millisecond of the first week
  assert.equal(week(PERIOD_MS), 2);                 // seven days in, exactly
  assert.equal(week(PERIOD_MS * 2 + DAY_MS), 3);
  assert.equal(week(PERIOD_MS * 51), 52);
});

test('the label is "Week N" by default and "Day N" by choice, both counted from planting', () => {
  const at = (offset, unit) => new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + offset, unit }).label;

  assert.equal(at(0, WEEK_UNIT), 'Week 1');
  assert.equal(at(0, DAY_UNIT), 'Day 1');
  assert.equal(at(DAY_MS * 16, WEEK_UNIT), 'Week 3');
  assert.equal(at(DAY_MS * 16, DAY_UNIT), 'Day 17');
  assert.equal(at(DAY_MS * 99, DAY_UNIT), 'Day 100');
  assert.equal(at(0, 'fortnight'), 'Week 1');         // an unknown unit is weeks, never a guess
});

test('a tree with no planting time has no week number, and says so as the share ordinal', () => {
  const unplanted = new ProgressPeriod({ plantedAt: 0, now: PLANTED, ordinal: 4 });

  assert.equal(unplanted.index, 0);
  assert.equal(unplanted.startedAt, 0);
  assert.equal(unplanted.label, 'Update #4');
  assert.equal(new ProgressPeriod({ plantedAt: 0, now: PLANTED, unit: DAY_UNIT, ordinal: 1 }).label, 'Update #1');
});

test('a clock that reads before planting lands in the first period rather than a negative one', () => {
  const skewed = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED - PERIOD_MS });

  assert.equal(skewed.index, 1);
  assert.equal(skewed.day, 1);
  assert.equal(skewed.startedAt, PLANTED);
});

test('the period start is the planting anniversary, so the baseline never falls on a Sunday', () => {
  const third = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 2 + DAY_MS * 3 });

  assert.equal(third.index, 3);
  assert.equal(third.startedAt, PLANTED + PERIOD_MS * 2);
});

test('new = completed since the last posted card, filtered to steps the tree still holds', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 2 });
  const prior = { completed: ['a'], at: PLANTED + PERIOD_MS, count: 1 };

  assert.deepEqual(
    newThisPeriod({ completed: new Set(['a', 'b', 'c', 'gone']), states: states('a', 'b', 'c'), prior, period }),
    { lit: ['b', 'c'], sinceAt: 0 },
  );
});

test('no card posted yet falls back to the period start — this period’s stamped work, and only it', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 2 + DAY_MS });
  const completedAt = {
    old: PLANTED + DAY_MS,                   // week 1 — before this period opened
    edge: period.startedAt - 1,              // the last millisecond of week 2
    fresh: period.startedAt,                 // the first of week 3
    later: period.startedAt + DAY_MS,
    unstamped: undefined,                    // completed elsewhere: no local stamp, so unplaceable
  };

  assert.deepEqual(
    newThisPeriod({
      completed: new Set(['old', 'edge', 'fresh', 'later', 'unstamped']),
      states: states('old', 'edge', 'fresh', 'later', 'unstamped'),
      completedAt,
      prior: null,
      period,
    }),
    { lit: ['fresh', 'later'], sinceAt: 0 },
  );
});

test('no card and no planting time falls back to the last seven days — true, just not numbered', () => {
  const now = PLANTED + PERIOD_MS * 9;
  const period = new ProgressPeriod({ plantedAt: 0, now, ordinal: 1 });
  const completedAt = { stale: now - PERIOD_MS - 1, justIn: now - PERIOD_MS, today: now - DAY_MS };

  assert.deepEqual(
    newThisPeriod({ completed: new Set(['stale', 'justIn', 'today']), states: states('stale', 'justIn', 'today'), completedAt, prior: null, period }),
    { lit: ['justIn', 'today'], sinceAt: 0 },
  );
});

test('a skipped period carries over: the card lights both and names the one it carried from', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 4 }); // week 5
  const postedInWeek3 = { completed: ['a'], at: PLANTED + PERIOD_MS * 2, count: 1 };

  const carried = newThisPeriod({ completed: new Set(['a', 'b', 'c']), states: states('a', 'b', 'c'), prior: postedInWeek3, period });
  assert.deepEqual(carried, { lit: ['b', 'c'], sinceAt: postedInWeek3.at });
  assert.equal(sinceLabel({ plantedAt: PLANTED, at: carried.sinceAt, unit: WEEK_UNIT }), 'week 3');
  assert.equal(sinceLabel({ plantedAt: PLANTED, at: carried.sinceAt, unit: DAY_UNIT }), 'day 15');
});

test('posting every period carries nothing over — only a SKIPPED period earns the sub-line', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 4 }); // week 5
  const postedInWeek4 = { completed: ['a'], at: PLANTED + PERIOD_MS * 3, count: 1 };
  const postedThisWeek = { completed: ['a'], at: PLANTED + PERIOD_MS * 4 + DAY_MS, count: 2 };

  assert.equal(newThisPeriod({ completed: new Set(['a', 'b']), states: states('a', 'b'), prior: postedInWeek4, period }).sinceAt, 0);
  assert.equal(newThisPeriod({ completed: new Set(['a', 'b']), states: states('a', 'b'), prior: postedThisWeek, period }).sinceAt, 0);
  assert.equal(sinceLabel({ plantedAt: PLANTED, at: 0, unit: WEEK_UNIT }), null);
  assert.equal(sinceLabel({ plantedAt: 0, at: PLANTED, unit: WEEK_UNIT }), null); // unnumbered periods, no sub-line
});

test('the ledger is one tick per elapsed period, each the stamp of the card posted in it', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 3 }); // week 4
  const history = [
    { at: PLANTED + DAY_MS * 3, delta: 2 },                 // week 1 · a card claiming +2
    { at: PLANTED + PERIOD_MS * 2 + DAY_MS, delta: 3 },     // week 3 · a card claiming +3
    { at: PLANTED + PERIOD_MS * 3 + 5, delta: 1 },          // this period — the card appends its own tick
  ];

  assert.deepEqual(ledgerDeltas({ history, period }), [2, 0, 3]); // week 2 published nothing, and is shown as such
});

test('the ledger never contradicts a published card, and never guesses at an unposted period', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 2 }); // week 3
  assert.deepEqual(ledgerDeltas({ history: [], period }), [0, 0]);
  const twice = [{ at: PLANTED, delta: 2 }, { at: PLANTED + DAY_MS, delta: 3 }];
  assert.deepEqual(ledgerDeltas({ history: twice, period }), [5, 0]);
  // A malformed entry can never pull a tick below the floor.
  assert.deepEqual(ledgerDeltas({ history: [{ at: PLANTED, delta: -4 }, { at: PLANTED + 1 }], period }), [0, 0]);
});

test('the ledger keeps the five periods behind this one, and the first period has none', () => {
  const period = new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED + PERIOD_MS * 8 }); // week 9
  const history = [];
  for (let week = 1; week <= 8; week += 1) history.push({ at: PLANTED + PERIOD_MS * (week - 1), delta: 1 });

  assert.deepEqual(ledgerDeltas({ history, period }), [1, 1, 1, 1, 1]);
  assert.deepEqual(ledgerDeltas({ history, period, count: 2 }), [1, 1]);
  assert.deepEqual(ledgerDeltas({ history, period: new ProgressPeriod({ plantedAt: PLANTED, now: PLANTED }) }), []);
  assert.deepEqual(ledgerDeltas({ history, period: new ProgressPeriod({ plantedAt: 0, now: PLANTED }) }), []);
});
