// A movement's record, as rules (§H) — what the page draws, and the four places it deliberately
// draws NOTHING: no best-e1RM tile and no chart where Epley has no answer, no chart frame around an
// empty series, and no tiles at all for a movement nobody has worked.
//
// Every number arrives already made, so nothing below asserts an e1RM or a top set. What is
// asserted is the WINDOW, the GEOMETRY and the SPELLING — the whole of what this layer decides, and
// the whole of what the retired statistics surface got to keep: the axis rule for a bodyweight
// movement, and a scale that starts at zero. (docs/lift-dossier.md is the other half of the reason:
// Lift's Progress tab shared one Y axis between movements and cached charts on a collection length.)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chartOf, daysOf, recordsOf, recordView, RENAME_PROOF, renameProofOf, subheadOf, tilesOf, whenOf,
} from '../../../src/products/gym/record.js';

// The design board's own movement, at the design board's own numbers: 19 May → 10 Aug, 105 × 5,
// e1RM 122.5. Every instant here is one a lifter stood in and is read in their zone.
const NOW = new Date(2026, 7, 10, 20, 30).getTime();     // Mon 10 Aug 2026, evening
const TODAY = new Date(2026, 7, 10, 18, 0).getTime();
const YESTERDAY = new Date(2026, 7, 9, 18, 0).getTime();
const JUL_27 = new Date(2026, 6, 27, 18, 0).getTime();
const MAY_19 = new Date(2026, 4, 19, 18, 0).getTime();

const BACK_SQUAT = {
  exercise: { id: 'back-squat', name: 'Back Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  routineCount: 2,
  // The names as well as the count, because the rename sheet's proof answers "which of my days
  // still say this" and a number cannot. `routineCount` is exactly `routines.length` on the wire.
  routines: ['Push A', 'Legs'],
  sessionCount: 34,
  bestE1rm: { weightKg: 105, reps: 5, at: TODAY, e1rm: 122.5 },
  heaviest: { weightKg: 105, reps: 5, at: TODAY, e1rm: 122.5 },
  e1rmSeries: [
    { at: MAY_19, weightKg: 100, reps: 5, e1rm: 116.7 },
    { at: JUL_27, weightKg: 102.5, reps: 5, e1rm: 119.6 },
    { at: TODAY, weightKg: 105, reps: 5, e1rm: 122.5 },
  ],
  records: [
    { at: TODAY, weightKg: 105, reps: 5, e1rm: 122.5 },
    { at: JUL_27, weightKg: 102.5, reps: 5, e1rm: 119.6 },
  ],
  recentDays: [
    {
      sessionId: 'ses_today',
      startedAt: TODAY,
      sets: [
        { id: 'set_1', exerciseId: 'back-squat', setNumber: 1, weightKg: 105, reps: 5, kind: 'working', note: '', completedAt: TODAY + 600_000 },
        { id: 'set_2', exerciseId: 'back-squat', setNumber: 2, weightKg: 105, reps: 5, kind: 'working', note: '', completedAt: TODAY + 900_000 },
        { id: 'set_3', exerciseId: 'back-squat', setNumber: 3, weightKg: 105, reps: 4, kind: 'working', note: '', completedAt: TODAY + 1_200_000 },
      ],
    },
    {
      sessionId: 'ses_jul27',
      startedAt: JUL_27,
      sets: [
        { id: 'set_4', exerciseId: 'back-squat', setNumber: 1, weightKg: 102.5, reps: 5, kind: 'working', note: '', completedAt: JUL_27 + 600_000 },
        { id: 'set_5', exerciseId: 'back-squat', setNumber: 2, weightKg: 80, reps: 8, kind: 'drop', note: '', completedAt: JUL_27 + 900_000 },
      ],
    },
  ],
};

// A CHIN-UP HAS NO e1RM AT ALL. Epley has no answer at or below zero load, so the wire omits the
// best, the series and the ladder together — and this movement is the case every honesty rule on
// the page is written for.
const CHIN_UP = {
  exercise: { id: 'chin-up', name: 'Chin-up', pattern: 'pull', equipment: 'bodyweight', stepKg: 1, custom: false },
  routineCount: 1,
  routines: ['Pull A'],
  sessionCount: 9,
  heaviest: { weightKg: 0, reps: 12, at: JUL_27 },
  recentDays: [{
    sessionId: 'ses_jul27',
    startedAt: JUL_27,
    sets: [{ id: 'set_6', exerciseId: 'chin-up', setNumber: 1, weightKg: 0, reps: 12, kind: 'working', note: '', completedAt: JUL_27 + 1_500_000 }],
  }],
};

// A movement in the catalog nobody has ever worked. Sixty-four of these ship with every account, so
// this is not an edge — it is what the page looks like most of the times it is first opened.
const NEVER = {
  exercise: { id: 'zercher-squat', name: 'Zercher Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  routineCount: 0,
  sessionCount: 0,
};

// A MOVEMENT THE LOG HOLDS AND THE COUNT DOES NOT. `sessionCount` is over WORKING sets and
// `recentDays` over every kind but a warmup (backend domain/Record.h says so in as many words), so
// a movement only ever taken as a drop set answers a zero with a day of sets beside it.
const DROPPED = {
  exercise: { id: 'lat-pulldown', name: 'Lat Pulldown', pattern: 'pull', equipment: 'cable', stepKg: 5, custom: false },
  routineCount: 0,
  sessionCount: 0,
  recentDays: [{
    sessionId: 'ses_jul27',
    startedAt: JUL_27,
    sets: [{ id: 'set_7', exerciseId: 'lat-pulldown', setNumber: 1, weightKg: 60, reps: 12, kind: 'drop', note: '', completedAt: JUL_27 + 1_800_000 }],
  }],
};

test('whenOf — today and yesterday by name, every other day by its date', () => {
  assert.equal(whenOf(TODAY, NOW), 'today');
  assert.equal(whenOf(YESTERDAY, NOW), 'yesterday');
  assert.equal(whenOf(JUL_27, NOW), '27 Jul');
  assert.equal(whenOf(MAY_19, NOW), '19 May');
});

test('subheadOf — how it is loaded, how much of the program names it, how much of the log holds it', () => {
  assert.equal(subheadOf(BACK_SQUAT), 'barbell · in 2 routines · 34 sessions');
  assert.equal(subheadOf(CHIN_UP), 'bodyweight · in 1 routine · 9 sessions');
  assert.equal(subheadOf({ ...BACK_SQUAT, sessionCount: 1 }), 'barbell · in 2 routines · 1 session');
  // A zero counted out loud reads as a score. 'never logged' is the picker's own word for it, and
  // 'in no routine' is a fact about the program rather than a nought beside a movement's name.
  assert.equal(subheadOf(NEVER), 'barbell · in no routine · never logged');
  // But 'never logged' is a claim about the LOG, and the count it is read off is a claim about
  // working sets. A movement that has only ever been dropped is in the log, and the page below this
  // line lists the day it was — so the line says what the zero actually is.
  assert.equal(subheadOf(DROPPED), 'cable · in no routine · no working sets');
});

test('tilesOf — the standing best, the set that made it, and the heaviest beside it', () => {
  assert.deepEqual(tilesOf(BACK_SQUAT, NOW), [
    { label: 'best e1RM', value: '122.5', sub: 'today · 105 × 5', standing: true },
    { label: 'heaviest', value: '105', sub: 'kg · for 5', standing: false },
  ]);
});

// EPLEY IS UNDEFINED AT OR BELOW ZERO LOAD, so the tile is ABSENT — not a zero, not a dash. And the
// heaviest a chin-up has ever been is a number of REPS: zero is not a load, it is the absence of
// one, and '0 kg · for 12' was a weight nobody lifted.
test('tilesOf — a movement with no honest estimate has no e1RM tile, and its heaviest is in reps', () => {
  assert.deepEqual(tilesOf(CHIN_UP, NOW), [
    { label: 'heaviest', value: '12', sub: 'reps · bodyweight', standing: false },
  ]);

  // A band takes load off the bar, so an assisted load is a real point on this number line and
  // still prints as a load — with the minus a reader can actually see.
  const assisted = { ...CHIN_UP, heaviest: { weightKg: -20, reps: 8, at: JUL_27 } };
  assert.deepEqual(tilesOf(assisted, NOW), [
    { label: 'heaviest', value: '−20', sub: 'kg · for 8', standing: false },
  ]);

  // Nobody has worked it, so there is no heaviest either, and the page draws no tile row at all.
  assert.deepEqual(tilesOf(NEVER, NOW), []);
});

// THE SCALE STARTS AT ZERO. 116.7 and 122.5 drawn on a 116–123 floor is a lifter doubling their
// bench; drawn from zero they are what they are, and a bar's LENGTH is its value.
test('chartOf — bars from zero to the series’ own top, oldest first, named by the days on screen', () => {
  const chart = chartOf(BACK_SQUAT, NOW);
  assert.equal(chart.top, 122.5);
  assert.deepEqual(chart.bars.map((bar) => bar.pct), [95.27, 97.63, 100]);
  assert.deepEqual(chart.bars.map((bar) => bar.at), [MAY_19, JUL_27, TODAY]);
  assert.equal(chart.from, '19 May');
  assert.equal(chart.to, '10 Aug');

  // ONE GOLD BAR, and it is the session the tile above the chart prints. Every session that ever
  // beat the one before it is in the ladder under the chart; painting all of them here made a third
  // of the quarter gold, and a colour that means "a record happened here" stops meaning it then.
  assert.deepEqual(chart.bars.map((bar) => bar.standing), [false, false, true]);

  // A best that is OLDER than the window leaves no gold in it at all — the honest reading of a
  // quarter that beat nothing, and never a second-best promoted for the sake of a colour.
  const older = chartOf({ ...BACK_SQUAT, bestE1rm: { weightKg: 110, reps: 5, at: MAY_19 - 86_400_000, e1rm: 128.3 } }, NOW);
  assert.deepEqual(older.bars.map((bar) => bar.standing), [false, false, false]);

  // A bar carries no text, so this is the whole of what a reader listening to the page gets.
  assert.deepEqual(chart.bars.map((bar) => bar.label), [
    '19 May · 100 × 5 · e1RM 116.7',
    '27 Jul · 102.5 × 5 · e1RM 119.6',
    'today · 105 × 5 · e1RM 122.5',
  ]);
});

// NO SERIES, NO CHART — no frame, no axis, no empty box. A chin-up has no estimate to plot and the
// retired surface answered that by switching the line to another quantity under the same caption;
// §H asks for one chart of one figure, so the honest answer is the absence.
test('chartOf — a movement with no estimate draws no chart, and neither does one with no history', () => {
  assert.equal(chartOf(CHIN_UP, NOW), null);
  assert.equal(chartOf(NEVER, NOW), null);
  assert.equal(chartOf({ ...BACK_SQUAT, e1rmSeries: [] }, NOW), null);
});

// A SERIES THAT BROKE THE WIRE'S PROMISE DRAWS NOTHING, not a row of bars with no height. Every
// comparison with NaN is false, so `top <= 0` let a point with no estimate through and every bar
// came out `height:NaN%` — a chart of nothing, saying nothing about why.
test('chartOf — a point with no estimate in it draws no chart at all', () => {
  const holed = { ...BACK_SQUAT, e1rmSeries: [{ at: MAY_19, weightKg: 100, reps: 5 }, { at: TODAY, weightKg: 105, reps: 5, e1rm: 122.5 }] };
  assert.equal(chartOf(holed, NOW), null);
});

test('chartOf — one session is one bar at full height, because it is the top of its own series', () => {
  const chart = chartOf({ ...BACK_SQUAT, e1rmSeries: [{ at: TODAY, weightKg: 105, reps: 5, e1rm: 122.5 }] }, NOW);
  assert.equal(chart.bars.length, 1);
  assert.equal(chart.bars[0].pct, 100);
  assert.equal(chart.from, '10 Aug');
  assert.equal(chart.to, '10 Aug');
});

// EVERY SESSION THAT BEAT EVERY SESSION BEFORE IT, newest first — and the first row is the mark that
// still stands, which is the number the tile above the chart prints.
test('recordsOf — the ladder, newest first, and only the newest one still stands', () => {
  assert.deepEqual(recordsOf(BACK_SQUAT, NOW), [
    { at: TODAY, load: '105 × 5', e1rm: 'e1RM 122.5', when: 'today', standing: true },
    { at: JUL_27, load: '102.5 × 5', e1rm: 'e1RM 119.6', when: '27 Jul', standing: false },
  ]);
  assert.deepEqual(recordsOf(CHIN_UP, NOW), []);
  assert.deepEqual(recordsOf(NEVER, NOW), []);
});

test('daysOf — the last days as they were performed, and a set the plan never asked for says so', () => {
  assert.deepEqual(daysOf(BACK_SQUAT, NOW), [
    { sessionId: 'ses_today', when: 'today', sets: '105 × 5 · 105 × 5 · 105 × 4' },
    { sessionId: 'ses_jul27', when: '27 Jul', sets: '102.5 × 5 · 80 × 8 drop' },
  ]);
  // Zero is the absence of a load here too, so a chin-up's sets say what they were.
  assert.deepEqual(daysOf(CHIN_UP, NOW), [
    { sessionId: 'ses_jul27', when: '27 Jul', sets: 'bodyweight × 12' },
  ]);
  assert.deepEqual(daysOf(NEVER, NOW), []);
});

test('recordView — the whole page, made once', () => {
  const view = recordView(BACK_SQUAT, { now: NOW });
  assert.equal(view.name, 'Back Squat');
  assert.equal(view.subhead, 'barbell · in 2 routines · 34 sessions');
  assert.equal(view.logged, true);
  assert.equal(view.tiles.length, 2);
  assert.equal(view.chart.bars.length, 3);
  assert.equal(view.records.length, 2);
  assert.equal(view.days.length, 2);
});

// A MOVEMENT WITH NO HISTORY DRAWS NO FURNITURE. Not an empty chart, not a zero tile, not a heading
// over an empty list — the page says what is true about the movement and stops.
test('recordView — a movement nobody has worked draws nothing but its name and one line', () => {
  const view = recordView(NEVER, { now: NOW });
  assert.equal(view.name, 'Zercher Squat');
  assert.equal(view.subhead, 'barbell · in no routine · never logged');
  assert.equal(view.logged, false);
  assert.deepEqual(view.tiles, []);
  assert.equal(view.chart, null);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.days, []);
});

// AND THE SENTENCE IS NEVER PRINTED OVER SETS THAT EXIST. "You haven't worked this movement yet"
// is drawn on `logged`, and reading it off the session count alone put it directly above the day of
// drop sets the same read sent — three claims and one list, on one page, disagreeing.
test('recordView — a movement only ever dropped is in the log, and says so above its sets', () => {
  const view = recordView(DROPPED, { now: NOW });
  assert.equal(view.subhead, 'cable · in no routine · no working sets');
  assert.equal(view.logged, true);
  assert.deepEqual(view.tiles, []);
  assert.equal(view.chart, null);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.days, [{ sessionId: 'ses_jul27', when: '27 Jul', sets: '60 × 12 drop' }]);
});

// ── The rename sheet's proof (§N screen 32) ─────────────────────────────────────────────────────

// A NAME IS A LABEL ON A STABLE ID, so renaming is not destructive and never forks a record — and
// this block PROVES that rather than promising it. Every line of it is read off the page's own read.
// A constant here would be the product asserting something it did not check, on the one screen whose
// whole job is proof, which is why the board's own four lines are pinned against the board's own
// movement: 34 sessions, 3 PRs, e1RM 122.5, Push A · Legs.
test('renameProofOf — the four lines, every one of them off the read behind the sheet', () => {
  assert.equal(RENAME_PROOF, 'Everything follows the name');
  assert.deepEqual(renameProofOf({ ...BACK_SQUAT, records: [...BACK_SQUAT.records, { at: MAY_19, weightKg: 100, reps: 5, e1rm: 116.7 }] }), [
    { label: 'sessions', value: '34 · unchanged' },
    { label: 'records', value: '3 PRs · e1RM 122.5 kept' },
    { label: 'routines', value: 'Push A · Legs' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
  // The label is the column and the value is the fact, so the count is bare under `sessions` and
  // spelled out in the subhead above — `sessions · 34 sessions · unchanged` says the word twice.
  // The label stays plural over one of anything, exactly as `routines` does over a single name.
  assert.deepEqual(renameProofOf({ ...BACK_SQUAT, sessionCount: 1, records: [BACK_SQUAT.records[0]], routines: ['Push A'] }), [
    { label: 'sessions', value: '1 · unchanged' },
    { label: 'records', value: '1 PR · e1RM 122.5 kept' },
    { label: 'routines', value: 'Push A' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
});

// A ROW WITH NOTHING TO PROVE IS OMITTED, exactly as every list on this wire is. `0 sessions ·
// unchanged` is not a promise a movement nobody has worked can make, and a movement with no estimate
// — a chin-up, where Epley has no answer — has no PR ladder to keep. What always stands is the alias:
// it is the one thing a rename DOES rather than preserves.
test('renameProofOf — a movement with nothing to keep claims nothing, and still says the alias', () => {
  assert.deepEqual(renameProofOf(NEVER), [{ label: 'old name', value: 'searchable as an alias' }]);
  assert.deepEqual(renameProofOf(CHIN_UP), [
    { label: 'sessions', value: '9 · unchanged' },
    { label: 'routines', value: 'Pull A' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
  // A count with no names beside it is a read from a store that sends none: the row is dropped
  // rather than filled in with a number, because this row's whole job is to say WHICH routines.
  assert.deepEqual(renameProofOf({ ...NEVER, routineCount: 2 }), [{ label: 'old name', value: 'searchable as an alias' }]);
});
