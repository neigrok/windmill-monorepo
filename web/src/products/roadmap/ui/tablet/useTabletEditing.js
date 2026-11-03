import { useCallback, useEffect, useState } from 'react';
import { illegalTargets, edgeFor } from './aim.js';

// One surface at a time: bulk bar, then aim bar, then remove-link bar, then the selection editor.
export function activeSurface({ multiMode, aim, removing, selectedNode }) {
  if (multiMode) return 'bulk';
  if (aim) return 'aim';
  if (removing) return 'remove';
  if (selectedNode) return 'editor';
  return 'empty';
}

// The tablet owner's Graph: tap to connect, tap a link to remove it, hold to select several, and writes that say so in a toast.
export function useTabletEditing({ tabletEditor, scene, tree, nodesById, selectedNode, collabRef, editorRef, selection, editing, showToast }) {
  const { multiMode, selectedIdRef, setSelectedId, enterMulti, toggleMember } = selection;
  const { undo, handleRename, handleCreateChild, handleConnect, handleDeleteEdge, handleSetKind } = editing;
  const [aim, setAim] = useState(null); // { sourceId, direction: 'unlocks'|'needs' } | null
  const [removing, setRemoving] = useState(null); // { from, to } | null

  const stopEditing = useCallback(() => {
    setAim(null);
    setRemoving(null);
  }, []);

  const removeLink = useCallback(() => {
    const { from, to } = removing;
    handleDeleteEdge(from, to);
    setRemoving(null);
    showToast('Link removed', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'AddEdge', from, to }) }, duration: 4000 });
  }, [removing, handleDeleteEdge, showToast]);

  const renameStep = useCallback((id, label) => {
    const node = editorRef.current?.treeData.nodes.find((n) => n.id === id);
    const wasNamed = node && node.label.trim() !== '' && node.label !== label;
    handleRename(id, label);
    if (wasNamed) showToast('Renamed', { action: { label: 'Undo', run: undo }, duration: 4000 });
  }, [handleRename, showToast, undo]);

  const recolorStep = useCallback((id, kind) => {
    handleSetKind(id, kind);
    showToast('Recolored', { action: { label: 'Undo', run: undo }, duration: 4000 });
  }, [handleSetKind, showToast, undo]);

  // The undo must delete THIS bud, not pop the stack: naming it dispatches a RenameNode on top.
  const addStepUnder = useCallback((parentId) => {
    const newId = handleCreateChild(parentId);
    if (!newId) return;
    showToast('Step added', {
      action: { label: 'Undo', run: () => {
        collabRef.current?.dispatch({ kind: 'DeleteNode', id: newId });
        if (selectedIdRef.current === newId) setSelectedId(null);
      } },
      duration: 4000,
    });
  }, [handleCreateChild, showToast]);

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
        handleConnect(from, to);
        setAim(null);
        setSelectedId(aim.sourceId);
        showToast('Linked', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'RemoveEdge', from, to }) }, duration: 4000 });
        return;
      }
      if (nodeId) { setRemoving(null); setSelectedId(nodeId); return; }
      const edge = scene.pickEdge(x, y);
      if (edge) { setAim(null); setSelectedId(null); setRemoving({ from: edge.from, to: edge.to }); return; }
      setSelectedId(null);
    });
    return () => scene.setEditTap(null);
  }, [scene, tabletEditor, multiMode, aim, tree, nodesById, handleConnect, showToast, setSelectedId, toggleMember]);

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
