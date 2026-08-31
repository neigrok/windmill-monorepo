// The withheld delete — the one window this room holds a delete open in, and one abstraction over
// every verb that deletes. WITHHELD MEANS NOT SENT: nothing here reaches the store until the clock
// runs out, so a delete taken back never happened at all.
//
// It is a LIST and never a slot. Each delete carries its own clock, so a second delete settles
// nothing, and the transient reads the whole list: one held delete says which, several say how many.
// Undo takes the newest and the transient re-reads for the rest.
//
// An entry is `{ kind, id, line, detail, send, refused, undo }`: the id is what the screen hides its
// row by, `detail` is the one fact the act leaves behind, and `undo` puts a row back where the row
// lives in a draft rather than on the wire.
//
// `send` is what the closing window does — the store call, and any re-read that must follow it. It
// THROWS when the store refuses; the room catches and hands the error to `refused`, which states the
// sentence in the screen's own words. The screens own no try/catch of their own: one place decides
// what a settled delete means, so no screen can be written that forgets. (Nothing after the store
// call inside a `send` may throw, or a delete the store TOOK would be reported as one it refused.)
//
// A send that resolves SETTLES the delete: the room records `{ kind, id }` as gone for as long as
// the room lives. That fact is the room's and not a screen's, because a screen can be rebuilt
// mid-window around a read taken while the row was still there — and then the delete that landed
// afterwards would reach a screen that no longer exists, and the row would come back on screen
// having really gone from the store. A delete that lied is the one thing this window exists to
// prevent.

// The verbs. `set` · `routine` · `session` · `thread` are on the wire, and a server-only delete like
// a conversation is withheld for exactly the same reason as a set: an Undo offered after the send
// would be a lie. `entry` is a line of an unsaved routine draft, which sends nothing at all and is
// taken back inside the draft.
export const WITHHELD_KINDS = ['set', 'routine', 'session', 'thread', 'entry'];

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
