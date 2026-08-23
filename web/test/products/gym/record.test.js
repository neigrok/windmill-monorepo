import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chartOf, daysOf, recordsOf, recordView, RENAME_PROOF, renameProofOf, subheadOf, tilesOf, whenOf,
} from '../../../src/products/gym/record.js';

const NOW = new Date(2026, 7, 10, 20, 30).getTime();
const TODAY = new Date(2026, 7, 10, 18, 0).getTime();
const YESTERDAY = new Date(2026, 7, 9, 18, 0).getTime();
const JUL_27 = new Date(2026, 6, 27, 18, 0).getTime();
const MAY_19 = new Date(2026, 4, 19, 18, 0).getTime();

const BACK_SQUAT = {
  exercise: { id: 'back-squat', name: 'Back Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  routineCount: 2,
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

const NEVER = {
  exercise: { id: 'zercher-squat', name: 'Zercher Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
  routineCount: 0,
  sessionCount: 0,
};

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
  assert.equal(subheadOf(NEVER), 'barbell · in no routine · never logged');
  assert.equal(subheadOf(DROPPED), 'cable · in no routine · no working sets');
});

test('tilesOf — the standing best, the set that made it, and the heaviest beside it', () => {
  assert.deepEqual(tilesOf(BACK_SQUAT, NOW), [
    { label: 'best e1RM', value: '122.5', sub: 'today · 105 × 5', standing: true },
    { label: 'heaviest', value: '105', sub: 'kg · for 5', standing: false },
  ]);
});

test('tilesOf — a movement with no honest estimate has no e1RM tile, and its heaviest is in reps', () => {
  assert.deepEqual(tilesOf(CHIN_UP, NOW), [
    { label: 'heaviest', value: '12', sub: 'reps · bodyweight', standing: false },
  ]);

  const assisted = { ...CHIN_UP, heaviest: { weightKg: -20, reps: 8, at: JUL_27 } };
  assert.deepEqual(tilesOf(assisted, NOW), [
    { label: 'heaviest', value: '−20', sub: 'kg · for 8', standing: false },
  ]);

  assert.deepEqual(tilesOf(NEVER, NOW), []);
});

test('chartOf — bars from zero to the series’ own top, oldest first, named by the days on screen', () => {
  const chart = chartOf(BACK_SQUAT, NOW);
  assert.equal(chart.top, 122.5);
  assert.deepEqual(chart.bars.map((bar) => bar.pct), [95.27, 97.63, 100]);
  assert.deepEqual(chart.bars.map((bar) => bar.at), [MAY_19, JUL_27, TODAY]);
  assert.equal(chart.from, '19 May');
  assert.equal(chart.to, '10 Aug');

  assert.deepEqual(chart.bars.map((bar) => bar.standing), [false, false, true]);

  const older = chartOf({ ...BACK_SQUAT, bestE1rm: { weightKg: 110, reps: 5, at: MAY_19 - 86_400_000, e1rm: 128.3 } }, NOW);
  assert.deepEqual(older.bars.map((bar) => bar.standing), [false, false, false]);

  assert.deepEqual(chart.bars.map((bar) => bar.label), [
    '19 May · 100 × 5 · e1RM 116.7',
    '27 Jul · 102.5 × 5 · e1RM 119.6',
    'today · 105 × 5 · e1RM 122.5',
  ]);
});

test('chartOf — a movement with no estimate draws no chart, and neither does one with no history', () => {
  assert.equal(chartOf(CHIN_UP, NOW), null);
  assert.equal(chartOf(NEVER, NOW), null);
  assert.equal(chartOf({ ...BACK_SQUAT, e1rmSeries: [] }, NOW), null);
});

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

test('recordView — a movement only ever dropped is in the log, and says so above its sets', () => {
  const view = recordView(DROPPED, { now: NOW });
  assert.equal(view.subhead, 'cable · in no routine · no working sets');
  assert.equal(view.logged, true);
  assert.deepEqual(view.tiles, []);
  assert.equal(view.chart, null);
  assert.deepEqual(view.records, []);
  assert.deepEqual(view.days, [{ sessionId: 'ses_jul27', when: '27 Jul', sets: '60 × 12 drop' }]);
});

test('renameProofOf — the four lines, every one of them off the read behind the sheet', () => {
  assert.equal(RENAME_PROOF, 'Everything follows the name');
  assert.deepEqual(renameProofOf({ ...BACK_SQUAT, records: [...BACK_SQUAT.records, { at: MAY_19, weightKg: 100, reps: 5, e1rm: 116.7 }] }), [
    { label: 'sessions', value: '34 · unchanged' },
    { label: 'records', value: '3 PRs · e1RM 122.5 kept' },
    { label: 'routines', value: 'Push A · Legs' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
  assert.deepEqual(renameProofOf({ ...BACK_SQUAT, sessionCount: 1, records: [BACK_SQUAT.records[0]], routines: ['Push A'] }), [
    { label: 'sessions', value: '1 · unchanged' },
    { label: 'records', value: '1 PR · e1RM 122.5 kept' },
    { label: 'routines', value: 'Push A' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
});

test('renameProofOf — a movement with nothing to keep claims nothing, and still says the alias', () => {
  assert.deepEqual(renameProofOf(NEVER), [{ label: 'old name', value: 'searchable as an alias' }]);
  assert.deepEqual(renameProofOf(CHIN_UP), [
    { label: 'sessions', value: '9 · unchanged' },
    { label: 'routines', value: 'Pull A' },
    { label: 'old name', value: 'searchable as an alias' },
  ]);
  assert.deepEqual(renameProofOf({ ...NEVER, routineCount: 2 }), [{ label: 'old name', value: 'searchable as an alias' }]);
});
