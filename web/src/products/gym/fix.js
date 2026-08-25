import { failureReason } from './gymApi.js';
import { routineNameOf, setLoadLabel } from './log.js';
import { bump, bumpReps, round } from './logger/ladder.js';

// DOM order for the segmented control; only `working` counts toward anything.
export const SET_KINDS = ['warmup', 'working', 'drop', 'failure'];

// Must equal TOAST_MS in useTrainingLog.js: the Undo lives in that toast.
export const UNDO_MS = 9000;

// Rounded onto the ladder's grid so comparisons against the stored value are like for like.
export function fixDraftOf(set) {
  return { weightKg: round(set.weightKg), reps: set.reps, kind: set.kind };
}

export function withWeight(draft, direction, big) {
  return { ...draft, weightKg: bump(draft.weightKg, direction, big) };
}

// The store refuses reps < 1.
export function withReps(draft, direction) {
  return { ...draft, reps: bumpReps(draft.reps, direction) };
}

// Only changed fields go on the wire; omitted ones keep their stored value.
// `Object.is` on the weight so a NaN on both sides is not reported as moved.
export function fixOf(set, draft) {
  const fix = {};
  if (!Object.is(draft.weightKg, round(set.weightKg))) fix.weightKg = draft.weightKg;
  if (draft.reps !== set.reps) fix.reps = draft.reps;
  if (draft.kind !== set.kind) fix.kind = draft.kind;
  return fix;
}

export function fixSubtitle(movement, set) {
  if (set.setNumber == null) return movement;
  return `${movement} · set ${set.setNumber}`;
}

export function keepsItsOwnNumbers(session) {
  const routine = routineNameOf(session);
  if (!routine) return null;
  return `${routine} keeps its own numbers`;
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

// `moves` maps set id → the stored set, or null for a delete still withheld.
// A Map, not an object: the keys are wire ids and would hit Object.prototype.
export function setsAfter(sets, moves) {
  return sets.flatMap((set) => {
    if (!moves.has(set.id)) return [set];
    const moved = moves.get(set.id);
    return moved ? [moved] : [];
  });
}

export function movesAfterRead(moves) {
  return new Map([...moves].filter(([, moved]) => moved === null));
}
