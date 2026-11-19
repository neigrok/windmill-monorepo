// A step's workspace: on this device's own store every edit funnels through one commit seam — fresh ref, render,
// persist — and on the device's copy through the replica's workspace door; the sub-task gauges ride out to the scene
// as arcs.

import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkspaceStore } from '../../persistence/WorkspaceStore.js';
import {
  emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask,
  setNote, addLink, deleteLink,
} from '../../model/NodeWorkspace.js';

const workspaceStore = new WorkspaceStore();

export function useWorkspace({ seedRef, sceneRef, treeRef, replicaRef }) {
  const [workspaceByNode, setWorkspaceByNode] = useState(() => ({})); // { nodeId: workspace } — sub-tasks, note, links
  const workspaceByNodeRef = useRef({}); // nodeId → workspace; the fresh read for arc pushes + persistence

  useEffect(() => { workspaceByNodeRef.current = workspaceByNode; }, [workspaceByNode]);

  const persistWorkspace = useCallback((byNode) => {
    if (!seedRef.current) return;
    workspaceStore.save(seedRef.current.id, byNode);
  }, [seedRef]);

  // Nodes absent from the map mean no arc. Reads the fresh ref, so it can fire right after a commit. A step that opens a
  // tree gauges that tree in place of its sub-tasks, and draws none where there is nothing to count.
  const pushArcs = useCallback(() => {
    const arcs = new Map();
    for (const [nodeId, ws] of Object.entries(workspaceByNodeRef.current)) {
      const fraction = arcFraction(ws);
      if (fraction !== null) arcs.set(nodeId, fraction);
    }
    for (const step of treeRef.current?.nodes ?? []) {
      if (!step.opening) continue;
      if (step.opening.gauge === null) arcs.delete(step.id);
      else arcs.set(step.id, step.opening.gauge);
    }
    sceneRef.current?.setArcs?.(arcs);
  }, [sceneRef, treeRef]);

  // Seats the saved workspaces for a freshly-loaded tree; the caller pushes the arcs once the model is applied.
  const hydrateWorkspaces = useCallback((treeId) => {
    const saved = workspaceStore.load(treeId) ?? {};
    workspaceByNodeRef.current = saved;
    setWorkspaceByNode(saved);
  }, []);

  // Seats the workspaces the replica holds, as it holds them now; the caller pushes the arcs.
  const adoptWorkspaces = useCallback((byNode) => {
    workspaceByNodeRef.current = byNode;
    setWorkspaceByNode(byNode);
  }, []);

  // The one seam every edit on this device's own store funnels through: fresh ref, render, persist.
  const commitWorkspace = useCallback((nodeId, nextWs) => {
    const nextMap = { ...workspaceByNodeRef.current, [nodeId]: nextWs };
    workspaceByNodeRef.current = nextMap;
    setWorkspaceByNode(nextMap);
    persistWorkspace(nextMap);
  }, [persistWorkspace]);

  // Where an edit goes: the replica's workspace door where the room reads the device's copy, whose overlay the room then
  // seats (none on a roadmap someone else owns), else this device's own store.
  const writes = useCallback(() => {
    if (replicaRef.current) return replicaRef.current.writes?.workspace ?? null;
    const edit = (change) => (nodeId, ...args) => commitWorkspace(nodeId, change(workspaceByNodeRef.current[nodeId] ?? emptyWorkspace(), ...args));
    return {
      addSubtask: edit(addSubtask), toggleSubtask: edit(toggleSubtask), editSubtask: edit(editSubtask), deleteSubtask: edit(deleteSubtask),
      setNote: edit(setNote), addLink: edit(addLink), deleteLink: edit(deleteLink),
    };
  }, [commitWorkspace]);

  // A check moves only the gauge: the step's progress is the person's own Complete, never the checklist's.
  const onAddSubtask = useCallback((nodeId, label) => { writes()?.addSubtask(nodeId, label); pushArcs(); }, [writes, pushArcs]);
  const onToggleSubtask = useCallback((nodeId, subtaskId) => { writes()?.toggleSubtask(nodeId, subtaskId); pushArcs(); }, [writes, pushArcs]);
  const onEditSubtask = useCallback((nodeId, subtaskId, label) => writes()?.editSubtask(nodeId, subtaskId, label), [writes]);
  const onDeleteSubtask = useCallback((nodeId, subtaskId) => { writes()?.deleteSubtask(nodeId, subtaskId); pushArcs(); }, [writes, pushArcs]);
  const onSetNote = useCallback((nodeId, markdown) => writes()?.setNote(nodeId, markdown), [writes]);
  const onAddLink = useCallback((nodeId, rawUrl) => writes()?.addLink(nodeId, rawUrl), [writes]);
  const onDeleteLink = useCallback((nodeId, linkId) => writes()?.deleteLink(nodeId, linkId), [writes]);

  return {
    workspaceByNode,
    hydrateWorkspaces,
    adoptWorkspaces,
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
