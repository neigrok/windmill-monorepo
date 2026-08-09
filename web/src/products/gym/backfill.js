// ADDING A WORKOUT THAT ALREADY HAPPENED — the one place in gym where a set is written from memory
// instead of from the bar, and the rules that keep it honest about being one. It is a door on the
// log, never a Start: the web mirrors a workout, it does not run one.
//
// THE UNIT OF ENTRY IS THE LINE — weight × reps × how many. "3 × 8 @ 82.5" is one fact a lifter
// remembers, not three rows to fill in, and the form asks for it the way they would say it.
//
// DURATION BEATS END TIME. Nobody remembers 19:04 and everybody remembers "about an hour", so what
// is asked for is a start and a length, and the end is arithmetic.
//
// TIMESTAMPS STAY HONEST. A line becomes real sets whose instants are SYNTHESIZED, evenly, inside
// the session's span, and the save says so before it is tapped. The session detail must not
// reconstruct rest intervals from them — that column is earned by logging live.
//
// A draft is `{ startedAt, durationMs, blocks: [{ exerciseId, lines: [{ weightKg, reps, sets, kind
// }] }] }`. Movements are ids from the picker, never typed strings, for the same reason they are
// everywhere else: a name typed twice is two movements with no history between them. Every edit the
// form makes to that draft is one of the four functions below, so the form itself holds no rule —
// it holds the draft and the cursor, and asks here what a change means.

import {
  dayLabel, EMPTY_BAR_KG, EMPTY_BAR_REPS, fmt, isFinished, NO_ROUTINE, routineNameOf,
  setCountLabel, timeLabel,
} from './log.js';

const DAY_MS = 86400000;

// Yesterday evening is what a backfill almost always is, and the two other chips are far enough
// back to be worth a tap rather than a date picker.
export const DAY_CHIP_OFFSETS = [1, 2, 5];
export const DEFAULT_START_HOUR = 17;
export const DEFAULT_START_MINUTE = 30;

export const DURATION_CHIPS = [
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 90, label: '1 h 30' },
];

// Said at the door and again at save, in the same words both times. The check is client-side and
// the store's is the rule — a stale tab can reach this door mid-workout — so losing that race has
// to speak this sentence rather than a 409, because nothing failed: the workout is simply running.
//
// It names the phone now, because on this build that is where live training happens: the web's own
// Start is gone (§11), so the session this door defers to was opened somewhere else. It still
// promises nothing about a draft: at the log's door there is no draft yet.
export const MID_WORKOUT_REFUSAL = {
  title: 'A session is already running.',
  body: 'Live training happens on your phone — adding now would file these sets into the running session. The door opens when it closes.',
};

export const OVERLAP_TITLE = 'These times cross a session already in the log.';

export function dayChips(now = Date.now()) {
  return DAY_CHIP_OFFSETS.map((days) => ({
    days,
    label: days === 1 ? 'Yesterday' : dayLabel(now - days * DAY_MS),
  }));
}

export function startedAtOf({ days, hour = DEFAULT_START_HOUR, minute = DEFAULT_START_MINUTE, now = Date.now() }) {
  const day = new Date(now - days * DAY_MS);
  day.setHours(hour, minute, 0, 0);
  return day.getTime();
}

export function totalSets(blocks) {
  return blocks.reduce((total, block) => (
    total + block.lines.reduce((count, line) => count + line.sets, 0)
  ), 0);
}

export function saveLabel(blocks) {
  return `Add to the log · ${setCountLabel(totalSets(blocks))}`;
}

export function saveNote(startedAt) {
  return `Lands under ${dayLabel(startedAt)} · set times will read as approximate.`;
}

export function lineLabel(line) {
  return `${fmt(line.weightKg)} × ${line.reps}`;
}

// Three is what a remembered block usually is, and the empty bar is the opening value every form in
// this product dials from (log.js) — because a line typed from memory is typed over at once, and a
// default that guessed a weight would be the one number in the form nobody chose.
const OPENING_LINE = { weightKg: EMPTY_BAR_KG, reps: EMPTY_BAR_REPS, sets: 3, kind: 'working' };

export function withMovementAdded(blocks, exerciseId) {
  return [...blocks, { exerciseId, lines: [{ ...OPENING_LINE }] }];
}

// "Add a line" copies the last line of its block as a WORKING set: the line under a warmup is the
// work it was warming up for, and nobody remembers a second warmup they did not do.
export function withLineAdded(blocks, blockIndex) {
  return blocks.map((block, at) => (at !== blockIndex ? block : {
    ...block,
    lines: [...block.lines, { ...block.lines[block.lines.length - 1], kind: 'working' }],
  }));
}

// A set count is clamped rather than refused, because ± is a button a thumb holds down: one is the
// smallest thing that happened, and twelve sets of one movement in one visit is already the far end
// of what anybody remembers doing.
export const LINE_SETS_MIN = 1;
export const LINE_SETS_MAX = 12;

export function withLineChanged(blocks, blockIndex, lineIndex, change) {
  return blocks.map((block, at) => (at !== blockIndex ? block : {
    ...block,
    lines: block.lines.map((line, index) => {
      if (index !== lineIndex) return line;
      const changed = { ...line, ...change };
      return { ...changed, sets: Math.min(LINE_SETS_MAX, Math.max(LINE_SETS_MIN, changed.sets)) };
    }),
  }));
}

// Dropping a movement's last line drops the movement: a heading over no lines is a movement the
// session did not do, and it would go to the store as one.
export function withLineRemoved(blocks, blockIndex, lineIndex) {
  return blocks
    .map((block, at) => (at !== blockIndex ? block : {
      ...block,
      lines: block.lines.filter((line, index) => index !== lineIndex),
    }))
    .filter((block) => block.lines.length > 0);
}

// A line becomes its sets here, and the instants are the whole reason this function exists. They
// are spread evenly and STRICTLY INSIDE the span: nobody lifts at the second they walk in, and an
// end stamped at the last set is the fingerprint of a session the store closed by itself
// (log.js `closedOnItsOwn`) — a backfill must not wear it. Order is the order the form reads,
// blocks down the page, lines down a block, sets within a line.
export function expandLines({ startedAt, durationMs, blocks, mint }) {
  const flat = blocks.flatMap((block) => block.lines.flatMap((line) => (
    Array.from({ length: line.sets }, () => ({
      exerciseId: block.exerciseId,
      weightKg: line.weightKg,
      reps: line.reps,
      kind: line.kind,
    }))
  )));
  return flat.map((set, index) => ({
    id: mint('set_'),
    ...set,
    completedAt: startedAt + Math.round((durationMs * (index + 1)) / (flat.length + 1)),
  }));
}

// Times that cross a session already in the log usually mean that visit is already half-logged, so
// the answer is not "pick another time" but "that one is already here" — one visit is one session,
// and the missing sets belong in it rather than in a second copy of the same evening.
//
// A session still open is not compared against: its end is not a fact yet, and inventing one would
// refuse a backfill over hours nothing has happened in. The mid-workout refusal owns that case.
export function overlapWith({ startedAt, durationMs }, sessions) {
  const endsAt = startedAt + durationMs;
  const crossed = sessions.find((session) => isFinished(session)
    && startedAt < session.finishedAt && endsAt > session.startedAt);
  if (!crossed) return null;
  const span = `${timeLabel(crossed.startedAt)} – ${timeLabel(crossed.finishedAt)}`;
  return {
    session: crossed,
    title: OVERLAP_TITLE,
    // Named the way its row in the log names it, down to the word — this sentence is pointing at a
    // row the lifter is about to go and look at.
    body: `${routineNameOf(crossed) ?? NO_ROUTINE} · ${dayLabel(crossed.startedAt)} · ${span} `
      + 'is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  };
}

// EVERY SET OR NONE. The sets in this form were typed from memory and exist nowhere else, so a save
// that stops half way may not leave the log holding a session that says the lifter did less than
// they did AND leave the rest of it nowhere at all. What lands is rolled back — the session is
// closed first, because a discard refuses a session that is still running (gymApi.js) — and the
// form keeps the whole workout for one more tap.
//
// The close happens on every path, rollback or not: an open session is the one thing this form may
// never leave behind, because the next boot would mirror it as a workout in progress — and a phone
// pressing Start would JOIN it, adopting a past evening into today.
export async function fileBackfill({ api, id, sets, finishedAt }) {
  let landed = 0;
  // EVERY SET IS OFFERED, and one the store refuses does not stop the ones behind it. A set nobody
  // ever tried is a set no report can account for, and `landed` is the number the sentence says out
  // loud — a loop that broke on the first refusal made it a lower bound and called it a count.
  for (const set of sets) {
    const stored = await api.appendSet(id, set).then(() => true).catch(() => false);
    if (stored) landed += 1;
  }
  const closed = await api.finishSession(id, { finishedAt }).then(() => true).catch(() => false);
  if (landed === sets.length) return { total: sets.length, landed, closed, undone: false };
  // A rollback needs the close first: only a session the store agrees is over can be discarded
  // (gymApi.js). If even that did not land, what reached the log stays there and the sentence says
  // so rather than promising an undo that never happened.
  const undone = closed && (await api.discardSession(id).then(() => true).catch(() => false));
  return { total: sets.length, landed, closed, undone };
}

// What the save says, and whether the form KEEPS the draft it just tried to file. Anything short of
// the whole workout landing keeps it: navigating away from sets that are nowhere else is how a
// remembered session is destroyed for good.
export function saveReport({ total, landed, startedAt, closed, undone }) {
  if (landed < total && undone) {
    return {
      kept: true,
      text: `The log took ${landed} of ${setCountLabel(total)}, so nothing was added. `
        + 'Your workout is still here — try again when you have signal.',
    };
  }
  if (landed < total) {
    return {
      kept: true,
      text: `The log took ${landed} of ${setCountLabel(total)}, and that session couldn’t be undone. `
        + `It is under ${dayLabel(startedAt)} — your workout is still here.`,
    };
  }
  if (!closed) {
    return { kept: false, text: `Added to the log · ${dayLabel(startedAt)} · it closes on its own within four hours.` };
  }
  return { kept: false, text: `Added to the log · ${dayLabel(startedAt)} · ${setCountLabel(total)}` };
}
