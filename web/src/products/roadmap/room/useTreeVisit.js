// Going into another tree and the way back. Down into the subtree a step owns and up to that step, for anyone who reads
// the tree; down into the tree a step's pointer names, or up into a tree whose guide stands above this one, for the
// holder of both. Going in rides history entries and never tree data: the entry of the tree gone into names the tree the
// person came from, and the entry they left names the step they went through, or none for a way up, and whether that
// step owns the tree. So a chain pops one tree per press, and the browser's Back reads what the chip reads. A pointer's
// way back is that history alone, so a direct link has none; a subtree's is where it sits, so even a link to it leads up
// to its owning step. An entry outlives a sign-out, so it holds ids alone: a pointer's way back is shown only to whoever
// holds the tree it leads to, under the title this device's index keeps for them: the account's own row, or the row of a
// tree that lives only here. A subtree's is named by the tree read itself.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { navigate } from '../../../shell/navigation.js';
import { track as beacon } from '../../../telemetry/beacon.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';

// The room's `open(id, door)` for every surface that shows the way into a tree; null where no tree can be gone into.
export const TreeDoor = createContext(null);

// Every surface that offers the way into a tree, as `roadmap_tree_open` and `roadmap_subtree_open` name it. The guide's
// door is given the tree above it leads to; every other door is given a step, and leads where that step's opening does.
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
// entry naming the tree it was reached from. `subtree` says the step owns the tree gone into, and `route` is the address
// family the room stands on: the app's, or a share's.
export function enterTree(treeId, { from, stepId, view, subtree = false, route = '#/app/' }) {
  window.history.replaceState({ ...window.history.state, [WENT_THROUGH]: { stepId, view, subtree } }, '');
  navigate(`${route}${treeId}`);
  window.history.replaceState({ ...window.history.state, [CAME_FROM]: { treeId: from, view, subtree } }, '');
}

// Up from a subtree reached any other way than through its owning step: its parent, with that step open, arrived at as a
// return through it is, in the view the person was in.
function climbTo({ treeId, stepId }, { view, route }) {
  navigate(`${route}${treeId}?step=${encodeURIComponent(stepId)}`);
  window.history.replaceState({ ...window.history.state, [WENT_THROUGH]: { stepId, view, subtree: true } }, '');
}

// What this history entry says of the visit: the tree the person came from, the step they went through before coming
// back, null for a way up through the guide, the view an arrival carries and whether the step gone through owns the tree.
// A returning entry's view wins, as it is the one they left this tree in.
export function readTreeVisit(state = window.history.state) {
  const cameFrom = typeof state?.[CAME_FROM]?.treeId === 'string' ? state[CAME_FROM] : null;
  const left = state?.[WENT_THROUGH];
  const wentThrough = left && (left.stepId === null || typeof left.stepId === 'string') ? left : null;
  const from = cameFrom?.treeId ?? null;
  if (wentThrough) return { from, through: wentThrough.stepId, view: viewOf(wentThrough), door: 'back', subtree: wentThrough.subtree === true };
  if (viewOf(cameFrom)) return { from, through: null, view: viewOf(cameFrom), door: 'tree', subtree: cameFrom.subtree === true };
  return { from, through: null, view: null, door: null, subtree: cameFrom?.subtree === true };
}

// An arrival is settled once: the step gone through and the view either side carried leave the entry, which keeps only
// the tree it was reached from and whether its step owns this tree. A reload or a Forward of it is then an ordinary visit
// with a way back.
export function settleTreeVisit() {
  const { [WENT_THROUGH]: wentThrough, [CAME_FROM]: cameFrom, ...state } = window.history.state ?? {};
  if (!wentThrough && !cameFrom?.view) return;
  window.history.replaceState(cameFrom ? { ...state, [CAME_FROM]: { treeId: cameFrom.treeId, subtree: cameFrom.subtree === true } } : state, '');
}

const deviceTrees = new LocalTreeRegistry();

// The room's side of it. `arrival` is what the entry said as the room opened; `holder` who holds this room as its owner
// (`useRoomHolder`), or null; `visitor` whether the room reads a tree that is not its own, demo aside, which lets it go
// into subtrees as a holder does; `place` where the tree sits, null until the server has said; `route` the address
// family it stands on and `role` whose room it is (`owner` or `reader`), null until the room has loaded and knows. A
// room that may go nowhere acts on nothing the entry says: no way back, no carried view or step, no door into a tree and
// nothing said; one that may go into subtrees alone acts only on an entry a subtree's door left. `open` goes into a tree
// from the door that offered it, off the tree and the view the room stands on at that moment, and `back` is the chip's
// press.
export function useTreeVisit({ room, arrival, holder, visitor = false, place = null, route = '#/app/', role = 'owner', band, registry = deviceTrees, track = beacon }) {
  useEffect(settleTreeVisit, []);
  const roams = holder !== null || visitor;
  const ours = arrival.subtree ? roams : holder !== null;

  // A return up from a subtree is said once the room knows whose it is.
  const returned = ours && arrival.door === 'back' && (!arrival.subtree || role !== null);
  const saidBack = useRef(false);
  useEffect(() => {
    if (!returned || saidBack.current) return;
    saidBack.current = true;
    if (arrival.subtree) track('roadmap_subtree_back', { band, role });
    else track('roadmap_tree_back', { band, place: holder.place });
  }, [returned]);

  const open = useCallback((id, door) => {
    if (!TREE_DOORS.includes(door)) throw new Error(`unknown tree door "${door}"`);
    const tree = room.standingTreeRef.current;
    if (!tree) return false;
    const stepId = door === 'guide' ? null : id;
    const opening = tree.nodesById.get(stepId)?.opening;
    const view = room.viewRef.current;
    const shown = view === 'board' ? 'board' : 'graph';
    if (opening?.owned) {
      track('roadmap_subtree_open', { door, view: shown, band, role });
      enterTree(opening.treeId, { from: tree.treeId, stepId, view, subtree: true, route });
      return true;
    }
    if (holder === null) return false;
    const treeId = door === 'guide' ? id : opening?.leads ? opening.treeId : null;
    if (typeof treeId !== 'string' || treeId === tree.treeId) return false;
    track('roadmap_tree_open', { door, view: shown, band, place: holder.place });
    // The way back reads this roadmap's row in the device's index, which its session may not have written yet. A subtree
    // is no row of it: its own way back is where it sits.
    if (!place?.subtree) registry.touch(tree.treeId, tree.title, holder.account);
    enterTree(treeId, { from: tree.treeId, stepId, view });
    return true;
  }, [room, band, holder, role, route, place]);

  // A subtree's way back leads up to its owning step: back through the history where the person came down that step,
  // else to its parent with that step open.
  const up = roams ? place?.up ?? null : null;
  const back = useCallback(() => {
    if (up && !(arrival.subtree && arrival.from === up.treeId)) {
      climbTo(up, { view: room.viewRef.current, route });
      return;
    }
    window.history.back();
  }, [up, arrival, route]);

  const from = useMemo(() => {
    if (up) return { id: up.treeId, title: up.title };
    if (!holder || !arrival.from || arrival.subtree) return null;
    if (holder.place === 'account') return registry.owned(arrival.from, holder.account);
    const row = registry.onDevice(arrival.from);
    return row?.title ? { id: row.id, title: row.title } : null;
  }, [holder, arrival.from, arrival.subtree, up]);
  if (!roams) return { from: null, through: null, view: null, door: null, open: null, back };
  if (!ours) return { from, through: null, view: null, door: null, open, back };
  return { from, through: arrival.through, view: arrival.view, door: arrival.door, open, back };
}
