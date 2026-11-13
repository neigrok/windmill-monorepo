// Going into another tree of the holder's, and the way back: down into the tree a step opens, or up into a tree whose
// guide stands above this one. Both ride history entries and never tree data: the entry of the tree gone into names the
// tree the person came from, and the entry they left names the step they went through, or none for a way up. So a
// direct link has no way back, a chain pops one tree per press, and the browser's Back reads what the chip reads.
// An entry outlives a sign-out, so it holds ids alone: the way back is shown only to whoever holds the tree it leads to,
// under the title this device's index keeps for them: the account's own row, or the row of a tree that lives only here.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { navigate } from '../../../shell/navigation.js';
import { track as beacon } from '../../../telemetry/beacon.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';

// The room's `open(id, door)` for every surface that shows the way into a tree; null where no tree can be gone into.
export const TreeDoor = createContext(null);

// Every surface that offers the way into a tree, as `roadmap_tree_open` names it. The guide's door is given the tree
// above it leads to; every other door is given a step, and leads where that step's opening does.
export const TREE_DOORS = Object.freeze(['pill', 'swipe', 'toast', 'step', 'dock', 'panel', 'bar', 'guide']);

// One door into a step's tree for a surface to offer: null where the step opens none, its opening leads nowhere or no
// tree can be gone into here.
export function useTreeDoor(step, door) {
  const open = useContext(TreeDoor);
  return step?.opening?.leads && open ? () => open(step.id, door) : null;
}

const CAME_FROM = 'roadmapCameFrom';
const WENT_THROUGH = 'roadmapWentThrough';
const VIEWS = ['board', 'tree'];
const viewOf = (held) => (VIEWS.includes(held?.view) ? held.view : null);

// Leaves the step gone through, null for a way up, and the view on the entry being left, then pushes the entered tree's
// entry naming the tree it was reached from.
export function enterTree(treeId, { from, stepId, view }) {
  window.history.replaceState({ ...window.history.state, [WENT_THROUGH]: { stepId, view } }, '');
  navigate(`#/app/${treeId}`);
  window.history.replaceState({ ...window.history.state, [CAME_FROM]: { treeId: from, view } }, '');
}

// What this history entry says of the visit: the tree the person came from, the step they went through before coming
// back, null for a way up through the guide, and the view an arrival carries. A returning entry's view wins, as it is
// the one they left this tree in.
export function readTreeVisit(state = window.history.state) {
  const cameFrom = typeof state?.[CAME_FROM]?.treeId === 'string' ? state[CAME_FROM] : null;
  const left = state?.[WENT_THROUGH];
  const wentThrough = left && (left.stepId === null || typeof left.stepId === 'string') ? left : null;
  const from = cameFrom?.treeId ?? null;
  if (wentThrough) return { from, through: wentThrough.stepId, view: viewOf(wentThrough), door: 'back' };
  if (viewOf(cameFrom)) return { from, through: null, view: viewOf(cameFrom), door: 'tree' };
  return { from, through: null, view: null, door: null };
}

// An arrival is settled once: the step gone through and the view either side carried leave the entry, which keeps only
// the tree it was reached from. A reload or a Forward of it is then an ordinary visit with a way back.
export function settleTreeVisit() {
  const { [WENT_THROUGH]: wentThrough, [CAME_FROM]: cameFrom, ...state } = window.history.state ?? {};
  if (!wentThrough && !cameFrom?.view) return;
  window.history.replaceState(cameFrom ? { ...state, [CAME_FROM]: { treeId: cameFrom.treeId } } : state, '');
}

const deviceTrees = new LocalTreeRegistry();

// The room's side of it. `arrival` is what the entry said as the room opened, and `holder` who holds this room as its
// owner (`useRoomHolder`), or null. Without a holder the entry is not acted on: no way back, no carried view or step, no
// door into a tree and nothing said. `open` goes into a tree from the door that offered it, off the tree and the view the
// room stands on at that moment, and `back` is the chip's press. Every event says where the holder acts (`place`).
export function useTreeVisit({ room, arrival, holder, band, registry = deviceTrees, track = beacon }) {
  useEffect(settleTreeVisit, []);

  const returned = holder !== null && arrival.door === 'back';
  const saidBack = useRef(false);
  useEffect(() => {
    if (!returned || saidBack.current) return;
    saidBack.current = true;
    track('roadmap_tree_back', { band, place: holder.place });
  }, [returned]);

  const open = useCallback((id, door) => {
    if (!TREE_DOORS.includes(door)) throw new Error(`unknown tree door "${door}"`);
    const tree = room.standingTreeRef.current;
    if (!tree) return false;
    const stepId = door === 'guide' ? null : id;
    const opening = tree.nodesById.get(stepId)?.opening;
    const treeId = door === 'guide' ? id : opening?.leads ? opening.treeId : null;
    if (typeof treeId !== 'string' || treeId === tree.treeId) return false;
    const view = room.viewRef.current;
    track('roadmap_tree_open', { door, view: view === 'board' ? 'board' : 'graph', band, place: holder.place });
    // The way back reads this roadmap's row in the device's index, which its session may not have written yet.
    registry.touch(tree.treeId, tree.title, holder.account);
    enterTree(treeId, { from: tree.treeId, stepId, view });
    return true;
  }, [room, band, holder]);
  const back = useCallback(() => window.history.back(), []);

  const from = useMemo(() => {
    if (!holder || !arrival.from) return null;
    if (holder.place === 'account') return registry.owned(arrival.from, holder.account);
    const row = registry.onDevice(arrival.from);
    return row?.title ? { id: row.id, title: row.title } : null;
  }, [holder, arrival.from]);
  if (!holder) return { from: null, through: null, view: null, door: null, open: null, back };
  return { from, through: arrival.through, view: arrival.view, door: arrival.door, open, back };
}
