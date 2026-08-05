// ROUTINES AS RULES, not as screens: what a routine composed from the session you just finished
// says, what a duplicate of one is, what dragging a row does to the numbering, and the one question
// the logger is allowed to ask mid-workout when the bar disagrees with the plan.
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

import { fmt, groupByExercise, workingSetsOf } from './log.js';

// The server's own ceiling on a name, so a field can stop at it instead of discovering it in a 400.
export const NAME_MAX = 80;

// What one line may ask for. Both counts are clamped rather than refused wherever they are composed
// — the editor's ± is a button a thumb holds down, and a session composed into a routine hands over
// whatever it happened to hold — because a target of zero sets is not a target at all and the far
// ends are what one movement in one visit can plausibly be asked for. Every path that writes an
// entry passes through the same two pairs, so the store never sees a number this screen could have
// stopped: an EMOM of 25 chin-ups would otherwise compose a routine the domain refuses, and a 400
// that no retry can fix reads to a lifter as the log being down.
export const ENTRY_SETS_MIN = 1;
export const ENTRY_SETS_MAX = 12;
export const ENTRY_REPS_MIN = 1;
export const ENTRY_REPS_MAX = 99;

function clampSets(sets) {
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
function entryWrite(entry) {
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
export function routineWrite(routine) {
  return {
    id: routine.id,
    name: routine.name,
    position: routine.position,
    entries: routine.entries.map(entryWrite),
  };
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

// Which routine Today opens on. A rotation's next turn is the one that has waited longest, and the
// wire carries exactly one fact to decide it with: when each was last trained. A routine never
// trained has waited longer than any routine ever has, so it is the one on the card — it is almost
// always the one just written down, and the card says `never trained` under it rather than implying
// a schedule. Nothing here decides a routine is due on a DATE: gym keeps no calendar, and a card
// that said "due today" would be inventing one.
export function dueRoutine(routines) {
  if (routines.length === 0) return null;
  return routines.reduce((due, routine) => (
    (routine.lastTrainedAt ?? -Infinity) < (due.lastTrainedAt ?? -Infinity) ? routine : due
  ));
}

// THE EDITOR IS A DRAFT (screen 6). Every change lands in this copy and nothing reaches the store
// until Done, so a routine is never left half-rewritten by a lifter who walked away mid-edit — and
// half a program is what somebody trains against tomorrow. The draft is a whole routine, so the
// same `routineWrite` sends it whichever way it was born.
//
// What the editor changes is what screen 6 draws: the order, the membership, the name and each
// line's target. A target is never INVENTED here, though — a movement joins with no load at all,
// because "whatever you did last time" is a better answer than a number nobody has ever lifted, and
// the two other ways a load gets set are the session that composed the routine and the one question
// the logger asks mid-workout.
export function draftFrom(routine) {
  return { ...routine, entries: routine.entries.map((entry) => ({ ...entry })) };
}

export function blankRoutine({ id, position = 0 }) {
  return { id, name: '', position, entries: [] };
}

// A movement added in the editor opens on three sets of five and no load. Three of five is the
// opening value of nearly every barbell program there is, it is on screen, and one tap moves it —
// including one tap onto `max`, which is where a chin-up line ends up and is the reason a rep target
// is a value the editor can CLEAR rather than one it always holds. The weight is left out from the
// start, because "whatever you did last time" is the one target that is right before the lifter has
// told us anything.
export const NEW_ENTRY_SETS = 3;
export const NEW_ENTRY_REPS = 5;

export function withEntryAdded(entries, exerciseId) {
  return [...entries, { exerciseId, targetSets: NEW_ENTRY_SETS, targetReps: NEW_ENTRY_REPS }];
}

export function withEntryRemoved(entries, index) {
  return entries.filter((entry, at) => at !== index);
}

// Changing what one line asks for. Neither absence here is a clamped value — both are deliberate:
// a weight of null is how the wire says "whatever you did last time", and a rep target of null is
// how it says `3 × max`, so clearing either is the only way back to it and the clamp lets it pass.
export function withEntryChanged(entries, index, change) {
  return entries.map((entry, at) => {
    if (at !== index) return entry;
    const changed = { ...entry, ...change };
    return {
      ...changed,
      targetSets: clampSets(changed.targetSets),
      targetReps: clampReps(changed.targetReps),
    };
  });
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

// The modify half of the read-modify-write behind screen 8's "Save 87.5 to Push A", and it addresses
// ONE LINE by its position. A routine naming a lift twice — the heavy line and the back-off line —
// is the case `(routine_id, position)` exists to make representable, and a write-back matched on the
// movement would put the heavy day's load on the back-off line as well and delete a target the
// lifter never touched.
//
// The position is the one the plan snapshot froze, so a routine that has since moved that line
// somewhere else comes back untouched rather than half-right: the entry has to still name the same
// movement. Untouched is also the answer when the movement is gone — the lifter deleted it on
// purpose and re-adding it here would resurrect it.
export function withEntryWeight(routine, { position, exerciseId }, weightKg) {
  const write = routineWrite(routine);
  const at = position - 1;
  if (write.entries[at]?.exerciseId !== exerciseId) return write;
  return {
    ...write,
    entries: write.entries.map((entry, index) => (
      index === at ? { ...entry, targetWeightKg: weightKg } : entry
    )),
  };
}

// THE ONE QUESTION THE LOGGER ASKS (screen 8). The plan snapshot is frozen — last Tuesday keeps
// reading correctly whichever way this goes — so a heavier day is a fact about today until the
// lifter says it is a fact about the program. Only heavier: a lighter day is usually a bad day, and
// a program that ratcheted down every time somebody was tired is not one anybody wrote.
//
// Asked at the exercise BOUNDARY and never again that session, which is why `asked` comes in from
// outside: the memory belongs to the session, not to this rule. The load compared is the heaviest
// working set, because that is what "ran at 87.5" means — the top set is what a movement was, here
// as everywhere else in gym.
export function deviationAsk({ routine = null, planEntry = null, movement = '', sets = [], asked = [] }) {
  if (!routine || !planEntry || planEntry.weightKg == null) return null;
  if (asked.includes(planEntry.exerciseId)) return null;
  const working = workingSetsOf(sets, planEntry.exerciseId);
  if (working.length === 0) return null;
  const heaviest = working.reduce((top, set) => Math.max(top, set.weightKg), working[0].weightKg);
  if (heaviest <= planEntry.weightKg) return null;
  return {
    exerciseId: planEntry.exerciseId,
    // Which LINE of the routine this is about, carried from the snapshot so the write-back can
    // address it — a routine that names the movement twice has two of them (withEntryWeight).
    position: planEntry.position,
    weightKg: heaviest,
    title: 'Heavier than the plan',
    body: `Today’s ${movement} ran at ${fmt(heaviest)} against a planned ${fmt(planEntry.weightKg)}. `
      + `Today’s session already has it. ${routine} does not.`,
    save: `Save ${fmt(heaviest)} to ${routine}`,
    keep: 'Today only',
  };
}
