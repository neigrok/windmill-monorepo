// Every edit funnels through one commit seam — fresh ref, render, persist — and the sub-task
// gauges ride out to the scene as arcs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceStore } from '../../persistence/WorkspaceStore.js';
import {
  emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask,
  setNote, addLink, deleteLink,
} from '../../model/NodeWorkspace.js';

const workspaceStore = new WorkspaceStore();

export function useWorkspace({ seedRef, sceneRef }) {
  const [workspaceByNode, setWorkspaceByNode] = useState(() => ({})); // { nodeId: workspace } — sub-tasks, note, links
  const workspaceByNodeRef = useRef({}); // nodeId → workspace; the fresh read for arc pushes + persistence

  useEffect(() => { workspaceByNodeRef.current = workspaceByNode; }, [workspaceByNode]);

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

  // The one seam every workspace edit funnels through: fresh ref, render, persist.
  const commitWorkspace = useCallback((nodeId, nextWs) => {
    const nextMap = { ...workspaceByNodeRef.current, [nodeId]: nextWs };
    workspaceByNodeRef.current = nextMap;
    setWorkspaceByNode(nextMap);
    persistWorkspace(nextMap);
  }, [persistWorkspace]);

  const onAddSubtask = useCallback((nodeId, label) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addSubtask(current, label));
    pushArcs();
  }, [commitWorkspace, pushArcs]);

  // A check moves only the gauge: the step's progress is the person's own Complete, never the checklist's.
  const onToggleSubtask = useCallback((nodeId, subtaskId) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, toggleSubtask(current, subtaskId));
    pushArcs();
  }, [commitWorkspace, pushArcs]);

  const onEditSubtask = useCallback((nodeId, subtaskId, label) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, editSubtask(current, subtaskId, label));
  }, [commitWorkspace]);

  const onDeleteSubtask = useCallback((nodeId, subtaskId) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteSubtask(current, subtaskId));
    pushArcs();
  }, [commitWorkspace, pushArcs]);

  const onSetNote = useCallback((nodeId, markdown) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, setNote(current, markdown));
  }, [commitWorkspace]);

  const onAddLink = useCallback((nodeId, rawUrl) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addLink(current, rawUrl));
  }, [commitWorkspace]);

  const onDeleteLink = useCallback((nodeId, linkId) => {
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteLink(current, linkId));
  }, [commitWorkspace]);

  return {
    workspaceByNode,
    hydrateWorkspaces,
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
