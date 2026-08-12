// FIX A SET (§G18) — what a correction IS on the desk, with no React and no fetch in it: the draft
// a sheet opens on, the one PATCH it sends, what the screen says when the log refuses, and how the
// session redraws around a set that moved. The log moves and the routine does not: the frozen plan
// snapshot and the program behind it are untouched by every function here, and the store proves it
// rather than trusting us (backend/products/gym/ARCHITECTURE.md §2.7).
//
// THE WEB HOLDS NOTHING LOCALLY, so the hard part of this wave is not on this surface. Both phones
// keep sets on the device under ids the log has never seen and replay them until it takes them
// (SetQueue, ClaimReplay), which gives a correction there three cases to tell apart: the set still
// queued, the set that landed, and the set the store no longer has. Here every set on screen came
// off the wire — it landed, or the screen could not be drawing it — so those three collapse into
// one. The edit goes over the wire, and the only thing that can surprise it is the log having moved
// underneath (`set-not-found`). There is no queue on this surface to mutate and no branch for one
// below; the day the desk grows one, this is the file that grows the other two cases.
//
// AND NO AGENT MAY REACH ANY OF IT. The two routes carry no MCP tool at any grant level — the one
// verb in gym reserved for the hand (§L's safeguard ladder, backend routes.cpp) — so the coach can
// read what was lifted and hands the correction back to the lifter.

import { failureReason } from './gymApi.js';
import { routineNameOf, setLoadLabel } from './log.js';
import { bump, bumpReps, round } from './logger/ladder.js';

// The four a set can be, in the order the segmented control draws them (§G18). One word for what
// counts is `working` and the other three are all sets the plan never asked for — the same reading
// `workingSetsOf` makes of them (log.js), which is why moving a set between these is a correction
// that moves the session's tonnage and its top e1RM with it.
export const SET_KINDS = ['warmup', 'working', 'drop', 'failure'];

// The five seconds a delete is withheld in. Long enough to be a real take-back, short enough that
// nobody is waiting on it — and it is a WITHHELD write rather than an undo of one that already
// happened, which is the whole reason the take-back can be exact (Log.jsx).
//
// IT IS THE TOAST'S OWN LIFETIME (`TOAST_MS`, useTrainingLog.js), because the toast is where the
// Undo is offered: a window longer than the offer is a take-back nobody can see, and an offer
// longer than the window is a button that has quietly stopped working. The two are pinned equal by
// a test, since neither module can read the other's constant without dragging React into this one.
export const UNDO_MS = 5000;

// The draft opens on the set as it stands, spelled on the ladder's own grid so the first comparison
// against the stored value is between two numbers written the same way.
export function fixDraftOf(set) {
  return { weightKg: round(set.weightKg), reps: set.reps, kind: set.kind };
}

// The ladder is the logger's and never a second opinion (logger/ladder.js): at 47.5 kg this row
// steps −5 · −2.5 · +2.5 · +5, the same four the phones offer, off the same golden.
export function withWeight(draft, direction, big) {
  return { ...draft, weightKg: bump(draft.weightKg, direction, big) };
}

// The rep floor is a CLAMP INTO the range and never a hold at the value — the ladder's own rule,
// because the store refuses reps < 1 and a stepper that preserved a 0 would offer a tap the log
// could only answer with a refusal.
export function withReps(draft, direction) {
  return { ...draft, reps: bumpReps(draft.reps, direction) };
}

// ONLY WHAT MOVED GOES OVER THE WIRE. Every field a fix omits is left exactly as it is stored,
// which is how a set's rpe and its note survive a sheet that never draws them — §G18 draws the
// weight, the reps and the kind, and a client that sent the whole set back would quietly rewrite
// the two it never showed anybody.
//
// `exerciseId`, `completedAt` and `setNumber` are absent for a different reason and it is not
// omission: a set logged against the wrong movement is a different repair, and the store refuses
// all three by name (gymApi.js).
// The weight is compared with `Object.is` and the other two with `!==`, for one input: a set that
// reached this screen carrying no weight at all is NaN on both sides, and NaN !== NaN would report
// it as moved and put `"weightKg": null` on the wire for a fix that moved nothing. No deployment can
// send one today — `gym_sets.weight_kg` is NOT NULL (backend/db/schema.sql) — which is exactly why
// it is worth spending a word on: the promise above is that only what moved goes over, and a
// promise that holds only for well-formed input is not one.
export function fixOf(set, draft) {
  const fix = {};
  if (!Object.is(draft.weightKg, round(set.weightKg))) fix.weightKg = draft.weightKg;
  if (draft.reps !== set.reps) fix.reps = draft.reps;
  if (draft.kind !== set.kind) fix.kind = draft.kind;
  return fix;
}

// Which set is under the sheet, said the way the design says it: `Overhead Press · set 3`. The
// number is the store's — nothing on this surface assigns one — and a set carrying none is named by
// its movement alone rather than by an invented position.
export function fixSubtitle(movement, set) {
  if (set.setNumber == null) return movement;
  return `${movement} · set ${set.setNumber}`;
}

// THE CAPTION OF THE WHOLE SCREEN, beside the one destructive control on it: *Push A keeps its own
// numbers.* The routine and the plan frozen onto this session do not move when a logged set does,
// and that is the reassurance a lifter needs before deleting anything.
//
// A session run against no routine has no program to reassure anybody about, so it says nothing —
// the line would otherwise have to name a subject that does not exist. And it never widens into
// "nothing else moves", which would be false: the session's tonnage, its top e1RM and its records
// all move with the set, because they are readings OF the sets and always were.
export function keepsItsOwnNumbers(session) {
  const routine = routineNameOf(session);
  if (!routine) return null;
  return `${routine} keeps its own numbers`;
}

// What the toast says while the delete is withheld. It names WHICH set, because the row it stood on
// has just left the screen and "that set" alone is not enough to undo with confidence. It promises
// nothing beyond the Undo standing beside it: there is no trash behind this screen, no thirty days
// and no destination in settings — when the window closes the set is out of the log.
export function deletedLine(set) {
  return `${setLoadLabel(set)} is out of the log.`;
}

// A 404 on this route is not the log failing to answer and it is not a document it would not take:
// the set is not there. So it is spoken here rather than through `failureReason`, whose two
// half-sentences are both wrong for it — and the screen's repair is to read the session again,
// because whatever moved it moved more than this one row.
export function fixFailure(error) {
  if (error?.setNotFound) return 'That set isn’t in this workout any more.';
  return `That fix didn’t land — ${failureReason(error)}.`;
}

// The delete's only refusals are 401 and 500 (gymApi.js), so there is no fourth sentence to pick
// between. It leads with what is still true — the set is in the log — because the row has already
// come back on screen by the time this is read.
export function deleteFailure(error) {
  return `That set is still in the log — ${failureReason(error)}.`;
}

// THE SETS ON SCREEN, after the corrections this screen has made — one entry per set the lifter
// moved, keyed by set id. A fix answers with the STORED set, so the corrected row is substituted
// in place and every reading taken off these sets moves with it in the same render: the header's
// working count, the session's tonnage, the plan note beside each set, and the first-performed
// order they are grouped in. That is why it substitutes rather than re-reading — one round trip
// leaves the whole screen agreeing, where a re-read would blank it for a beat to learn one number.
//
// A WITHHELD DELETE IS A `null`: the row leaves the screen while the five seconds run and the store
// still has it, so undoing is exact because nothing has happened yet. Nothing in this file destroys
// anything.
//
// A Map and not an object, because the keys are ids from the wire: `moves.toString` on a plain
// object answers a function that every row would then be replaced by.
export function setsAfter(sets, moves) {
  return sets.flatMap((set) => {
    if (!moves.has(set.id)) return [set];
    const moved = moves.get(set.id);
    return moved ? [moved] : [];
  });
}

// AND WHAT IS STILL HELD ONCE THE SESSION IS READ AGAIN — which is not the corrections. A re-read
// happens for one reason: the log moved underneath this screen (`set-not-found`, or a read that
// failed and was asked again). So the read is the newer answer to every question a correction was
// the answer to — it already contains the fix, because the store is where the fix landed — and
// substituting the older row back over it would undo the repair the re-read was for, silently, in
// the one direction nothing on the screen could show.
//
// A WITHHELD DELETE IS NOT A CORRECTION AND IT STAYS. Nothing has been sent for it, so the store
// still has that row and every read carries it back; dropping it here would put the set back on
// screen with its own five seconds still running underneath — and offer an Undo for a row the
// lifter can see, then take it away again when the window closed.
export function movesAfterRead(moves) {
  return new Map([...moves].filter(([, moved]) => moved === null));
}
