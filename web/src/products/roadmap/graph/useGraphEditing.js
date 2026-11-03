import { useCallback, useEffect, useMemo, useState } from 'react';
import { cmpOrder } from '../model/TrunkTree.js';
import { graftPlan } from '../paste/graftPlan.js';
import { parsePlan } from '../paste/planGrammar.js';
import { parseEdgeKey } from '../scene/edgeKey.js';
import { receiptUndo } from '../board/acts.js';
import { GRAPH_TOAST, deletedSelectionToast, graftedToast, recoloredToast } from '../copy.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { track } from '../../../telemetry/beacon.js';

const NEW_NODE_ICON = 'sparkles';

// Every write the Graph's own surfaces make; a write returns what `announce` needs for its own Undo, or null when nothing took.
export function useGraphEditing({ room, legendRef, desktopEditorRef, selection, emit, showToast }) {
  const { sessionRef, projectionRef, sceneRef, treeRef } = room;
  const { selectedId, selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, leaveMulti } = selection;
  const [autoFocusNameId, setAutoFocusNameId] = useState(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  // bindOnly: an unmatched heading mints a fresh hue rather than renaming an existing kind.
  const draftParse = useMemo(() => (composerOpen ? parsePlan(draft, draftKinds, { bindOnly: true }) : null), [composerOpen, draft, draftKinds]);
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  const openComposer = useCallback((text) => {
    setDraftKinds(legendRef.current);
    setDraft(text);
    setComposerOpen(true);
  }, []);

  useEffect(() => {
    if (autoFocusNameId && selectedId !== autoFocusNameId) setAutoFocusNameId(null);
  }, [selectedId, autoFocusNameId]);

  const undo = useCallback(() => sessionRef.current?.undo(), []);
  const redo = useCallback(() => sessionRef.current?.redo(), []);

  const write = useCallback((gesture) => {
    const session = sessionRef.current;
    const receipt = session?.dispatch(gesture) ?? null;
    return receipt && { session, receipt };
  }, []);

  const announce = useCallback((written, act, message, onReverted) => {
    if (!written) return;
    showToast(message, {
      surface: 'graph', act,
      action: receiptUndo({
        session: written.session,
        receipt: written.receipt,
        onReverted: () => {
          onReverted?.();
          track('roadmap_graph_toast', { act, step: 'undo' });
        },
        onFailure: (error) => reportRoadmapFailure('roadmap-graph-undo', error),
      }),
    });
    track('roadmap_graph_toast', { act, step: 'shown' });
  }, [showToast]);

  const handleRename = useCallback((id, label) => {
    const node = projectionRef.current?.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return null;
    const written = write({ kind: 'RenameNode', id, label });
    if (written && node.label.trim() !== '') emit({ verb: 'renamed', nodeId: id, label, kind: node.color });
    return written;
  }, [emit]);

  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !projectionRef.current) return null;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const written = write({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId });
    if (!written) return null;
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
    return { id, ...written };
  }, [setSelectedId, emit]);

  const handleCreateRoot = useCallback(() => {
    if (!desktopEditorRef.current) return;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const color = legendRef.current[0]?.hue ?? 'terracotta';
    if (!write({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color })) return;
    sceneRef.current?.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: color });
  }, [emit, setSelectedId]);

  const handleConnect = useCallback((sourceId, targetId) => write({ kind: 'AddEdge', from: sourceId, to: targetId }), []);

  const handleDeleteEdge = useCallback((sourceId, targetId) => write({ kind: 'RemoveEdge', from: sourceId, to: targetId }), []);

  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    write({ kind: 'ReconnectEdge', oldFrom, oldTo, newFrom, newTo });
  }, []);

  const deleteNodeAt = useCallback((id) => {
    const node = projectionRef.current?.nodes.find((n) => n.id === id);
    if (!node) return;
    const written = write({ kind: 'DeleteNode', id });
    if (!written) return;
    if (selectedIdRef.current === id) setSelectedId(null);
    announce(written, 'delete', GRAPH_TOAST.stepDeleted);
    emit({ verb: 'removed', nodeId: id, label: node.label, kind: node.color });
  }, [emit, announce]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  // Labels must be snapshotted BEFORE dispatch: the projection drops the doomed nodes synchronously.
  const bulkDelete = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    const edges = [...selectedEdgesRef.current].map(parseEdgeKey); // {from,to}
    if (!ids.length && !edges.length) return;
    const nodes = projectionRef.current?.nodes ?? [];
    const doomed = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    const written = write({ kind: 'BulkDelete', nodeIds: ids, edges });
    if (!written) return;
    for (const node of doomed) emit({ verb: 'removed', nodeId: node.id, label: node.label, kind: node.color });
    leaveMulti();
    announce(written, 'delete', deletedSelectionToast({ steps: ids.length, links: edges.length }));
  }, [emit, announce, leaveMulti]);

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return null;
    return write({ kind: 'SetNodeColor', id, color: kind });
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
    if (id) write({ kind: 'SetNodeOrder', id, order });
  }, []);

  const bulkRecolor = useCallback((color, { silent = false } = {}) => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    const written = write({ kind: 'BulkRecolor', nodeIds: ids, color });
    if (!silent) announce(written, 'recolor', recoloredToast({ count: ids.length }));
  }, [announce]);

  // onTreeChanged re-lays out synchronously, so grafted nodes are seated before they are pulsed.
  const graftImported = useCallback((parse) => {
    const nodes = projectionRef.current?.nodes;
    const session = sessionRef.current;
    if (!nodes || !session) return;
    const selected = selectedIdRef.current;
    const anchored = selected && nodes.some((node) => node.id === selected);
    const targetId = (anchored ? selected : nodes.find((node) => node.prerequisites.length === 0)?.id) ?? null;

    const graft = graftPlan({
      parse,
      targetId,
      reservedNodeIds: session.knownNodeIds(), // present AND tombstoned: never resurrect a deleted node
      liveKinds: legendRef.current,
    });
    if (graft.nodes.length === 0) {
      setComposerOpen(false);
      return;
    }

    const written = write({ kind: 'ImportSubgraph', nodes: graft.nodes, edges: graft.edges, kinds: graft.kinds });
    if (!written) return;

    for (const grafted of graft.nodes) {
      emit({ verb: 'added', nodeId: grafted.id, label: grafted.label, kind: grafted.color }, { silent: true });
      sceneRef.current?.pulseNode(grafted.id);
    }
    const under = targetId ? (nodes.find((node) => node.id === targetId)?.label || 'the tree') : null;
    announce(written, 'graft', graftedToast({ count: graft.nodes.length, under }));
    setComposerOpen(false);
  }, [emit, announce]);

  return {
    autoFocusNameId, composerOpen, draft, setDraft, draftKinds, setDraftKinds, draftParse, closeComposer, openComposer,
    undo, redo, announce, handleRename, handleCreateChild, handleCreateRoot, handleConnect, handleDeleteEdge, handleReconnect,
    deleteNodeAt, deleteSelected, bulkDelete, handleSetKind, reorderContext, handleSetNodeOrder, bulkRecolor, graftImported,
  };
}
