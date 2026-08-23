// Routines as pure rules. Everything here hands back either a WRITE document — the shape POST and PUT
// read, its order carried by the order of its entries and no `position` on an entry, the server
// renumbering densely from what it was sent — or the editor's DRAFT of that same routine. An absent
// optional is omitted, never null. Nothing here mints an id, invents a name, or reads a routine out
// of a plan snapshot: an edit is always a read of the routine itself, changed and written whole.

import {
  groupByExercise, isUntested, NAME_MAX, nameOfMovement, proposalHref, shortDayLabel, weekdayName,
  workingSetsOf,
} from './log.js';
import { conversationOf, historyLabel, isPending, sourceLabel } from './proposals.js';

// Suggestions, never rules: tapping one fills the field. Nothing here reads the log.
export const NAME_SUGGESTIONS = ['Push C', 'Lower B', 'Thursday'];

// The store's own bounds, matched exactly. Both counts are clamped rather than refused, so the store
// never sees a number this screen could have stopped.
export const ENTRY_SETS_MIN = 1;
export const ENTRY_SETS_MAX = 20;
export const ENTRY_REPS_MIN = 1;
export const ENTRY_REPS_MAX = 100;

// An absent set target is the OPEN line, not a clamped one, and passes through.
function clampSets(sets) {
  if (sets == null) return null;
  return Math.min(ENTRY_SETS_MAX, Math.max(ENTRY_SETS_MIN, sets));
}

// An absent rep target is the wire's `max`, not a clamped one, and passes through.
function clampReps(reps) {
  if (reps == null) return null;
  return Math.min(ENTRY_REPS_MAX, Math.max(ENTRY_REPS_MIN, reps));
}

// The most common rep count, a tie going to the set performed earliest.
function modalReps(performed) {
  const counted = new Map();
  for (const set of performed) counted.set(set.reps, (counted.get(set.reps) ?? 0) + 1);
  return performed.reduce((best, set) => (counted.get(set.reps) > counted.get(best.reps) ? set : best)).reps;
}

// An entry as a write carries no position, and an unset target is omitted rather than sent as a zero.
// An open line carries nothing but its rest: the store refuses a half-open one 400.
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

// `lastTrainedAt` and the entry positions are the store's, so neither travels back. `revision` goes
// only when the caller names the one it read; a save over a routine that moved since is then refused
// 409 routine-stale. A write naming none lands unconditionally.
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

// In the order performed: targetSets is how many working sets there were, targetWeightKg the heaviest
// load, targetReps the modal count. Rest is omitted. A movement with no working set is not in it.
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

// A copy is a new id over the same entries, never trained, so `lastTrainedAt` is not carried across.
// The name fits the server's ceiling by construction, the original giving way before the suffix does.
const COPY_SUFFIX = ' copy';

export function duplicateRoutine(routine, {
  id,
  name = `${routine.name.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`,
  position = routine.position,
}) {
  return { ...routineWrite(routine), id, name: name.slice(0, NAME_MAX), position };
}

// Every change lands in this copy and nothing reaches the store until Save. The draft is a whole
// routine, so `routineWrite` sends it whichever way it was born, and no target is invented here.
export function draftFrom(routine) {
  return { ...routine, entries: routine.entries.map((entry) => ({ ...entry })) };
}

export function blankRoutine({ id, position = 0 }) {
  return { id, name: '', position, entries: [] };
}

// The opening values of the target sheet and of nothing else: numbers to be typed over.
export const NEW_ENTRY_SETS = 3;
export const NEW_ENTRY_REPS = 5;

// A movement joins open; the row reads `open` until it comes back through `Set`.
export function withEntryAdded(entries, exerciseId) {
  return [...entries, { exerciseId }];
}

export function withEntryRemoved(entries, index) {
  return entries.filter((entry, at) => at !== index);
}

// The target sheet holds this and the draft takes it only on `Set`. An open row opens the sheet at the
// opening values rather than at nothing — numbers to be typed over, never a prefill.
export function targetDraftOf(entry) {
  if (entry.targetSets != null) return { ...entry };
  return { ...entry, targetSets: NEW_ENTRY_SETS, targetReps: NEW_ENTRY_REPS };
}

// Both conditions: the routine untested — the store's `lastTrainedAt` absent — AND the row still open.
export function saysNeverLogged(routine, entry) {
  return isUntested(routine) && entry.targetSets == null;
}

// No absence here is a clamped value: null weight, null rep target and null set target each mean
// something, so the clamp lets each pass and clearing one is the only way back.
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

// The row keeps its place and stops asking for anything. All three targets go together: the store
// refuses a line asking for reps of nothing. Rest stays.
export function withEntryOpened(entries, index) {
  return entries.map((entry, at) => {
    if (at !== index) return entry;
    return { exerciseId: entry.exerciseId, ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }) };
  });
}

// Which lines will ask at the rack; a routine with every target set has no sentence at all.
export function openTargetsLine(entries, catalog) {
  const open = entries.filter((entry) => entry.targetSets == null);
  if (open.length === 0) return null;
  const names = open.map((entry) => nameOfMovement(catalog, entry.exerciseId));
  if (names.length === 1) return `${names[0]} has no target — it will ask at the rack.`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last} have no target — they will ask at the rack.`;
}

// The numbering is rewritten from the new order every time. A drop below the last row arrives as an
// index one past the end and is clamped.
export function reorderEntries(entries, from, to) {
  if (entries.length === 0) return [];
  const last = entries.length - 1;
  const moved = [...entries];
  const [entry] = moved.splice(Math.min(Math.max(from, 0), last), 1);
  moved.splice(Math.min(Math.max(to, 0), last), 0, entry);
  return moved.map((each, index) => ({ ...each, position: index + 1 }));
}

// The routine's name is dropped rather than printed empty for a routine still being named.
export function entryPlaceLabel(index, count, routineName) {
  const named = (routineName ?? '').trim();
  if (named === '') return `${index + 1} of ${count}`;
  return `${index + 1} of ${count} · ${named}`;
}

// The count is the store's `movements` — the lines the routine was created with — and is absent where
// none was stored; today's entry count is not a substitute. Past six days the weekday alone repeats.
const WEEKDAY_MS = 6 * 86400000;

export function builtLabel(routine, now = Date.now()) {
  const created = (routine?.history ?? []).find((row) => row.kind === 'created');
  if (!created) return null;
  const when = now - created.at >= WEEKDAY_MS ? shortDayLabel(created.at) : weekdayName(created.at);
  if (created.movements == null) return `built ${when}`;
  const movements = created.movements === 1 ? '1 movement' : `${created.movements} movements`;
  return `built ${when} · ${movements}`;
}

// Two kinds of row, newest first, the `created` row always last and always there. A created row with
// no `by` is the lifter's own hand, and the absence is the whole claim.
export function historyRows(routine) {
  return (routine?.history ?? []).map((row, index) => {
    if (row.kind === 'created') {
      const what = row.by == null ? 'created by you' : `created by ${sourceLabel({ door: row.by })}`;
      const movements = row.movements == null ? null : `${row.movements} movements`;
      return {
        key: `created-${index}`,
        pending: false,
        href: null,
        line: [shortDayLabel(row.at), what, movements].filter((part) => part != null).join(' · '),
      };
    }
    // `source.thread` absent means there is nothing to open; the row still names the door.
    return {
      key: row.proposal.id,
      pending: isPending(row.proposal),
      href: proposalHref(row.proposal.id),
      thread: conversationOf(row.proposal.source),
      line: historyLabel(row.proposal),
    };
  });
}

