import { illegalTargets } from '../ui/mobile/aim.js';

const SWIPE_ARM_PX = 14;      // rightward travel before the swipe takes over the gesture
const SWIPE_ARM_RATIO = 1.3;  // and it must out-run the vertical travel by this much
const SWIPE_CLAMP_PX = 120;   // the row never trails the finger past this
const SWIPE_COMMIT_PX = 72;   // release at or beyond this marks the step done
const PIN_MARGIN_PX = 16;     // breathing room left between the pinned row and the keyboard
const HOLD_SLOP_PX = 10;      // a still finger; any travel past this yields the hold to a scroll or swipe

export const HOLD_MS = 500;   // a finger held this long (still) arms multi-select

export function swipeBegin() {
  return { armed: false, live: true, dx: 0 };
}

// Right-swipe only: the gesture arms on rightward travel that out-runs the vertical, and a vertical-first drag kills it.
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

// Radial, not axis-bound: any travel past the slop cancels the hold.
export function holdCancelledByMove(dx, dy) {
  return Math.hypot(dx, dy) > HOLD_SLOP_PX;
}

// A cancelled pointer never commits, but an armed cancel still swallows the trailing click.
export function swipeCancel(gesture) {
  return { commit: false, swallow: gesture.armed };
}

// An add field is keyed by its parentId, every other by its node id.
export function stillEditing(edit, mode, key) {
  if (!edit || edit.mode !== mode) return false;
  return mode === 'add' ? edit.parentId === key : edit.id === key;
}

// The lane's box is cut OUT of the scroller; only the part of the body the keyboard still covers is padded inside.
export function scrollerClearance({ laneInset, keyboardInset }) {
  return { lane: laneInset, keyboardCover: Math.max(0, keyboardInset - laneInset) };
}

// Only ever scrolls DOWN; the page never moves.
export function keyboardPin({ rowBottom, bodyHeight, keyboardInset, scrollTop }) {
  const target = rowBottom - (bodyHeight - keyboardInset - PIN_MARGIN_PX);
  if (target <= scrollTop) return scrollTop;
  return target;
}

// Legal prerequisites, then the ones that would close a loop; self and existing parents are dropped.
export function pickerCandidates(tree, id) {
  if (!tree.nodesById.has(id)) return null; // the target was deleted remotely
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
