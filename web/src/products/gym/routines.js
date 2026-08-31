// Routines as pure rules. Everything here hands back either a WRITE document — the shape POST and PUT
// read, its order carried by the order of its entries and no `position` on an entry, the server
// renumbering densely from what it was sent — or the editor's DRAFT of that same routine. An absent
// optional is omitted, never null. Nothing here mints an id, invents a name, or reads a routine out
// of a plan snapshot: an edit is always a read of the routine itself, changed and written whole.

import { round } from './logger/ladder.js';
import {
  cappedName, groupByExercise, isUntested, NAME_MAX, proposalHref, shortDayLabel, weekdayName,
  workingSetsOf,
} from './log.js';
import { conversationOf, historyLabel, isPending, sourceLabel } from './proposals.js';

// THE ROUTINE TARGET'S BANDS, and nothing else's. A target may ask for 1–100 reps (Routine.cpp:23)
// and 1–20 sets; the LIVE LOGGER's reps band is 1–99 and lives in logger/entry.js, which enforces it
// for the fix sheet. The two are different numbers on two screens and each file says which it holds.
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
// `position` is the caller's to state: a copy that took the original's would land on top of it.
const COPY_SUFFIX = ' copy';

export function duplicateRoutine(routine, {
  id,
  name = `${cappedName(routine.name, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`,
  position,
}) {
  return { ...routineWrite(routine), id, name: cappedName(name), position };
}

// Every change lands in this copy and nothing reaches the store until Save. The draft is a whole
// routine, so `routineWrite` sends it whichever way it was born, and no target is invented here.
export function draftFrom(routine) {
  return { ...routine, entries: routine.entries.map((entry) => ({ ...entry })) };
}

export function blankRoutine({ id, position = 0 }) {
  return { id, name: '', position, entries: [] };
}

// A movement joins open; the row reads `open` until it comes back through `Set`.
export function withEntryAdded(entries, exerciseId) {
  return [...entries, { exerciseId }];
}

export function withEntryRemoved(entries, index) {
  return entries.filter((entry, at) => at !== index);
}

// The line goes back where it was. A draft that moved on since is not rewritten: the index is
// clamped to the end rather than opening a hole in a list that is now shorter.
export function withEntryAt(entries, index, entry) {
  const at = Math.min(Math.max(index, 0), entries.length);
  return [...entries.slice(0, at), entry, ...entries.slice(at)];
}

// Deleting a routine takes the proposals anchored to it with it, so the transient names WHICH
// routine left rather than saying that one did.
export function routineDeletedLine(name) {
  return `${name} deleted.`;
}

export function entryDroppedLine(movement) {
  return `${movement} is out of the routine.`;
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

// The sheet hands back a WHOLE entry and this swaps one row for it — never a merge, because the row
// it hands back may be the open one, which has to be able to drop targets the old row was holding.
export function withEntrySet(entries, index, entry) {
  return entries.map((each, at) => (at === index ? entry : each));
}

// The open row names itself `open` in its own target column — that word says WHICH row. The sentence
// says what the word means, so it is drawn ONCE beneath a list of movements that holds an open row,
// and once in the target sheet while the line being edited is the open one. Never per row: six open
// rows are one meaning, not six. The same sentence on every surface.
export const OPEN_LINE = 'You decide the numbers at the rack.';

export function isOpenEntry(entry) {
  return entry.targetSets == null;
}

export function hasOpenEntry(entries) {
  return entries.some(isOpenEntry);
}

// ── The three typed fields ──────────────────────────────────────────────────────────────────────
// The sheet holds TEXT, not numbers: what was typed is what is drawn, and a field that refuses keeps
// what the lifter put in it so they can see the thing being refused. Emptying a field IS how it is
// cleared, and the placeholder says what empty means.
export const OPEN_PLACEHOLDER = 'open';
export const MAX_PLACEHOLDER = 'max';
export const LAST_TIME_PLACEHOLDER = 'last time';
export const DECIMAL_NOTE = 'comma or point, both read as a decimal';

// Pinned in briefs/15-the-routine.md. The reps band here is the ROUTINE TARGET's 1–100; the live
// logger's 1–99 sentence is logger/entry.js's.
export const ONE_DECIMAL = 'One decimal point only.';
export const NOT_A_NUMBER = 'That is not a number yet.';
export const OVER_MAX_LOAD = 'Over 500 kg — check the number.';
export const REPS_BAND = 'Whole reps, 1 to 100.';
export const SETS_BAND = 'Sets, 1 to 20.';
export const ZERO_TARGET = 'A zero target is no target — clear the field instead.';
export const CLEAR_REPS_AND_WEIGHT = 'Clear reps and weight first — an open line names neither.';
// The same shape reached from the other side — a number typed onto a line whose sets are empty — and
// the remedy is the opposite one, so it cannot be said in the sentence above. Not pinned by the
// brief: the second half is the pinned sentence's, and the first names the only way out.
export const NAME_SETS_FIRST = 'Name the sets first — an open line names neither.';

// The store's ceiling on a load, the same number the live logger refuses past.
export const MAX_LOAD_KG = 500;

const FIELDS = ['sets', 'reps', 'weight'];

// The sheet opens on what the row HOLDS and invents nothing: an open row opens with three empty
// fields, so the placeholders — `open`, `max`, `last time` — are read on the row they are true of
// rather than hidden behind numbers nobody typed.
export function targetFieldsOf(entry) {
  return {
    sets: entry.targetSets == null ? '' : String(entry.targetSets),
    reps: entry.targetReps == null ? '' : String(entry.targetReps),
    weight: entry.targetWeightKg == null ? '' : String(entry.targetWeightKg),
    // The one refusal that cannot be re-derived from the text, because the keystroke never landed.
    clearRefused: false,
  };
}

// The line the sheet holds is OPEN while its sets field is empty — the one emptiness the sheet reads
// three ways: the sentence it draws, the refusal it computes, and the entry it hands back.
export function isOpenFields(fields) {
  return fields.sets.trim() === '';
}

// Null for a field that is empty — an empty field is a null target and not a fault.
export function refusalOf(field, text) {
  const raw = (text ?? '').trim();
  if (raw === '') return null;
  const normalised = raw.replace(/,/g, '.');
  if ((normalised.match(/\./g) || []).length > 1) return ONE_DECIMAL;
  const value = Number(normalised);
  if (normalised === '-' || !Number.isFinite(value)) return NOT_A_NUMBER;
  if (value === 0) return ZERO_TARGET;
  if (field === 'weight') return Math.abs(value) > MAX_LOAD_KG ? OVER_MAX_LOAD : null;
  if (field === 'reps') {
    return Number.isInteger(value) && value >= ENTRY_REPS_MIN && value <= ENTRY_REPS_MAX ? null : REPS_BAND;
  }
  return Number.isInteger(value) && value >= ENTRY_SETS_MIN && value <= ENTRY_SETS_MAX ? null : SETS_BAND;
}

// One refusal on the sheet at a time, drawn under the field it belongs to, topmost first — the same
// shape as the editor's two Save refusals.
//
// The open line's shape is checked before the fields are, and it has TWO ways in, which are opposite
// acts and so take opposite sentences: the lifter cleared sets while the other two held values (the
// keystroke was refused, `clearRefused`, and the way out is to clear those two), or they typed into
// reps or weight on a line whose sets are already empty (that keystroke lands, the commit is refused,
// and the way out is to name the sets — telling them to clear what they just typed would be telling
// them to abandon what they asked for). Nothing typed is ever dropped without a word.
export function targetRefusal(fields) {
  if (fields.clearRefused) return { field: 'sets', message: CLEAR_REPS_AND_WEIGHT };
  const open = isOpenFields(fields);
  const named = fields.reps.trim() !== '' || fields.weight.trim() !== '';
  if (open && named) return { field: 'sets', message: NAME_SETS_FIRST };
  for (const field of FIELDS) {
    const message = refusalOf(field, fields[field]);
    if (message) return { field, message };
  }
  return null;
}

// Clearing sets is how a line is left open, and an open line names no reps and no weight — so while
// either of those holds a value the clear is REFUSED and the field keeps what it had. Every other
// keystroke lands as typed.
export function withField(fields, field, text) {
  if (field === 'sets' && text.trim() === '' && (fields.reps.trim() !== '' || fields.weight.trim() !== '')) {
    return { ...fields, clearRefused: true };
  }
  return { ...fields, [field]: text, clearRefused: false };
}

// `±` on the weight field, the one the rack keypad also carries: band-assisted work is a negative
// load and a decimal keyboard offers no sign. It flips the leading sign of the TEXT and never leaves
// a bare `-` behind — an empty field has no sign to flip, so the press is a no-op rather than a
// refusal nobody asked for.
export function withSignFlipped(fields) {
  const text = fields.weight.trim();
  if (text === '') return fields;
  const flipped = text.startsWith('-') ? text.slice(1) : `-${text}`;
  return { ...fields, weight: flipped, clearRefused: false };
}

const numberOf = (text) => Number(text.trim().replace(/,/g, '.'));

// What the row becomes. Sets cleared is the open line, which carries nothing but its rest; the
// clamps stay as the last guard, so no value this screen let through can reach the store out of band.
// The weight is put on the ladder's grid before it is stored — the same `round` the rack keypad
// commits through — so a target and the set that meets it are the same number and not two.
export function targetEntryOf(entry, fields) {
  if (isOpenFields(fields)) {
    return { exerciseId: entry.exerciseId, ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }) };
  }
  return withTarget(entry, {
    targetSets: clampSets(numberOf(fields.sets)),
    targetReps: fields.reps.trim() === '' ? null : clampReps(numberOf(fields.reps)),
    targetWeightKg: fields.weight.trim() === '' ? null : round(numberOf(fields.weight)),
  });
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

