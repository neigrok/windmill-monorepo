import { useCallback } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { graftPlan } from '../paste/graftPlan.js';
import { parseEdgeKey } from '../scene/edgeKey.js';

const NEW_NODE_ICON = 'sparkles';

// The canvas, the dock and the tablet panel have no form to report from, so each write names what it changed.
function trackEdit(changed) {
  track('roadmap_board_edit', { step: 'saved', view: 'graph', name: false, description: false, kind: false, prerequisites: false, order: false, ...changed });
}

// Every write the Graph's own surfaces make: the scene's gestures, the docks and the tablet panel all come through here.
export function useGraphEditing({ collabRef, editorRef, sceneRef, treeRef, legendRef, desktopEditorRef, selection, emit, showToast, setAutoFocusNameId, setComposerOpen }) {
  const { selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, leaveMulti } = selection;

  const undo = useCallback(() => collabRef.current?.undo(), []);
  const redo = useCallback(() => collabRef.current?.redo(), []);

  const handleRename = useCallback((id, label) => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return;
    const wasNamed = node.label.trim() !== '';
    collabRef.current?.dispatch({ kind: 'RenameNode', id, label });
    if (wasNamed) emit({ verb: 'renamed', nodeId: id, label, kind: node.color });
    trackEdit({ name: true });
  }, [emit]);

  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const editor = editorRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !editor) return;

    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId });
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
    track('roadmap_board_create', { step: 'saved', door: 'canvas', view: 'graph' });
    return id;
  }, [setSelectedId, emit]);

  const handleCreateRoot = useCallback(() => {
    if (!desktopEditorRef.current) return;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const color = legendRef.current[0]?.hue ?? 'terracotta';
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color });
    sceneRef.current?.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: color });
    track('roadmap_board_create', { step: 'saved', door: 'empty', view: 'graph' });
  }, [emit, setSelectedId]);

  const handleConnect = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'AddEdge', from: sourceId, to: targetId });
    trackEdit({ prerequisites: true });
  }, []);

  const handleDeleteEdge = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'RemoveEdge', from: sourceId, to: targetId });
    trackEdit({ prerequisites: true });
  }, []);

  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    collabRef.current?.dispatch({ kind: 'ReconnectEdge', oldFrom, oldTo, newFrom, newTo });
    trackEdit({ prerequisites: true });
  }, []);

  const deleteNodeAt = useCallback((id) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    collabRef.current?.dispatch({ kind: 'DeleteNode', id });
    if (selectedIdRef.current === id) setSelectedId(null);
    showToast('Step deleted', { action: { label: 'Undo', run: undo } });
    emit({ verb: 'removed', nodeId: id, label: node?.label, kind: node?.color });
    track('roadmap_board_delete', { step: 'sent', via: 'direct', view: 'graph' });
  }, [emit, showToast, undo]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  // Labels must be snapshotted BEFORE dispatch: the projection drops the doomed nodes synchronously.
  const bulkDelete = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    const edges = [...selectedEdgesRef.current].map(parseEdgeKey); // {from,to}
    if (!ids.length && !edges.length) return;
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const doomed = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    collabRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: ids, edges });
    for (const node of doomed) emit({ verb: 'removed', nodeId: node.id, label: node.label, kind: node.color });
    leaveMulti();
    const parts = [];
    if (ids.length) parts.push(`${ids.length} step${ids.length === 1 ? '' : 's'}`);
    if (edges.length) parts.push(`${edges.length} link${edges.length === 1 ? '' : 's'}`);
    showToast(`${parts.join(' and ')} deleted`, { action: { label: 'Undo', run: undo } });
    track('roadmap_board_bulk', { step: 'delete', count: countBucket(ids.length), view: 'graph' });
  }, [emit, showToast, undo, leaveMulti]);

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeColor', id, color: kind });
    trackEdit({ kind: true });
  }, []);

  // Same-parent siblings in sort order with their order keys; null off-tree.
  const reorderContext = useCallback((nodeId) => {
    const tree = treeRef.current;
    if (!tree || !tree.nodesById.has(nodeId)) return null;
    const parentId = tree.trunk.primaryParentOf(nodeId);
    const siblingIds = parentId === null
      ? [...tree.roots()].sort(cmpOrder).map((root) => root.id)
      : tree.trunk.trunkChildrenOf(parentId);
    return { siblings: siblingIds.map((id) => ({ id, order: tree.nodesById.get(id)?.order ?? '' })) };
  }, []);

  const handleSetNodeOrder = useCallback((id, order) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeOrder', id, order });
    trackEdit({ order: true });
  }, []);

  const bulkRecolor = useCallback((color, { silent = false } = {}) => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    collabRef.current?.dispatch({ kind: 'BulkRecolor', nodeIds: ids, color });
    if (!silent) showToast(`${ids.length} step${ids.length === 1 ? '' : 's'} recolored`, { action: { label: 'Undo', run: undo } });
    track('roadmap_board_bulk', { step: 'recolor', count: countBucket(ids.length), view: 'graph' });
  }, [showToast, undo]);

  // onTreeChanged re-lays out synchronously, so grafted nodes are seated before they are pulsed.
  const graftImported = useCallback((parse) => {
    const editor = editorRef.current;
    const collab = collabRef.current;
    if (!editor || !collab) return;
    const nodes = editor.treeData.nodes;
    const selected = selectedIdRef.current;
    const anchored = selected && nodes.some((node) => node.id === selected);
    const targetId = (anchored ? selected : nodes.find((node) => node.prerequisites.length === 0)?.id) ?? null;

    const graft = graftPlan({
      parse,
      targetId,
      reservedNodeIds: collab.knownNodeIds(), // present AND tombstoned: never resurrect a deleted node
      liveKinds: legendRef.current,
    });
    if (graft.nodes.length === 0) { setComposerOpen(false); return; }

    collab.dispatch({ kind: 'ImportSubgraph', nodes: graft.nodes, edges: graft.edges, kinds: graft.kinds });

    for (const grafted of graft.nodes) {
      emit({ verb: 'added', nodeId: grafted.id, label: grafted.label, kind: grafted.color }, { silent: true });
      sceneRef.current?.pulseNode(grafted.id);
    }
    const count = graft.nodes.length;
    const targetLabel = targetId ? (nodes.find((node) => node.id === targetId)?.label || 'the tree') : null;
    const where = targetLabel ? ` under “${targetLabel}”` : '';
    showToast(`Added ${count} step${count === 1 ? '' : 's'}${where}`, { action: { label: 'Undo', run: undo } });
    setComposerOpen(false);
    track('roadmap_board_create', { step: 'saved', door: 'paste', view: 'graph', count: countBucket(count) });
  }, [emit, showToast, undo]);

  return {
    undo, redo, handleRename, handleCreateChild, handleCreateRoot, handleConnect, handleDeleteEdge, handleReconnect,
    deleteNodeAt, deleteSelected, bulkDelete, handleSetKind, reorderContext, handleSetNodeOrder, bulkRecolor, graftImported,
  };
}
