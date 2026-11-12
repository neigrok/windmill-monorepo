// Going into the tree a step opens, and the way back. Both ride history entries and never tree data: the entry of the
// tree gone into says where the person came from, and the entry they left says which step they went through. So a
// direct link has no way back, a chain pops one tree per press, and the browser's Back reads what the chip reads.

import { createContext, useCallback, useEffect, useState } from 'react';
import { navigate } from '../../../shell/navigation.js';
import { track as beacon } from '../../../telemetry/beacon.js';

// The room's `open(stepId, door)` for every surface that shows a step's tree; null where no tree can be gone into.
export const TreeDoor = createContext(null);

const CAME_FROM = 'roadmapCameFrom';
const WENT_THROUGH = 'roadmapWentThrough';
const VIEWS = ['board', 'tree'];
const viewOf = (held) => (VIEWS.includes(held?.view) ? held.view : null);

// Leaves the step and the view on the entry being left, then pushes the opened tree's entry naming where it was reached from.
export function enterTree(treeId, { from, stepId, view }) {
  window.history.replaceState({ ...window.history.state, [WENT_THROUGH]: { stepId, view } }, '');
  navigate(`#/app/${treeId}`);
  if (treeId !== from.id) window.history.replaceState({ ...window.history.state, [CAME_FROM]: { title: from.title, view } }, '');
}

// What this history entry says of the visit: the tree the person came from, the step they went through before coming
// back, and the view either carries. A returning entry's view wins, as it is the one they left this tree in.
export function readTreeVisit(state = window.history.state) {
  const cameFrom = typeof state?.[CAME_FROM]?.title === 'string' ? state[CAME_FROM] : null;
  const wentThrough = typeof state?.[WENT_THROUGH]?.stepId === 'string' ? state[WENT_THROUGH] : null;
  if (wentThrough) return { from: cameFrom?.title ?? null, through: wentThrough.stepId, view: viewOf(wentThrough), door: 'back' };
  if (cameFrom) return { from: cameFrom.title, through: null, view: viewOf(cameFrom), door: 'tree' };
  return { from: null, through: null, view: null, door: null };
}

// A return is said once: the step gone through leaves the entry, so a reload of it is an ordinary visit.
export function settleReturn() {
  const { [WENT_THROUGH]: through, ...state } = window.history.state ?? {};
  if (through) window.history.replaceState(state, '');
}

// The room's side of it: `open` goes into a step's tree from the door that offered it, off the tree and the view the room
// stands on at that moment, and `back` is the chip's press.
export function useTreeVisit({ room, band, track = beacon }) {
  const [visit] = useState(readTreeVisit);
  useEffect(() => {
    if (visit.door !== 'back') return;
    settleReturn();
    track('roadmap_tree_back', { band });
  }, []);

  const open = useCallback((stepId, door) => {
    const tree = room.standingTreeRef.current;
    const view = room.viewRef.current;
    const opening = tree?.nodesById.get(stepId)?.opening;
    if (!opening || opening.dangling) return false;
    track('roadmap_tree_open', { door, view: view === 'board' ? 'board' : 'graph', band });
    enterTree(opening.treeId, { from: { id: tree.id, title: tree.title }, stepId, view });
    return true;
  }, [room, band]);

  return { ...visit, open, back: useCallback(() => window.history.back(), []) };
}
