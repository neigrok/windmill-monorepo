// The past-workout form's rules, pinned. Two of them are the whole reason this form is trusted at
// all: a line becomes as many sets as it says, with instants that are synthesized and admit it, and
// times that cross a session already in the log are refused before they can file a second copy of
// one evening. The rest is arithmetic the form must not do twice.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AHEAD_TITLE, dayChips, DURATION_CHIPS, endsAhead, expandLines, fileBackfill, lineLabel,
  LINE_SETS_MAX, LINE_SETS_MIN, MID_WORKOUT_REFUSAL, OVERLAP_TITLE, overlapWith, saveLabel, saveNote,
  saveReport, startedAtOf, totalSets, withLineAdded, withLineChanged, withLineRemoved,
  withMovementAdded,
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

// Nobody remembers 19:04 and everybody remembers "about an hour", so the form takes a day, a time
// and a length — and yesterday evening is what a backfill almost always is.
test('the chips a backfill is dialled with, and the instant a day chip means', () => {
  const now = new Date(2026, 7, 4, 9, 41).getTime();
  assert.deepEqual(dayChips(now), [
    { days: 1, label: 'Yesterday' },
    { days: 2, label: 'Sun 2 Aug' },
    { days: 5, label: 'Thu 30 Jul' },
  ]);
  assert.deepEqual(DURATION_CHIPS, [
    { minutes: 45, label: '45 min' },
    { minutes: 60, label: '1 h' },
    { minutes: 90, label: '1 h 30' },
  ]);
  assert.equal(startedAtOf({ days: 1, now }), new Date(2026, 7, 3, 17, 30).getTime());
  assert.equal(startedAtOf({ days: 5, hour: 7, minute: 15, now }), new Date(2026, 6, 30, 7, 15).getTime());
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

// THE UNIT OF ENTRY IS THE LINE. "3 × 8 @ 82.5" is one fact a lifter remembers, and it becomes
// three sets here — in the order the form reads, blocks down the page and lines down a block.
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

// The instants are synthesized, and they are spread STRICTLY INSIDE the span: nobody lifts at the
// second they walk in, and an end stamped at the last set is the fingerprint of a session the store
// closed by itself — a backfill must not wear it.
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

// Overlapping times usually mean that visit is already half-logged, so the answer is not "pick
// another time" but "that one is already here" — one visit is one session.
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
    overlapWith({ startedAt: day - 3 * 86_400_000, durationMs: 45 * 60_000 }, log).body.startsWith('Session · no routine · '),
    true,
  );
});

// Touching ends do not cross: a session that finished at 19:14 and one that starts at 19:14 are two
// visits, and refusing the second would refuse a double day nobody logged twice.
test('overlapWith — the edges touch without crossing, and an open session is not compared against', () => {
  const day = new Date(2026, 7, 3, 18, 12).getTime();
  const finished = { id: 'ses_1', startedAt: day, finishedAt: day + 62 * 60_000 };
  const log = [finished];
  assert.equal(overlapWith({ startedAt: day + 62 * 60_000, durationMs: 45 * 60_000 }, log), null);
  assert.equal(overlapWith({ startedAt: day - 45 * 60_000, durationMs: 45 * 60_000 }, log), null);
  assert.equal(overlapWith({ startedAt: day + 60 * 60_000, durationMs: 45 * 60_000 }, log).session.id, 'ses_1');
  assert.equal(overlapWith({ startedAt: day, durationMs: 60 * 60_000 }, []), null);
  // A live session's end is not a fact yet. Inventing one would refuse a backfill over hours
  // nothing has happened in — and the mid-workout refusal already owns that case, in its own words.
  assert.equal(overlapWith({ startedAt: day, durationMs: 60 * 60_000 }, [{ id: 'ses_live', startedAt: day, finishedAt: null }]), null);
  // It names the phone, because on this build that is where live training happens — the web's own
  // Start is gone (§11), so the sentence G8 wrote is finally true. It still promises nothing about
  // a draft: at the log's door there is no draft to keep. And it never says the sets would be FILED
  // into the running workout: the save sends `joinOpenSession: false`, so the store refuses rather
  // than files, and a sentence claiming otherwise was misinformation.
  assert.deepEqual(MID_WORKOUT_REFUSAL, {
    title: 'A session is already running.',
    body: 'Live training happens on your phone — one workout is open at a time, and this one waits for it. The door opens when it closes.',
  });
  assert.equal(/phone/.test(MID_WORKOUT_REFUSAL.body), true);
  assert.equal(/draft/i.test(MID_WORKOUT_REFUSAL.title + MID_WORKOUT_REFUSAL.body), false);
  assert.equal(/file/i.test(MID_WORKOUT_REFUSAL.body), false);
});

// A PAST WORKOUT ENDS IN THE PAST. Start and length are typed apart, and "yesterday 23:30 for
// 1 h 30" saved at ten past midnight ends forty minutes from now — a start the clock allows with an
// end it does not, and nothing on the wire refuses that end.
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

// Every edit the form makes to its draft is one of these four, so the form holds the draft and the
// cursor and no rule at all.
test('withMovementAdded — a movement joins on the empty bar, the opening value everything dials from', () => {
  assert.deepEqual(withMovementAdded([], 'back-squat'), [
    { exerciseId: 'back-squat', lines: [{ weightKg: 20, reps: 5, sets: 3, kind: 'working' }] },
  ]);
  const two = withMovementAdded(BLOCKS, 'face-pull');
  assert.deepEqual(two.map((block) => block.exerciseId), ['back-squat', 'chin-up', 'face-pull']);
  assert.equal(BLOCKS.length, 2);
  // The opening line is a fresh object per movement — two movements added must not share one line.
  const pair = withMovementAdded(withMovementAdded([], 'a'), 'b');
  assert.notEqual(pair[0].lines[0], pair[1].lines[0]);
});

// The line under a warmup is the work it was warming up for, so a copy is always working.
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

// ± is a button a thumb holds down, so the count is clamped rather than refused at either end.
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

// A heading over no lines is a movement the session did not do, and it would be saved as one.
test('withLineRemoved — dropping a movement’s last line drops the movement', () => {
  assert.deepEqual(withLineRemoved(BLOCKS, 0, 0)[0].lines, [{ weightKg: 80, reps: 5, sets: 3, kind: 'working' }]);
  assert.deepEqual(
    withLineRemoved(BLOCKS, 1, 0).map((block) => block.exerciseId),
    ['back-squat'],
  );
  assert.deepEqual(withLineRemoved([BLOCKS[1]], 0, 0), []);
  assert.equal(BLOCKS[1].lines.length, 1);
});

// EVERY SET OR NONE, and the draft never leaves the screen until the whole of it is in the log.
// These sets were typed from memory and exist nowhere else: a save that stopped at the first
// refusal, closed the session anyway and navigated to the log left a session saying the lifter did
// less than they did, and the rest of the workout nowhere at all.
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

// A set that is refused does not stop the ones behind it: `landed` is a count the sentence says out
// loud, and a loop that broke on the first refusal made it a lower bound.
test('fileBackfill — a refusal in the middle is rolled back whole, and every set was offered', async () => {
  const { api, store } = fakeStore({ failFrom: 4 });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 3, closed: true, undone: true,
  });
  assert.equal(store.attempts, 6);
  assert.equal(store.discarded, true);
});

// The first set failing used to leave an empty backdated session in the log for good — the web
// offers discard nowhere but the finish screen, so nothing could ever remove it.
test('fileBackfill — a save that landed nothing leaves no session behind', async () => {
  const { api, store } = fakeStore({ failFrom: 1 });
  assert.deepEqual(await fileBackfill({ api, id: 'ses_1', sets: SIX, finishedAt: 99 }), {
    total: 6, landed: 0, closed: true, undone: true,
  });
  assert.equal(store.discarded, true);
});

// A discard needs the close: only a session the store agrees is over can be deleted. When the close
// itself does not land there is nothing to roll back with, and the report says so instead of
// promising an undo that never happened.
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

// Anything short of the whole workout landing KEEPS the draft: the sets are nowhere else, so
// navigating away is what destroys them.
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
