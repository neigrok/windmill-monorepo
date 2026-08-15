// ROUTINES AS RULES, not as screens: what a routine composed from the session you just finished
// says, what a routine written out at the desk asks for, what a duplicate of one is, what dragging a
// row does to the numbering, and how a routine's own history reads. The capture-time rules — which
// routine is due, the mid-workout "heavier than the plan" question — live with the capture, in the
// phone rooms (§11); this module keeps only what the web's screens still ask.
//
// THREE DOORS REACH ONE ROUTINE and this module answers to all three: it falls out of a session you
// already did (`routineFromSession`), an agent proposes it (proposals.js, and the ledger rows below),
// or you build it deliberately at home (§M) — which is the door a lifter with a program in a notebook
// reaches for first, and the one every rule below about names, open lines and untested routines
// exists for.
//
// Everything here is pure, and what it hands back is one of two things: a WRITE document — the
// shape POST and PUT read, carrying its order in the order of its entries and no `position` on an
// entry, because the server renumbers densely from what it was sent (gymApi.js) — or the editor's
// DRAFT, which is that same routine under the lifter's hand before anything has been sent. An
// absent optional is OMITTED, never null, exactly as the wire does it.
//
// Two things this module deliberately never does. It never mints an id, and it never invents a
// name: both are the lifter's, and a routine exists because they named it — nothing is created
// behind their back. And it never reads a routine out of a plan snapshot: the snapshot is frozen at
// the session's start and the routine has kept moving, so an edit is always a read of the routine
// itself, changed and written whole.

import {
  groupByExercise, isUntested, NAME_MAX, nameOfMovement, proposalHref, shortDayLabel, weekdayName,
  workingSetsOf,
} from './log.js';
import { conversationOf, historyLabel, isPending, sourceLabel } from './proposals.js';

// WHAT TO CALL IT, ASKED FIRST AND ASKED ONCE (§M screen 28) — because a routine built on purpose
// deserves the word you already call it and not `Workout 3`. These three are SUGGESTIONS AND NEVER
// RULES: tapping one fills the field and typing over it is the expected case, which is why they are
// three fixed openers rather than a guess at this lifter's split. Nothing here reads the log, and
// nothing derives a name from a weekday: an opener that changed with the day would read as the app
// knowing something about the program, and it knows nothing.
export const NAME_SUGGESTIONS = ['Push C', 'Lower B', 'Thursday'];

// What one line may ask for — THE STORE'S OWN BOUNDS (domain/Routine.cpp: 1..20 sets, 1..100 reps),
// and not a tighter opinion of this screen's. Both counts are clamped rather than refused wherever
// they are composed — the editor's ± is a button a thumb holds down, and a session composed into a
// routine hands over whatever it happened to hold — because a target of zero sets is not a target at
// all. Every path that writes an entry passes through the same two pairs, so the store never sees a
// number this screen could have stopped: an EMOM of 25 chin-ups would otherwise compose a routine
// the domain refuses, and a 400 that no retry can fix reads to a lifter as the log being down.
// The bounds match the wire's exactly, because a tighter clamp here once rewrote a line an agent
// had written within the store's rule (`15 × 100`) to `12 × 99` the moment the sheet touched it.
export const ENTRY_SETS_MIN = 1;
export const ENTRY_SETS_MAX = 20;
export const ENTRY_REPS_MIN = 1;
export const ENTRY_REPS_MAX = 100;

// An ABSENT set target is not a clamped one either: it is the OPEN line (§M), a movement the
// routine names without saying what to do with it, and it passes through exactly as an absent rep
// target does.
function clampSets(sets) {
  if (sets == null) return null;
  return Math.min(ENTRY_SETS_MAX, Math.max(ENTRY_SETS_MIN, sets));
}

// An ABSENT rep target is not a clamped one: it is the wire's `3 × max`, a movement taken to
// whatever it gives that day, and it passes through untouched.
function clampReps(reps) {
  if (reps == null) return null;
  return Math.min(ENTRY_REPS_MAX, Math.max(ENTRY_REPS_MIN, reps));
}

// The reps a movement was actually done for: the most common count, and a tie goes to the set
// performed EARLIEST — the same asymmetry the prefill already keeps, where reps come from before
// fatigue cut them. 8, 8, 6, 6 is a day that started at 8.
function modalReps(performed) {
  const counted = new Map();
  for (const set of performed) counted.set(set.reps, (counted.get(set.reps) ?? 0) + 1);
  return performed.reduce((best, set) => (counted.get(set.reps) > counted.get(best.reps) ? set : best)).reps;
}

// An entry as a write carries no position, and a target it does not set is left out rather than sent
// as a zero: an omitted weight means "whatever you did last time", an omitted rest means the
// client's own default and an omitted rep target is canon screen 6's `3 × max`, all three of which
// a 0 would quietly turn into a real number. An absent optional is OMITTED and never null, exactly
// as the wire does it (gymApi.js).
//
// AND AN OPEN LINE CARRIES NOTHING BUT ITS REST. `targetSets` absent is the open row, and the store
// refuses a half-open one — reps or a weight with nothing to do them for is 400 `could not read that
// routine`, which no retry can repair — so the two other targets are dropped HERE as well as by the
// action that opened the row. This is the last gate before the wire, and a document it lets through
// wrong is a save a lifter cannot get past. Rest survives: how long you wait is not what you are
// asked to do.
function entryWrite(entry) {
  if (entry.targetSets == null) {
    return {
      exerciseId: entry.exerciseId,
      ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }),
    };
  }
  return {
    exerciseId: entry.exerciseId,
    targetSets: entry.targetSets,
    ...(entry.targetReps == null ? {} : { targetReps: entry.targetReps }),
    ...(entry.targetWeightKg == null ? {} : { targetWeightKg: entry.targetWeightKg }),
    ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }),
  };
}

// The routine as it goes back over the wire. `lastTrainedAt` is the store's to say and the entry
// positions are the store's to number, so neither travels back — sending a position beside an order
// that already carries the same fact is two answers to one question.
// `revision` travels back ONLY when the caller names the one it read: an editor saving the whole
// document over a day that moved since (a proposal applied on the phone, another tab's save) is
// refused 409 routine-stale rather than landing over it, and re-reads. A write that names none —
// the fresh create — lands as before.
export function routineWrite(routine, readRevision = null) {
  const write = {
    id: routine.id,
    name: routine.name,
    position: routine.position,
    entries: routine.entries.map(entryWrite),
  };
  if (readRevision != null) write.revision = readRevision;
  return write;
}

// "Keep this as a routine" (screen 3) — the first routine most lifters ever have, and a by-product
// of a session rather than a form they filled in. In the order performed, with the weights actually
// used as next week's targets: targetSets is how many working sets there were, targetWeightKg the
// heaviest load, targetReps the modal count. Rest is left out so the routine takes the client's own
// default rather than freezing however long this one session happened to rest between sets.
//
// A movement that got no working set is not in the routine at all: an entry asking for zero sets is
// not a target, and a warmup nobody followed up on is not a movement the lifter chose to do.
export function routineFromSession({ id, name, position = 0, sets }) {
  const performed = groupByExercise(workingSetsOf(sets));
  return {
    id,
    name,
    position,
    entries: performed.map(([exerciseId, done]) => ({
      exerciseId,
      targetSets: clampSets(done.length),
      targetReps: clampReps(modalReps(done)),
      targetWeightKg: done.reduce((top, set) => Math.max(top, set.weightKg), done[0].weightKg),
    })),
  };
}

// ⧉ on a routine row (screen 5) — Push B started as a copy of Push A. A copy is a new id over the
// same entries and it has never been trained: carrying `lastTrainedAt` across would put a day in
// its row that happened to another routine. The name is an opening value rather than a decision —
// the editor opens on it to be typed over — and it fits the server's ceiling by construction,
// because a duplicate must never bounce off a refusal we could see coming. When something has to
// give it is the ORIGINAL that gives: a copy whose suffix was cut off is a second routine wearing
// the first one's name, in a list where the name is the only way to tell them apart.
const COPY_SUFFIX = ' copy';

export function duplicateRoutine(routine, {
  id,
  name = `${routine.name.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`,
  position = routine.position,
}) {
  return { ...routineWrite(routine), id, name: name.slice(0, NAME_MAX), position };
}

// THE EDITOR IS A DRAFT (screen 6). Every change lands in this copy and nothing reaches the store
// until Save, so a routine is never left half-rewritten by a lifter who walked away mid-edit — and
// half a program is what somebody trains against tomorrow. The draft is a whole routine, so the
// same `routineWrite` sends it whichever way it was born.
//
// What the editor changes is what screen 6 draws: the order, the membership, the name and each
// line's target. A target is never INVENTED here, though — a movement joins with no target at all
// and the sheet is the only thing that gives it one, because "whatever you did last time" is a
// better answer than a number nobody has ever lifted; the two other ways a target gets set are the
// session that composed the routine and the mid-workout question the phone's logger asks (§11).
export function draftFrom(routine) {
  return { ...routine, entries: routine.entries.map((entry) => ({ ...entry })) };
}

export function blankRoutine({ id, position = 0 }) {
  return { id, name: '', position, entries: [] };
}

// THE OPENING VALUES OF THE TARGET SHEET, AND OF NOTHING ELSE. Three of five is the opening value of
// nearly every barbell program there is, so it is where the sheet opens a row that asks for nothing
// yet: a number on screen to be typed over, one tap from `max` and one tap from anything else — which
// is the reason a rep target is a value this editor can CLEAR rather than one it always holds.
export const NEW_ENTRY_SETS = 3;
export const NEW_ENTRY_REPS = 5;

// A MOVEMENT JOINS THE DAY OPEN (§M). The routine names the movement before it says what to do with
// it, which is the order screen 29 draws — the list of movements first, the numbers in a sheet over
// it, rows reading `open` until one comes back through `Set` — and the order the phones append in.
//
// Stamping three of five here wrote four targets nobody typed: they saved into the routine, froze
// into the plan the rack grades a set against, and left the row the board actually draws reachable
// only by opening a sheet and declining it. A target is the lifter's, and this is the path that has
// least right to invent one.
export function withEntryAdded(entries, exerciseId) {
  return [...entries, { exerciseId }];
}

export function withEntryRemoved(entries, index) {
  return entries.filter((entry, at) => at !== index);
}

// ONE LINE, UNDER THE HAND, BEFORE IT IS SET (§M screen 29). The target sheet holds this and the
// draft takes it only on `Set` — the same shape the correction sheet has (fix.js), and for the same
// reason: a sheet with a commit button on it has to mean the commit.
//
// AN OPEN ROW OPENS THE SHEET AT THE OPENING VALUES rather than at nothing — and every row a lifter
// adds at the desk is an open one, so this is where three of five is put on screen and the ONLY
// place it is: a number to be typed over, never a guess at a weight anybody lifted, and never a
// prefill, because a routine built at home has no history to prefill FROM, which is the whole of the
// rule this sheet says out loud. The row stays open until this comes back through `Set`.
export function targetDraftOf(entry) {
  if (entry.targetSets != null) return { ...entry };
  return { ...entry, targetSets: NEW_ENTRY_SETS, targetReps: NEW_ENTRY_REPS };
}

// `Never logged — these are your numbers.` (§M screen 29) — and it is drawn on BOTH conditions that
// make it true, not on the routine's alone. The routine must be untested, which is the store's
// `lastTrainedAt` being absent, AND the row must still be OPEN, which is the state the board draws
// the sentence in: `Deadlift open`, its sheet standing on it.
//
// A ROW THAT ALREADY CARRIES A TARGET GOT IT FROM SOMEWHERE. The first routine most lifters ever
// have is kept from a session they just did (screen 3), so it is untested on the day it is born and
// every number in it came out of the log — and `Never logged` over the weights their own training
// produced is the widest version of the lie this line exists to prevent. Narrowing it costs nothing
// the sentence was for: a row with no target has nothing behind it either way, which is exactly what
// it says.
export function saysNeverLogged(routine, entry) {
  return isUntested(routine) && entry.targetSets == null;
}

// Changing what one line asks for. No absence here is a clamped value — all three are deliberate:
// a weight of null is how the wire says "whatever you did last time", a rep target of null is how it
// says `3 × max`, a set target of null is the open row, so clearing any of them is the only way back
// and the clamp lets each pass.
//
// It is one entry's rule rather than the list's because the target sheet holds ONE line under the
// hand and commits it whole (Routines.jsx): the sheet steps through this and the commit below folds
// the result back into the run, so a number a stepper can reach and a number the list can hold are
// the same number by construction.
export function withTarget(entry, change) {
  const changed = { ...entry, ...change };
  return {
    ...changed,
    targetSets: clampSets(changed.targetSets),
    targetReps: clampReps(changed.targetReps),
  };
}

export function withEntryChanged(entries, index, change) {
  return entries.map((entry, at) => (at === index ? withTarget(entry, change) : entry));
}

// `Leave it open` · `decide at the rack` (§M screen 29). The row keeps its place in the day and
// stops asking for anything, which is what makes a routine SAVABLE WHILE INCOMPLETE — the whole
// reason a program can be typed in on Sunday with the numbers still to be found. All three targets
// go together: a line asking for five reps of nothing is a line no screen can draw and the store
// refuses outright. Rest stays, being how long you wait rather than what you are asked to do.
export function withEntryOpened(entries, index) {
  return entries.map((entry, at) => {
    if (at !== index) return entry;
    return { exerciseId: entry.exerciseId, ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }) };
  });
}

// WHICH LINES WILL ASK AT THE RACK, said as a fact about the day rather than as a warning about the
// document (§M screen 30: `Barbell Row has no target — it will ask at the rack.`). It is drawn from
// the entries themselves, so a row opened a second ago changes the sentence and a routine with every
// target set has no sentence at all.
export function openTargetsLine(entries, catalog) {
  const open = entries.filter((entry) => entry.targetSets == null);
  if (open.length === 0) return null;
  const names = open.map((entry) => nameOfMovement(catalog, entry.exerciseId));
  if (names.length === 1) return `${names[0]} has no target — it will ask at the rack.`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last} have no target — they will ask at the rack.`;
}

// Dragging a row (screen 6). The order IS the routine, so the numbering is rewritten from the new
// order every time rather than patched: renumbering is the only way a list dragged twice cannot end
// up with two rows claiming the same place. A drop below the last row arrives as an index one past
// the end — clamped, because a drag that lands nowhere still has to land somewhere.
export function reorderEntries(entries, from, to) {
  if (entries.length === 0) return [];
  const last = entries.length - 1;
  const moved = [...entries];
  const [entry] = moved.splice(Math.min(Math.max(from, 0), last), 1);
  moved.splice(Math.min(Math.max(to, 0), last), 0, entry);
  return moved.map((each, index) => ({ ...each, position: index + 1 }));
}

// WHERE YOU ARE IN THE DAY, on the sheet that is asking for one line's numbers (§M screen 29:
// `2 of 4 · Heavy Thursday`). The routine's name is part of it because the sheet stands over the
// list rather than beside it — and it is dropped rather than printed empty for a routine still
// being named, which is a state this editor genuinely has.
export function entryPlaceLabel(index, count, routineName) {
  const named = (routineName ?? '').trim();
  if (named === '') return `${index + 1} of ${count}`;
  return `${index + 1} of ${count} · ${named}`;
}

// WHEN THE DAY WAS WRITTEN, AND HOW BIG IT WAS THEN (§M screen 30: `built Sunday · 4 movements`).
// The count is the store's `movements` — how many lines the routine was CREATED with — and it is
// ABSENT for every routine written before that column existed. Today's entry count is NOT a
// substitute: a routine built with four and cut to three would claim it was born at three, which is
// the one thing this row is here to say it was not.
//
// The weekday alone repeats every seven days, so past six the date is what is left — `arrivedLabel`'s
// own cut, for its own reason: a lifter reading `built Sunday` about a fortnight ago supplies the
// wrong Sunday.
const WEEKDAY_MS = 6 * 86400000;

export function builtLabel(routine, now = Date.now()) {
  const created = (routine?.history ?? []).find((row) => row.kind === 'created');
  if (!created) return null;
  const when = now - created.at >= WEEKDAY_MS ? shortDayLabel(created.at) : weekdayName(created.at);
  if (created.movements == null) return `built ${when}`;
  const movements = created.movements === 1 ? '1 movement' : `${created.movements} movements`;
  return `built ${when} · ${movements}`;
}

// THE ROUTINE'S HISTORY, ONE LIST OF TWO KINDS (§M screen 30). It rides the routine's own read —
// newest first, the `created` row always last and always there — so the section is the same read the
// screen already made rather than a second one.
//
// A CREATED ROW WITH NO `by` IS THE LIFTER'S OWN HAND, and the absence is the whole claim: a routine
// an agent typed carries the door it came through, and `created by you` over one of those would be
// putting words in a lifter's mouth. A proposal row spells itself the way every other proposal on
// this surface does (proposals.js), because a row here and the card on Today are one object read
// twice.
export function historyRows(routine) {
  return (routine?.history ?? []).map((row, index) => {
    if (row.kind === 'created') {
      // Who wrote it is `sourceLabel`'s question wherever it is asked — the card, the diff, and now
      // this row — so a routine an agent typed is named here exactly as its proposals are.
      const what = row.by == null ? 'created by you' : `created by ${sourceLabel({ door: row.by })}`;
      const movements = row.movements == null ? null : `${row.movements} movements`;
      return {
        key: `created-${index}`,
        pending: false,
        href: null,
        line: [shortDayLabel(row.at), what, movements].filter((part) => part != null).join(' · '),
      };
    }
    // AND WHERE IT WAS ASKED FOR, when there is somewhere (§O). `source.thread` is the conversation
    // the diff was written in; ABSENT means there is nothing to open — the MCP door, or a thread the
    // lifter deleted, which is exactly the case §O's delete rule creates: the change stays in this
    // history and the conversation about it does not. The row still says the change came from Ask.
    return {
      key: row.proposal.id,
      pending: isPending(row.proposal),
      href: proposalHref(row.proposal.id),
      thread: conversationOf(row.proposal.source),
      line: historyLabel(row.proposal),
    };
  });
}

