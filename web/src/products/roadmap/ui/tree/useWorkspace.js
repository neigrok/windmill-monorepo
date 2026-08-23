// Every edit funnels through one commit seam — fresh ref, render, persist — and the sub-task
// gauges ride out to the scene as arcs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceStore } from '../../persistence/WorkspaceStore.js';
import {
  emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask,
  setNote, addLink, deleteLink,
} from '../../model/NodeWorkspace.js';

const workspaceStore = new WorkspaceStore();
const AUTO_COMPLETE_HOLD = 600; // held breath before auto-completing: arc-close 280 + hold 320

export function useWorkspace({ seedRef, sceneRef, completedRef, completeStepRef }) {
  const [workspaceByNode, setWorkspaceByNode] = useState(() => ({})); // { nodeId: workspace } — sub-tasks, note, links
  const workspaceByNodeRef = useRef({}); // nodeId → workspace; the fresh read for arc pushes + persistence
  const pendingCompleteRef = useRef(new Map()); // nodeId → auto-complete timer awaiting its held breath

  useEffect(() => { workspaceByNodeRef.current = workspaceByNode; }, [workspaceByNode]);
  useEffect(() => () => pendingCompleteRef.current.forEach(clearTimeout), []);

  const persistWorkspace = useCallback((byNode) => {
    if (!seedRef.current) return;
    workspaceStore.save(seedRef.current.id, byNode);
  }, [seedRef]);

  // Nodes absent from the map mean no arc. Reads the fresh ref, so it can fire right after a commit.
  const pushArcs = useCallback(() => {
    const arcs = new Map();
    for (const [nodeId, ws] of Object.entries(workspaceByNodeRef.current)) {
      const fraction = arcFraction(ws);
      if (fraction !== null) arcs.set(nodeId, fraction);
    }
    sceneRef.current?.setArcs?.(arcs);
  }, [sceneRef]);

  // Seats the saved workspaces for a freshly-loaded tree; the caller pushes the arcs once the model is applied.
  const hydrateWorkspaces = useCallback((treeId) => {
    const saved = workspaceStore.load(treeId) ?? {};
    workspaceByNodeRef.current = saved;
    setWorkspaceByNode(saved);
  }, []);

  const clearWorkspaceStore = useCallback((treeId) => workspaceStore.clear(treeId), []);

  const cancelAutoComplete = useCallback((nodeId) => {
    const timer = pendingCompleteRef.current.get(nodeId);
    if (!timer) return;
    clearTimeout(timer);
    pendingCompleteRef.current.delete(nodeId);
  }, []);

  const cancelAllAutoCompletes = useCallback(() => {
    pendingCompleteRef.current.forEach(clearTimeout);
    pendingCompleteRef.current.clear();
  }, []);

  // The one seam every workspace edit funnels through: fresh ref, render, persist.
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

  // A check that closes the gauge holds a breath, then runs the completion beat; any other
  // workspace edit cancels the timer.
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
