import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AHEAD_TITLE, DURATION_CHIPS, endsAhead, expandLines, fileBackfill, lineLabel, LINE_SETS_MAX,
  LINE_SETS_MIN, MID_WORKOUT_REFUSAL, OVERLAP_TITLE, overlapWith, saveLabel, saveNote, saveReport,
  startedAtOf, totalSets, withLineAdded, withLineChanged, withLineRemoved, withMovementAdded,
  yesterdayOf,
} from '../../../src/products/gym/backfill.js';

const BLOCKS = [
  {
    exerciseId: 'back-squat',
    lines: [
      { weightKg: 60, reps: 5, sets: 2, kind: 'warmup' },
      { weightKg: 80, reps: 5, sets: 3, kind: 'working' },
    ],
  },
  {
    exerciseId: 'chin-up',
    lines: [{ weightKg: 0, reps: 8, sets: 3, kind: 'working' }],
  },
];

test('the day a backfill opens on, the duration chips, and the instant a day and a time mean', () => {
  const now = new Date(2026, 7, 4, 9, 41).getTime();
  assert.equal(yesterdayOf(now), '2026-08-03');
  assert.equal(yesterdayOf(new Date(2026, 0, 1, 0, 10).getTime()), '2025-12-31', 'a year boundary is a day step');
  assert.deepEqual(DURATION_CHIPS, [
    { minutes: 45, label: '45 min' },
    { minutes: 60, label: '1 h' },
    { minutes: 90, label: '1 h 30' },
  ]);
  assert.equal(startedAtOf({ date: '2026-08-03' }), new Date(2026, 7, 3, 17, 30).getTime());
  assert.equal(startedAtOf({ date: '2026-07-30', hour: 7, minute: 15 }), new Date(2026, 6, 30, 7, 15).getTime());
  assert.equal(startedAtOf({ date: '2026-02-30', hour: 7, minute: 15 }), null, 'not a real day');
  assert.equal(startedAtOf({ date: '', hour: 7, minute: 15 }), null);
});

test('the total, the button that carries it, and the note under it', () => {
  assert.equal(totalSets(BLOCKS), 8);
  assert.equal(totalSets([]), 0);
  assert.equal(saveLabel(BLOCKS), 'Add to the log · 8 sets');
  assert.equal(saveLabel([{ exerciseId: 'chin-up', lines: [{ weightKg: 0, reps: 8, sets: 1, kind: 'working' }] }]), 'Add to the log · 1 set');
  assert.equal(
    saveNote(new Date(2026, 7, 3, 17, 30).getTime()),
    'Lands under Mon 3 Aug · set times will read as approximate.',
  );
  assert.equal(lineLabel({ weightKg: 82.5, reps: 8 }), '82.5 × 8');
  assert.equal(lineLabel({ weightKg: -20, reps: 8 }), '−20 × 8');
});

test('expandLines — a line becomes its sets, in the order the form reads them', () => {
  const startedAt = new Date(2026, 7, 3, 17, 30).getTime();
  let minted = 0;
  const sets = expandLines({
    startedAt,
    durationMs: 60 * 60_000,
    blocks: BLOCKS,
    mint: (prefix) => `${prefix}${minted += 1}`,
  });
  assert.equal(sets.length, 8);
  assert.deepEqual(sets.map((set) => [set.id, set.exerciseId, set.weightKg, set.reps, set.kind]), [
    ['set_1', 'back-squat', 60, 5, 'warmup'],
    ['set_2', 'back-squat', 60, 5, 'warmup'],
    ['set_3', 'back-squat', 80, 5, 'working'],
    ['set_4', 'back-squat', 80, 5, 'working'],
    ['set_5', 'back-squat', 80, 5, 'working'],
    ['set_6', 'chin-up', 0, 8, 'working'],
    ['set_7', 'chin-up', 0, 8, 'working'],
    ['set_8', 'chin-up', 0, 8, 'working'],
  ]);
});

test('expandLines — the instants are evenly spread, in order, and inside the span at both ends', () => {
  const startedAt = 1_900_000_000_000;
  const durationMs = 60 * 60_000;
  const sets = expandLines({ startedAt, durationMs, blocks: BLOCKS, mint: () => 'set_x' });
  const at = sets.map((set) => set.completedAt);
  assert.deepEqual(at, [
    startedAt + 400_000,
    startedAt + 800_000,
    startedAt + 1_200_000,
    startedAt + 1_600_000,
    startedAt + 2_000_000,
    startedAt + 2_400_000,
    startedAt + 2_800_000,
    startedAt + 3_200_000,
  ]);
  assert.equal(at[0] > startedAt, true);
  assert.equal(at[at.length - 1] < startedAt + durationMs, true);
  assert.deepEqual(at, [...at].sort((left, right) => left - right));
  assert.deepEqual(at.map((each) => Number.isInteger(each)), at.map(() => true));

  const one = expandLines({
    startedAt,
    durationMs,
    blocks: [{ exerciseId: 'chin-up', lines: [{ weightKg: 0, reps: 8, sets: 1, kind: 'working' }] }],
    mint: () => 'set_x',
  });
  assert.deepEqual(one.map((set) => set.completedAt), [startedAt + durationMs / 2]);
  assert.deepEqual(expandLines({ startedAt, durationMs, blocks: [], mint: () => 'set_x' }), []);
});

test('overlapWith — a crossed session is named, in the sentence that routes to it', () => {
  const day = new Date(2026, 7, 3, 18, 12).getTime();
  const log = [
    { id: 'ses_1', startedAt: day, finishedAt: day + 62 * 60_000, plan: { routine: 'Legs', entries: [] } },
    { id: 'ses_2', startedAt: day - 3 * 86_400_000, finishedAt: day - 3 * 86_400_000 + 3_600_000 },
  ];
  const crossed = overlapWith({ startedAt: day + 30 * 60_000, durationMs: 60 * 60_000 }, log);
  assert.deepEqual(crossed, {
    session: log[0],
    title: OVERLAP_TITLE,
    body: 'Legs · Mon 3 Aug · 18:12 – 19:14 is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  });
  assert.equal(OVERLAP_TITLE, 'These times cross a session already in the log.');
  assert.equal(overlapWith({ startedAt: day - 3 * 86_400_000, durationMs: 45 * 60_000 }, log).session.id, 'ses_2');
  assert.equal(
    overlapWith({ startedAt: day - 3 * 86_400_000, durationMs: 45 * 60_000 }, log).body.startsWith('Free session · '),
    true,
  );
});

test('overlapWith — the edges touch without crossing, and an open session is not compared against', () => {
  const day = new Date(2026, 7, 3, 18, 12).getTime();
  const finished = { id: 'ses_1', startedAt: day, finishedAt: day + 62 * 60_000 };
  const log = [finished];
  assert.equal(overlapWith({ startedAt: day + 62 * 60_000, durationMs: 45 * 60_000 }, log), null);
  assert.equal(overlapWith({ startedAt: day - 45 * 60_000, durationMs: 45 * 60_000 }, log), null);
  assert.equal(overlapWith({ startedAt: day + 60 * 60_000, durationMs: 45 * 60_000 }, log).session.id, 'ses_1');
  assert.equal(overlapWith({ startedAt: day, durationMs: 60 * 60_000 }, []), null);
  assert.equal(overlapWith({ startedAt: day, durationMs: 60 * 60_000 }, [{ id: 'ses_live', startedAt: day, finishedAt: null }]), null);
  assert.deepEqual(MID_WORKOUT_REFUSAL, {
    title: 'A session is already running.',
    body: 'Live training happens on your phone — one workout is open at a time, and this one waits for it. The door opens when it closes.',
  });
  assert.equal(/phone/.test(MID_WORKOUT_REFUSAL.body), true);
  assert.equal(/draft/i.test(MID_WORKOUT_REFUSAL.title + MID_WORKOUT_REFUSAL.body), false);
  assert.equal(/file/i.test(MID_WORKOUT_REFUSAL.body), false);
});

test('endsAhead — a session whose end runs past now is refused, and one ending exactly now is not', () => {
  const now = new Date(2026, 7, 16, 0, 10).getTime();
  const startedAt = new Date(2026, 7, 15, 23, 30).getTime();
  assert.deepEqual(endsAhead({ startedAt, durationMs: 90 * 60_000 }, now), {
    title: AHEAD_TITLE,
    body: 'Sat 15 Aug · 23:30 for 1h 30m ends after now. Shorten it, or start it earlier.',
  });
  assert.equal(AHEAD_TITLE, 'These times run past now.');
  assert.equal(endsAhead({ startedAt, durationMs: 40 * 60_000 }, now), null);
  assert.equal(endsAhead({ startedAt, durationMs: 30 * 60_000 }, now), null);
  assert.equal(endsAhead({ startedAt, durationMs: 41 * 60_000 }, now).title, AHEAD_TITLE);
});

test('withMovementAdded — a movement joins on the empty bar, the opening value everything dials from', () => {
  assert.deepEqual(withMovementAdded([], 'back-squat'), [
    { exerciseId: 'back-squat', lines: [{ weightKg: 20, reps: 5, sets: 3, kind: 'working' }] },
  ]);
  const two = withMovementAdded(BLOCKS, 'face-pull');
  assert.deepEqual(two.map((block) => block.exerciseId), ['back-squat', 'chin-up', 'face-pull']);
  assert.equal(BLOCKS.length, 2);
  const pair = withMovementAdded(withMovementAdded([], 'a'), 'b');
  assert.notEqual(pair[0].lines[0], pair[1].lines[0]);
});

test('withLineAdded — a line copies the last one of its block, as a working set', () => {
  const added = withLineAdded(BLOCKS, 0);
  assert.deepEqual(added[0].lines, [
    { weightKg: 60, reps: 5, sets: 2, kind: 'warmup' },
    { weightKg: 80, reps: 5, sets: 3, kind: 'working' },
    { weightKg: 80, reps: 5, sets: 3, kind: 'working' },
  ]);
  assert.equal(added[1], BLOCKS[1]);
  assert.equal(BLOCKS[0].lines.length, 2);

  const fromWarmup = withLineAdded([{ exerciseId: 'back-squat', lines: [{ weightKg: 60, reps: 5, sets: 2, kind: 'warmup' }] }], 0);
  assert.deepEqual(fromWarmup[0].lines[1], { weightKg: 60, reps: 5, sets: 2, kind: 'working' });
});

test('withLineChanged — one line changes, and a set count stays inside what a visit holds', () => {
  assert.equal(LINE_SETS_MIN, 1);
  assert.equal(LINE_SETS_MAX, 12);
  const warmed = withLineChanged(BLOCKS, 1, 0, { kind: 'warmup' });
  assert.deepEqual(warmed[1].lines, [{ weightKg: 0, reps: 8, sets: 3, kind: 'warmup' }]);
  assert.equal(warmed[0], BLOCKS[0]);
  assert.equal(BLOCKS[1].lines[0].kind, 'working');

  assert.equal(withLineChanged(BLOCKS, 0, 1, { sets: 4 })[0].lines[1].sets, 4);
  assert.equal(withLineChanged(BLOCKS, 0, 1, { sets: 0 })[0].lines[1].sets, 1);
  assert.equal(withLineChanged(BLOCKS, 0, 1, { sets: -3 })[0].lines[1].sets, 1);
  assert.equal(withLineChanged(BLOCKS, 0, 1, { sets: 40 })[0].lines[1].sets, 12);
  assert.equal(withLineChanged(BLOCKS, 0, 1, { weightKg: 102.5 })[0].lines[1].weightKg, 102.5);
  assert.equal(withLineChanged(BLOCKS, 0, 1, { reps: 3 })[0].lines[1].reps, 3);
});

test('withLineRemoved — dropping a movement’s last line drops the movement', () => {
  assert.deepEqual(withLineRemoved(BLOCKS, 0, 0)[0].lines, [{ weightKg: 80, reps: 5, sets: 3, kind: 'working' }]);
  assert.deepEqual(
    withLineRemoved(BLOCKS, 1, 0).map((block) => block.exerciseId),
    ['back-squat'],
  );
  assert.deepEqual(withLineRemoved([BLOCKS[1]], 0, 0), []);
  assert.equal(BLOCKS[1].lines.length, 1);
});

function fakeStore({ failFrom = Infinity, closes = true, discards = true } = {}) {
  const store = { sets: [], finished: false, discarded: false, attempts: 0 };
  return {
    store,
    api: {
      async appendSet(id, set) {
        store.attempts += 1;
        if (store.attempts >= failFrom) throw new Error('the log did not answer');
        store.sets.push(set);
        return set;
      },
      async finishSession() {
        if (!closes) throw new Error('the log did not answer');
        store.finished = true;
        return { id: 'ses_1' };
      },
      async discardSession() {
        if (!discards) throw new Error('the log did not answer');
        store.discarded = true;
        return null;
      },
    },
  };
}

const SIX = Array.from({ length: 6 }, (each, index) => ({ id: `set_${index}`, exerciseId: 'back-squat', weightKg: 100, reps: 5, kind: 'working', completedAt: index }));

test('fileBackfill — the whole workout lands, and the session is closed behind it', async () => {
  const { api, store } = fakeStore();
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 6, closed: true, undone: false,
  });
  assert.equal(store.sets.length, 6);
  assert.equal(store.finished, true);
  assert.equal(store.discarded, false);
});

test('fileBackfill — a refusal in the middle is rolled back whole, and every set was offered', async () => {
  const { api, store } = fakeStore({ failFrom: 4 });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 3, closed: true, undone: true,
  });
  assert.equal(store.attempts, 6);
  assert.equal(store.discarded, true);
});

test('fileBackfill — a save that landed nothing leaves no session behind', async () => {
  const { api, store } = fakeStore({ failFrom: 1 });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 0, closed: true, undone: true,
  });
  assert.equal(store.discarded, true);
});

test('fileBackfill — a close that did not land leaves the rollback impossible, and says so', async () => {
  const { api, store } = fakeStore({ failFrom: 4, closes: false });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 3, closed: false, undone: false,
  });
  assert.equal(store.discarded, false);
});

test('fileBackfill — a rollback the store refused is reported as one, never as an undo', async () => {
  const { api } = fakeStore({ failFrom: 4, discards: false });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 3, closed: true, undone: false,
  });
});

test('saveReport — four outcomes, and only the whole workout landing lets the screen go', () => {
  const startedAt = new Date(2026, 7, 3, 17, 30).getTime();
  assert.deepEqual(saveReport({ total: 6, landed: 6, startedAt, closed: true, undone: false }), {
    kept: false, text: 'Added to the log · Mon 3 Aug · 6 sets',
  });
  assert.deepEqual(saveReport({ total: 6, landed: 6, startedAt, closed: false, undone: false }), {
    kept: false, text: 'Added to the log · Mon 3 Aug · it closes on its own within four hours.',
  });
  assert.deepEqual(saveReport({ total: 6, landed: 3, startedAt, closed: true, undone: true }), {
    kept: true,
    text: 'The log took 3 of 6 sets, so nothing was added. Your workout is still here — try again when you have signal.',
  });
  assert.deepEqual(saveReport({ total: 6, landed: 3, startedAt, closed: true, undone: false }), {
    kept: true,
    text: 'The log took 3 of 6 sets, and that session couldn’t be undone. It is under Mon 3 Aug — your workout is still here.',
  });
});
