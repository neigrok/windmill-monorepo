// The list's interaction math (X8 L3/L4), kept pure so node:test can pin the thresholds the
// finger actually feels. No DOM and no React: the swipe-to-done state machine (a gesture + a
// delta in, a fresh gesture or a verdict out), the keyboard pin that floats the active row just
// above the on-screen keyboard, the need-picker's legal / would-loop partition, and the field
// identity guard that lets an unmount drain a pending commit without stomping the next editor.
// ListView owns the pointers, the scroll and the sheet; this owns only the rules.

import { illegalTargets } from '../ui/mobile/aim.js';

const SWIPE_ARM_PX = 14;      // rightward travel before the swipe takes over the gesture
const SWIPE_ARM_RATIO = 1.3;  // and it must out-run the vertical travel by this much
const SWIPE_CLAMP_PX = 120;   // the row never trails the finger past this
const SWIPE_COMMIT_PX = 72;   // release at or beyond this marks the step done
const PIN_MARGIN_PX = 16;     // breathing room left between the pinned row and the keyboard

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

// Where the list body must scroll so the field the finger is in clears the keyboard: the row's
// bottom minus the visible strip left above the keyboard. Only ever scrolls the list DOWN — a
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
