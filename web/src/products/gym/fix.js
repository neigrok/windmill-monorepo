import { failureReason } from './gymApi.js';
import { setLoadLabel } from './log.js';

// The RPE band a lifter reads a set in: six to ten, by halves. The rungs are COUNTED off the band so
// the band is the only thing this file states — and the leading seat is no rpe at all, because a set
// that was never rated must be reachable again after one is chosen by mistake. That seat wears its
// own words and never a bare dash: a dash is read out as nothing, so the seat would have no name.
export const RPE_MIN = 6;
export const RPE_MAX = 10;
const RUNGS_PER_POINT = 2;
export const RPE_RUNGS = Array.from(
  { length: (RPE_MAX - RPE_MIN) * RUNGS_PER_POINT + 1 },
  (_, rung) => RPE_MIN + rung / RUNGS_PER_POINT,
);
export const NO_RPE_LABEL = 'Not rated';

// A SET NOTE is a record of what a set felt like, and the prompt reads it as data. A note (the Notes
// screen) is directive text Coach follows. The field description keeps the two apart.
export const SET_NOTE_LABEL = 'Set note';
export const SET_NOTE_CAPTION = 'A record for you — not an instruction to Coach.';

// The store holds a set note in 4000 UTF-8 BYTES and refuses a longer one with the generic
// `fix-unreadable` — the domain's own sentence never reaches a lifter — so THIS surface is where an
// over-long note is refused, and the refusal drawn here is the only one they will read.
export const SET_NOTE_BYTES = 4000;
// The last fifth of the bound: the rule `NAME_COUNT_FROM` (log.js) and `BODY_COUNT_FROM`
// (notes/notes.js) read for the other two counters in this room.
export const SET_NOTE_COUNT_FROM = 3200;

// Bytes and not characters, because bytes are what the column counts.
export function setNoteBytes(note) {
  return new TextEncoder().encode(note ?? '').length;
}

export function showsSetNoteCount(note) {
  return setNoteBytes(note) >= SET_NOTE_COUNT_FROM;
}

export function setNoteCountLabel(note) {
  return `${setNoteBytes(note)} of ${SET_NOTE_BYTES} bytes`;
}

// Over the bound is a STATE and not a keystroke: a note arrives from the store already written, and
// nothing here cuts it on the way in. The counter's alarm ink and the refusal are two readings of
// this one predicate, so a counter can never go quiet under a sentence that is still refusing.
export function isSetNoteOverCap(note) {
  return setNoteBytes(note) > SET_NOTE_BYTES;
}

export function setNoteRefusal(note) {
  if (!isSetNoteOverCap(note)) return null;
  return `A set note runs to ${SET_NOTE_BYTES} bytes.`;
}

// The withheld window, on every surface (13-gestures.md Law 2). The room's `TOAST_MS` — how long a
// SAID sentence stands — is pinned equal to it, but they are two spans: a window retires the
// transient itself when its last clock closes, and never on a sentence's clock.
export const UNDO_MS = 9000;

export function fixOf(set, draft) {
  const fix = {};
  if (!Object.is(draft.weightKg, set.weightKg)) fix.weightKg = draft.weightKg;
  if (draft.reps !== set.reps) fix.reps = draft.reps;
  if (draft.rpe !== (set.rpe ?? null)) fix.rpe = draft.rpe;
  if (draft.note !== (set.note ?? '')) fix.note = draft.note;
  return fix;
}

export function fixSubtitle(movement, set) {
  if (set.setNumber == null) return movement;
  return `${movement} · set ${set.setNumber}`;
}

export function deletedLine(set) {
  return `${setLoadLabel(set)} is out of the log.`;
}

export function fixFailure(error) {
  if (error?.setNotFound) return 'That set isn’t in this workout any more.';
  return `That fix didn’t land — ${failureReason(error)}.`;
}

export function deleteFailure(error) {
  return `That set is still in the log — ${failureReason(error)}.`;
}

// `moves` maps set id → the stored set, for a set corrected in place. A set DELETED is not here in
// any form: the room knows what its window holds and what the store has answered for, and it
// outlives the screen that drew the row. A Map, not an object: the keys are wire ids and would hit
// Object.prototype.
export function setsAfter(sets, moves) {
  return sets.map((set) => moves.get(set.id) ?? set);
}
