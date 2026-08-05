// A step's own workspace (F13), over the pure model/NodeWorkspace.js: the sub-tasks, the note
// and the links hanging off each node, keyed by node id. Every edit funnels through one commit
// seam — fresh ref, render, persist — and the sub-task gauges ride out to the scene as arcs.
//
// The auto-complete breath lives here because only a check ever schedules it and every other
// workspace edit calls it off (§4.3). Landing the completion is NOT ours: the view hands in
// completeStepRef and the timer fires the freshest one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceStore } from '../../persistence/WorkspaceStore.js';
import {
  emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask,
  setNote, addLink, deleteLink,
} from '../../model/NodeWorkspace.js';

const workspaceStore = new WorkspaceStore();
const AUTO_COMPLETE_HOLD = 600; // held breath before auto-completing: arc-close 280 + hold 320 (§4)

export function useWorkspace({ seedRef, sceneRef, completedRef, completeStepRef }) {
  const [workspaceByNode, setWorkspaceByNode] = useState(() => ({})); // { nodeId: workspace } — sub-tasks, note, links
  const workspaceByNodeRef = useRef({}); // nodeId → workspace; the fresh read for arc pushes + persistence
  const pendingCompleteRef = useRef(new Map()); // nodeId → auto-complete timer awaiting its held breath

  useEffect(() => { workspaceByNodeRef.current = workspaceByNode; }, [workspaceByNode]);
  useEffect(() => () => pendingCompleteRef.current.forEach(clearTimeout), []);

  // Durable per-node workspaces: callers pass the freshly-computed map, since the state
  // setter is async.
  const persistWorkspace = useCallback((byNode) => {
    if (!seedRef.current) return;
    workspaceStore.save(seedRef.current.id, byNode);
  }, [seedRef]);

  // The arc feed (§3): hand the scene a fraction for every node whose workspace has
  // sub-tasks (nodes absent = no arc). Reads the fresh ref, so it can fire right after
  // a commit. The scene caches these and re-applies them across model rebuilds.
  const pushArcs = useCallback(() => {
    const arcs = new Map();
    for (const [nodeId, ws] of Object.entries(workspaceByNodeRef.current)) {
      const fraction = arcFraction(ws);
      if (fraction !== null) arcs.set(nodeId, fraction);
    }
    sceneRef.current?.setArcs?.(arcs);
  }, [sceneRef]);

  // The load pipeline seats the saved workspaces for a freshly-loaded tree; the caller
  // pushes the arcs once the model is applied.
  const hydrateWorkspaces = useCallback((treeId) => {
    const saved = workspaceStore.load(treeId) ?? {};
    workspaceByNodeRef.current = saved;
    setWorkspaceByNode(saved);
  }, []);

  const clearWorkspaceStore = useCallback((treeId) => workspaceStore.clear(treeId), []);

  // Any workspace change on a node calls off a pending auto-complete for it (§4) —
  // an uncheck, a note edit, a link, all count as "the user is still working".
  const cancelAutoComplete = useCallback((nodeId) => {
    const timer = pendingCompleteRef.current.get(nodeId);
    if (!timer) return;
    clearTimeout(timer);
    pendingCompleteRef.current.delete(nodeId);
  }, []);

  // Reset edits drops every armed breath at once — the tree it was counting is going away.
  const cancelAllAutoCompletes = useCallback(() => {
    pendingCompleteRef.current.forEach(clearTimeout);
    pendingCompleteRef.current.clear();
  }, []);

  // The one seam every workspace edit funnels through: store the node's next
  // workspace (fresh ref for immediate reads), render it, and persist the map.
  const commitWorkspace = useCallback((nodeId, nextWs) => {
    const nextMap = { ...workspaceByNodeRef.current, [nodeId]: nextWs };
    workspaceByNodeRef.current = nextMap;
    setWorkspaceByNode(nextMap);
    persistWorkspace(nextMap);
  }, [persistWorkspace]);

  const onAddSubtask = useCallback((nodeId, label) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addSubtask(current, label));
    pushArcs();
  }, [cancelAutoComplete, commitWorkspace, pushArcs]);

  // A check can close the gauge: after the fraction is pushed, if every box is now
  // done and the node isn't already complete, hold a breath then run F1's completion
  // beat (bloom + unlocks). The timer is cancelable — a later change lands the
  // cancelAutoComplete above first. Sticky (§4.3): only a check ever schedules this.
  const onToggleSubtask = useCallback((nodeId, subtaskId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    const next = toggleSubtask(current, subtaskId);
    commitWorkspace(nodeId, next);
    pushArcs();
    const allDone = next.subtasks.length > 0 && next.subtasks.every((subtask) => subtask.done);
    if (!allDone || completedRef.current.has(nodeId)) return;
    const timer = setTimeout(() => {
      pendingCompleteRef.current.delete(nodeId);
      completeStepRef.current?.(nodeId);
    }, AUTO_COMPLETE_HOLD);
    pendingCompleteRef.current.set(nodeId, timer);
  }, [cancelAutoComplete, commitWorkspace, pushArcs, completedRef, completeStepRef]);

  const onEditSubtask = useCallback((nodeId, subtaskId, label) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, editSubtask(current, subtaskId, label));
  }, [cancelAutoComplete, commitWorkspace]);

  const onDeleteSubtask = useCallback((nodeId, subtaskId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteSubtask(current, subtaskId));
    pushArcs();
  }, [cancelAutoComplete, commitWorkspace, pushArcs]);

  const onSetNote = useCallback((nodeId, markdown) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, setNote(current, markdown));
  }, [cancelAutoComplete, commitWorkspace]);

  const onAddLink = useCallback((nodeId, rawUrl) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addLink(current, rawUrl));
  }, [cancelAutoComplete, commitWorkspace]);

  const onDeleteLink = useCallback((nodeId, linkId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteLink(current, linkId));
  }, [cancelAutoComplete, commitWorkspace]);

  return {
    workspaceByNode,
    hydrateWorkspaces,
    clearWorkspaceStore,
    cancelAllAutoCompletes,
    pushArcs,
    onAddSubtask,
    onToggleSubtask,
    onEditSubtask,
    onDeleteSubtask,
    onSetNote,
    onAddLink,
    onDeleteLink,
  };
}
