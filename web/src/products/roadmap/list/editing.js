// The list's interaction math (X8 L3/L4), kept pure so node:test can pin the thresholds the
// finger actually feels. No DOM and no React: the swipe-to-done state machine (a gesture + a
// delta in, a fresh gesture or a verdict out), the scroller's clearances under the action lane and
// the keyboard, the keyboard pin that floats the active row just above that keyboard, the
// need-picker's legal / would-loop partition, and the field identity guard that lets an unmount
// drain a pending commit without stomping the next editor.
// ListView owns the pointers, the scroll and the sheet; this owns only the rules.

import { illegalTargets } from '../ui/mobile/aim.js';

const SWIPE_ARM_PX = 14;      // rightward travel before the swipe takes over the gesture
const SWIPE_ARM_RATIO = 1.3;  // and it must out-run the vertical travel by this much
const SWIPE_CLAMP_PX = 120;   // the row never trails the finger past this
const SWIPE_COMMIT_PX = 72;   // release at or beyond this marks the step done
const PIN_MARGIN_PX = 16;     // breathing room left between the pinned row and the keyboard
const HOLD_SLOP_PX = 10;      // a still finger; any travel past this yields the hold to a scroll or swipe

export const HOLD_MS = 500;   // a finger held this long (still) arms multi-select (M5)

export function swipeBegin() {
  return { armed: false, live: true, dx: 0 };
}

// Arming is right-swipe only: a leftward drag never becomes a mark-done, so |dx| would be wrong —
// the gesture takes over only when the finger travels RIGHT past the threshold and out-runs any
// vertical intent. A vertical-first drag kills the gesture so the list scrolls instead.
export function swipeMove(gesture, dx, dy) {
  if (!gesture.live) return gesture;
  if (gesture.armed) return { armed: true, live: true, dx: Math.max(0, Math.min(dx, SWIPE_CLAMP_PX)) };
  if (dx > SWIPE_ARM_PX && dx > Math.abs(dy) * SWIPE_ARM_RATIO) {
    return { armed: true, live: true, dx: Math.max(0, Math.min(dx, SWIPE_CLAMP_PX)) };
  }
  if (Math.abs(dy) > SWIPE_ARM_PX) return { armed: false, live: false, dx: 0 };
  return gesture;
}

export function swipeEnd(gesture) {
  return { commit: gesture.armed && gesture.dx >= SWIPE_COMMIT_PX, swallow: gesture.armed };
}

// Long-press multi-select is deliberate-entry (M5): the hold arms only if the finger stays put
// for the full HOLD_MS. Any travel past the slop — a scroll starting, a swipe-to-done arming —
// cancels the pending hold, so the list scrolls and the swipe runs unchallenged. Radial, not
// axis-bound: a diagonal drift counts the same as a straight scroll.
export function holdCancelledByMove(dx, dy) {
  return Math.hypot(dx, dy) > HOLD_SLOP_PX;
}

// A cancelled pointer (the browser stole the gesture) never commits — it always springs back —
// but an armed cancel still swallows the trailing click the way a release does.
export function swipeCancel(gesture) {
  return { commit: false, swallow: gesture.armed };
}

// Does `edit` still describe the field identified by (mode, key)? An add field is keyed by its
// parentId, every other field by its node id. A field draining a pending commit on unmount uses
// this to close ONLY its own editor — never the next one the same tap has already opened.
export function stillEditing(edit, mode, key) {
  if (!edit || edit.mode !== mode) return false;
  return mode === 'add' ? edit.parentId === key : edit.id === key;
}

// What the scroller keeps clear of the two things that own the screen's bottom edge (§5, §7). The
// action lane's box is cut OUT of the scroller — the body ends at the lane's top edge — so no row
// can lie under the pill or Share at any scroll position, not only at rest: a seat is tappable as
// the seat or is not on screen. The keyboard rises from the screen bottom, so it swallows the
// lane's band before it reaches a row; only the part of the body it still covers is padded INSIDE.
export function scrollerClearance({ laneInset, keyboardInset }) {
  return { lane: laneInset, keyboardCover: Math.max(0, keyboardInset - laneInset) };
}

// Where the list body must scroll so the field the finger is in clears the keyboard: the row's
// bottom minus the visible strip left above the keyboard (`keyboardCover` from scrollerClearance —
// the body's own covered strip, not the whole keyboard). Only ever scrolls the list DOWN — a
// field already above the keyboard is left where it sits, and the page itself never moves.
export function keyboardPin({ rowBottom, bodyHeight, keyboardInset, scrollTop }) {
  const target = rowBottom - (bodyHeight - keyboardInset - PIN_MARGIN_PX);
  if (target <= scrollTop) return scrollTop;
  return target;
}

// The picker's two buckets for "add a need to `id`": legal prerequisites first, then the ones
// that would close a loop (a descendant of `id` can't also become its ancestor). Self and the
// steps already needed are dropped entirely; illegalTargets('needs') is exactly self + those
// descendants + those existing parents, so subtracting self and the parents leaves the loops.
export function pickerCandidates(tree, id) {
  if (!tree.nodesById.has(id)) return null; // the target was deleted (remotely) — nothing to pick for
  const blocked = illegalTargets(tree, id, 'needs');
  const parents = new Set(tree.parentsOf(id).map((parent) => parent.id));
  const legal = [];
  const looping = [];
  for (const node of tree.nodes) {
    if (node.id === id) continue;
    if (parents.has(node.id)) continue;
    if (blocked.has(node.id)) { looping.push(node); continue; }
    legal.push(node);
  }
  return { legal, looping };
}
