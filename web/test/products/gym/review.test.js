import test from 'node:test';
import assert from 'node:assert/strict';

import {
  comparison, finishHead, RECORD_TITLE, recordSentence, statTiles,
} from '../../../src/products/gym/review.js';
import { KG, LB, spellWeightsIn } from '../../../src/products/gym/units.js';

const CATALOG = [
  { id: 'back-squat', name: 'Back Squat' },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift' },
  { id: 'leg-press', name: 'Leg Press' },
  { id: 'chin-up', name: 'Chin-up' },
];

test('finishHead — the word above a session, and the day it ran', () => {
  const startedAt = new Date(2026, 7, 4, 18, 12).getTime();
  const finishedAt = new Date(2026, 7, 4, 19, 14).getTime();
  assert.deepEqual(finishHead({ startedAt, finishedAt, routine: 'Legs' }), {
    title: 'Session finished',
    subtitle: 'Legs',
    when: 'Tue 4 Aug · 18:12 – 19:14',
  });
  assert.deepEqual(finishHead({ startedAt, finishedAt, routine: 'Pull A', slight: true }), {
    title: 'Ended early',
    subtitle: 'Pull A',
    when: 'Tue 4 Aug · 18:12 – 19:14',
  });
  assert.equal(finishHead({ startedAt, finishedAt, first: true }).subtitle, 'Your first session');
  assert.equal(finishHead({ startedAt, finishedAt }).subtitle, 'Session · no routine');
});

test('statTiles — three facts, and the one that can be absent says so', () => {
  assert.deepEqual(statTiles({ durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5 }), [
    { value: '1h 02m', label: 'Duration' },
    { value: '16', label: 'Working sets' },
    { value: '122.5', label: 'Top e1RM' },
  ]);
  assert.deepEqual(statTiles({ durationMs: 2_820_000, workingSets: 14, topE1rm: 96.3 }), [
    { value: '47m', label: 'Duration' },
    { value: '14', label: 'Working sets' },
    { value: '96.3', label: 'Top e1RM' },
  ]);
  assert.deepEqual(statTiles({ durationMs: 660_000, workingSets: 3 }), [
    { value: '11m', label: 'Duration' },
    { value: '3', label: 'Working sets' },
    { value: '—', label: 'Top e1RM' },
  ]);
});

test('recordSentence — one sentence per kind, and the previous mark in every one of them', () => {
  const previous = { previous: 116.7, previousAt: new Date(2026, 5, 24, 18, 0).getTime() };
  assert.equal(
    recordSentence({ kind: 'e1rm', exerciseId: 'back-squat', value: 122.5, weightKg: 105, reps: 5, ...previous }, CATALOG),
    'Back Squat e1RM 122.5 kg — past 116.7 from Wed 24 Jun.',
  );
  assert.equal(
    recordSentence({ kind: 'heaviest', exerciseId: 'back-squat', value: 105, weightKg: 105, reps: 5, previous: 102.5, previousAt: previous.previousAt }, CATALOG),
    'Back Squat 105 kg × 5 — past 102.5 from Wed 24 Jun.',
  );
  assert.equal(
    recordSentence({ kind: 'reps-at-weight', exerciseId: 'back-squat', value: 8, weightKg: 100, reps: 8, previous: 6, previousAt: previous.previousAt }, CATALOG),
    'Back Squat 8 reps at 100 kg — past 6 from Wed 24 Jun.',
  );
  assert.equal(RECORD_TITLE, 'Personal record');
});

test('recordSentence — in pounds, a reps-at-weight record keeps its previous rep count as a count', (t) => {
  t.after(() => spellWeightsIn(KG));
  spellWeightsIn(LB);
  const previousAt = new Date(2026, 5, 24, 18, 0).getTime();
  assert.equal(
    recordSentence({ kind: 'reps-at-weight', exerciseId: 'back-squat', value: 8, weightKg: 100, reps: 8, previous: 6, previousAt }, CATALOG),
    'Back Squat 8 reps at 220.5 lb — past 6 from Wed 24 Jun.',
  );
  assert.equal(
    recordSentence({ kind: 'heaviest', exerciseId: 'back-squat', value: 105, weightKg: 105, reps: 5, previous: 100, previousAt }, CATALOG),
    'Back Squat 231.5 lb × 5 — past 220.5 from Wed 24 Jun.',
  );
});

test('recordSentence — no record and an unknown kind both draw nothing at all', () => {
  assert.equal(recordSentence(undefined, CATALOG), null);
  assert.equal(recordSentence(null, CATALOG), null);
  assert.equal(
    recordSentence({ kind: 'tonnage', exerciseId: 'back-squat', value: 9000, previous: 8000, previousAt: 0 }, CATALOG),
    null,
  );
});

test('comparison — the plan on the left, what happened on the right, and short is its own form', () => {
  const against = {
    sessionId: 'ses_older',
    routine: 'Legs',
    startedAt: 1_750_723_200_000,
    movements: [
      {
        exerciseId: 'back-squat',
        now: { weightKg: 105, reps: 5, sets: 5 },
        before: { weightKg: 102.5, reps: 5, sets: 5 },
        planned: { sets: 5, reps: 5, weightKg: 102.5 },
      },
      {
        exerciseId: 'romanian-deadlift',
        now: { weightKg: 90, reps: 8, sets: 3 },
        before: { weightKg: 90, reps: 8, sets: 3 },
        planned: { sets: 3, reps: 8, weightKg: 90 },
      },
      {
        exerciseId: 'leg-press',
        now: { weightKg: 140, reps: 10, sets: 3 },
        before: { weightKg: 140, reps: 12, sets: 3 },
        planned: { sets: 3, reps: 12, weightKg: 140 },
      },
    ],
  };
  assert.deepEqual(comparison(against, CATALOG), {
    title: 'Against last Legs',
    rows: [
      { exerciseId: 'back-squat', movement: 'Back Squat', detail: '5×5 @ 102.5 → 5×5 @ 105' },
      { exerciseId: 'romanian-deadlift', movement: 'Romanian Deadlift', detail: '3×8 @ 90 → 3×8 @ 90' },
      { exerciseId: 'leg-press', movement: 'Leg Press', detail: 'planned 3×12 · did 3×10' },
    ],
  });
});

test('comparison — the plan that sets no target, the bodyweight movement, and the movement with no history', () => {
  const against = {
    sessionId: 'ses_older',
    routine: 'Push A',
    startedAt: 1_750_723_200_000,
    movements: [
      { exerciseId: 'chin-up', now: { weightKg: 0, reps: 8, sets: 3 }, planned: { sets: 3 } },
      { exerciseId: 'back-squat', now: { weightKg: 105, reps: 5, sets: 5 }, before: { weightKg: 100, reps: 5, sets: 5 } },
      { exerciseId: 'leg-press', now: { weightKg: 140, reps: 12, sets: 3 } },
    ],
  };
  assert.deepEqual(comparison(against, CATALOG).rows.map((row) => row.detail), [
    '3 × max → 3×8',
    '5×5 @ 100 → 5×5 @ 105',
    '3×12 @ 140',
  ]);
  assert.equal(
    comparison({ routine: 'Push A', movements: [{ exerciseId: 'chin-up', now: { weightKg: 0, reps: 4, sets: 2 }, planned: { sets: 3 } }] }, CATALOG).rows[0].detail,
    '3 × max → 2×4',
  );
});

test('comparison — a session that ramped through its whole plan is never told it fell short', () => {
  const ramped = {
    routine: 'Legs',
    movements: [{
      exerciseId: 'back-squat',
      now: { weightKg: 110, reps: 5, sets: 3 },
      before: { weightKg: 105, reps: 5, sets: 3 },
      planned: { sets: 5, reps: 5, weightKg: 100 },
    }],
  };
  assert.equal(comparison(ramped, CATALOG).rows[0].detail, '5×5 @ 100 → 3×5 @ 110');

  const heavier = {
    routine: 'Legs',
    movements: [{
      exerciseId: 'leg-press',
      now: { weightKg: 160, reps: 8, sets: 5 },
      planned: { sets: 3, reps: 12, weightKg: 140 },
    }],
  };
  assert.equal(comparison(heavier, CATALOG).rows[0].detail, '3×12 @ 140 → 5×8 @ 160');

  const short = {
    routine: 'Legs',
    movements: [{
      exerciseId: 'leg-press',
      now: { weightKg: 140, reps: 10, sets: 3 },
      planned: { sets: 3, reps: 12, weightKg: 140 },
    }],
  };
  assert.equal(comparison(short, CATALOG).rows[0].detail, 'planned 3×12 · did 3×10');
  assert.equal(
    comparison({ routine: 'Legs', movements: [{ exerciseId: 'chin-up', now: { weightKg: 0, reps: 6, sets: 3 }, planned: { sets: 3, reps: 8 } }] }, CATALOG).rows[0].detail,
    'planned 3×8 · did 3×6',
  );
});

test('comparison — a comparison whose earlier session names no routine still has a heading', () => {
  const nameless = { sessionId: 'ses_x', startedAt: 1, movements: [] };
  assert.equal(comparison(nameless, CATALOG).title, 'Against last time');
  assert.equal(comparison({ ...nameless, routine: '' }, CATALOG).title, 'Against last time');
  assert.equal(comparison({ ...nameless, routine: 'Legs' }, CATALOG).title, 'Against last Legs');
});

test('comparison — an absent comparison draws no section, and an id names its own movement', () => {
  assert.equal(comparison(undefined, CATALOG), null);
  assert.equal(comparison(null, CATALOG), null);
  const rows = comparison({ routine: 'Legs', movements: [{ exerciseId: 'zercher-squat', now: { weightKg: 80, reps: 5, sets: 3 } }] }, CATALOG).rows;
  assert.deepEqual(rows, [{ exerciseId: 'zercher-squat', movement: 'zercher-squat', detail: '3×5 @ 80' }]);
});
