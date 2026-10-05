// Engine deaths are committed durably while held, and Undo removes the held gesture. The room
// tracks their visible offer; release and restart belong to the engine. REST Coach deletes wait
// for this room's timer, and draft entry deletes only change the draft. Each has its own clock.
// Entries carry {kind, id, line, detail, engineDeath, pending, send, refused, undo}. Engine deaths
// never invoke send; REST sends settle on success and restore the row on failure.

export const WITHHELD_KINDS = ['set', 'routine', 'session', 'thread', 'entry', 'note', 'bodyweight'];

export function withheldKey(kind, id) {
  return `${kind}:${id}`;
}

// A delete whose clock has fired is SETTLING: its send is in the air, so it is no longer offered
// back — but it stays in the list, because the row must not reappear between the clock and the
// answer that confirms it gone.
export function openHeld(held) {
  return held.filter((each) => !each.settling);
}

// What a screen must NOT draw, under one verb: everything the window is holding (settling included)
// and everything the store has confirmed gone. One question, so no screen can ask half of it — a row
// leaves on the act and never comes back, whether the delete is still recallable or already spent.
export function hiddenIds(held, settled, kind) {
  return new Set([...held, ...settled].filter((each) => each.kind === kind).map((each) => each.id));
}

// What the STORE has answered for, under one verb — the settled half of `hiddenIds` alone. A screen's
// stance about the ACCOUNT reads this and its rows read `hiddenIds`: a window decides which rows are
// drawn, never what state a screen is in (`13-gestures.md`). An id leaves it only by being written
// again, so a day written back is a day the account holds.
export function goneIds(settled, kind) {
  return new Set(settled.filter((each) => each.kind === kind).map((each) => each.id));
}

export function heldLine(open) {
  if (open.length === 0) return null;
  if (open.length === 1) return open[0].line;
  return `${open.length} deleted.`;
}

// What the act does NOT take with it, said at the moment of the act rather than standing on the
// screen the act is reached from. 13-gestures Law 4 is enforced here and not at the call site: past
// one held delete the count line takes over, and a count has no one detail to carry.
export function heldDetail(open) {
  if (open.length !== 1) return null;
  return open[0].detail ?? null;
}

// The one voice. A said sentence and an open window both want the transient, and whichever spoke
// last has it — so a refused delete is read even while another window runs. The window's transient
// carries the Undo and no dismiss: it retires when its last clock closes, which is the only honest
// way to show that a way back has expired.
export function transientOf(said, held) {
  const open = openHeld(held);
  if (open.length === 0) return said;
  const window = { text: heldLine(open), detail: heldDetail(open), at: open[open.length - 1].at, undoable: true };
  if (said && said.at > window.at) return said;
  return window;
}

export const UNDO_LABEL = 'Undo';

// Pressed in the seam between the clock firing and the transient retiring. The alternative is a
// button that answers nothing, which would be the transient lying about a window it no longer holds.
export const WINDOW_CLOSED = 'The window closed — that delete already went.';
