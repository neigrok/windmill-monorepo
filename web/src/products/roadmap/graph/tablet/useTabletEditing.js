import { useCallback, useEffect, useState } from 'react';
import { illegalTargets, edgeFor } from './aim.js';
import { GRAPH_TOAST } from '../../copy.js';

// One surface at a time: bulk bar, then aim bar, then remove-link bar, then the selection editor.
export function activeSurface({ multiMode, aim, removing, selectedNode }) {
  if (multiMode) return 'bulk';
  if (aim) return 'aim';
  if (removing) return 'remove';
  if (selectedNode) return 'editor';
  return 'empty';
}

// The tablet owner's Graph: tap to connect, tap a link to remove it, hold to select several; each write offers its own Undo.
export function useTabletEditing({ tabletEditor, scene, tree, nodesById, selectedNode, projectionRef, selection, editing }) {
  const { multiMode, selectedIdRef, setSelectedId, enterMulti, toggleMember } = selection;
  const { announce, handleRename, handleCreateChild, handleConnect, handleDeleteEdge, handleSetKind } = editing;
  const [aim, setAim] = useState(null); // { sourceId, direction: 'unlocks'|'needs' } | null
  const [removing, setRemoving] = useState(null); // { from, to } | null

  const stopEditing = useCallback(() => {
    setAim(null);
    setRemoving(null);
  }, []);

  const removeLink = useCallback(() => {
    const { from, to } = removing;
    setRemoving(null);
    announce(handleDeleteEdge(from, to), 'link_remove', GRAPH_TOAST.linkRemoved);
  }, [removing, handleDeleteEdge, announce]);

  // Naming a new step is part of adding it; only a real rename says so.
  const renameStep = useCallback((id, label) => {
    const named = projectionRef.current?.nodes.find((n) => n.id === id)?.label.trim();
    const written = handleRename(id, label);
    if (named) announce(written, 'rename', GRAPH_TOAST.renamed);
  }, [handleRename, announce]);

  const recolorStep = useCallback((id, kind) => {
    announce(handleSetKind(id, kind), 'recolor', GRAPH_TOAST.recolored);
  }, [handleSetKind, announce]);

  const addStepUnder = useCallback((parentId) => {
    const added = handleCreateChild(parentId);
    announce(added, 'add', GRAPH_TOAST.stepAdded, () => {
      if (selectedIdRef.current === added.id) setSelectedId(null);
    });
  }, [handleCreateChild, announce]);

  const enterAim = useCallback((sourceId) => {
    setRemoving(null);
    setAim({ sourceId, direction: 'unlocks' });
  }, []);

  const flipAimDirection = useCallback(() => {
    setAim((current) => (current ? { ...current, direction: current.direction === 'unlocks' ? 'needs' : 'unlocks' } : current));
  }, []);

  useEffect(() => {
    if (!scene) return undefined;
    if (!tabletEditor) { scene.setEditTap(null); return undefined; }
    scene.setEditTap((x, y, nodeId) => {
      if (multiMode) {
        toggleMember(nodeId);
        return;
      }
      if (aim && tree && nodesById.has(aim.sourceId)) {
        if (nodeId === null) { setAim(null); return; }
        if (illegalTargets(tree, aim.sourceId, aim.direction).has(nodeId)) return;
        const { from, to } = edgeFor(aim.sourceId, nodeId, aim.direction);
        const written = handleConnect(from, to);
        setAim(null);
        setSelectedId(aim.sourceId);
        announce(written, 'link_add', GRAPH_TOAST.linked);
        return;
      }
      if (nodeId) { setRemoving(null); setSelectedId(nodeId); return; }
      const edge = scene.pickEdge(x, y);
      if (edge) { setAim(null); setSelectedId(null); setRemoving({ from: edge.from, to: edge.to }); return; }
      setSelectedId(null);
    });
    return () => scene.setEditTap(null);
  }, [scene, tabletEditor, multiMode, aim, tree, nodesById, handleConnect, announce, setSelectedId, toggleMember]);

  useEffect(() => {
    if (!scene) return undefined;
    if (!tabletEditor) { scene.setLongPress(null); return undefined; }
    scene.setLongPress((id) => {
      if (!id) return;
      setAim(null);
      setRemoving(null);
      enterMulti(id);
    });
    return () => scene.setLongPress(null);
  }, [scene, tabletEditor, enterMulti]);

  useEffect(() => {
    if (aim && tree && !nodesById.has(aim.sourceId)) setAim(null);
  }, [aim, tree, nodesById]);

  useEffect(() => {
    if (!scene || !aim || !tree || !nodesById.has(aim.sourceId)) return undefined;
    const illegal = illegalTargets(tree, aim.sourceId, aim.direction);
    illegal.delete(aim.sourceId); // never dim the anchor
    scene.setFaded(illegal);
    return () => scene.clearFaded();
  }, [scene, aim, tree, nodesById]);

  return {
    aim, removing, stopEditing, setAim, setRemoving, surface: activeSurface({ multiMode, aim, removing, selectedNode }),
    renameStep, recolorStep, addStepUnder, enterAim, flipAimDirection, removeLink,
  };
}
