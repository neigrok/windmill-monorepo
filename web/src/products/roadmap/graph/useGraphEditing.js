import { useCallback, useEffect, useMemo, useState } from 'react';
import { cmpOrder } from '../model/TrunkTree.js';
import { graftPlan } from '../paste/graftPlan.js';
import { parsePlan } from '../paste/planGrammar.js';
import { parseEdgeKey } from '../scene/edgeKey.js';
import { onceLanded, receiptUndo } from '../board/acts.js';
import { readEffects } from '../model/effects.js';
import { GRAPH_TOAST, deletedSelectionToast, graftedToast, recoloredToast } from '../copy.js';
import { t } from '../i18n/index.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../../../telemetry/countBucket.js';

const NEW_NODE_ICON = 'sparkles';

function undoOf({ session, receipt }, onReverted) {
  return receiptUndo({ session, receipt, onReverted, onFailure: (error) => reportRoadmapFailure('roadmap-graph-undo', error) });
}

// The canvas, the dock and the tablet panel have no form to report from, so each write names what it changed.
function trackEdit(changed) {
  track('roadmap_board_edit', { step: 'saved', view: 'graph', name: false, description: false, kind: false, prerequisites: false, order: false, ...changed });
}

// Every write the Graph's own surfaces make; a write returns what `announce` needs for its own Undo, or null when nothing took.
// What a write says of its success, it says once the write has landed (`onceLanded`).
export function useGraphEditing({ room, legendRef, desktopEditorRef, selection, emit, showToast }) {
  const { sessionRef, projectionRef, sceneRef, treeRef, standingTreeRef } = room;
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

  const writeEdit = useCallback((gesture, changed) => {
    const written = write(gesture);
    if (written) onceLanded(written.receipt, () => trackEdit(changed));
    return written;
  }, [write]);

  const announce = useCallback((written, act, message, onReverted) => {
    if (!written) return;
    onceLanded(written.receipt, () => {
      showToast(message, {
        surface: 'graph', act,
        action: undoOf(written, () => {
          onReverted?.();
          track('roadmap_graph_toast', { act, step: 'undo' });
        }),
      });
      track('roadmap_graph_toast', { act, step: 'shown' });
    });
  }, [showToast]);

  const handleRename = useCallback((id, label) => {
    const node = projectionRef.current?.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return null;
    const written = writeEdit({ kind: 'RenameNode', id, label }, { name: true });
    if (written && node.label.trim() !== '') onceLanded(written.receipt, () => emit({ verb: 'renamed', nodeId: id, label, kind: node.color }));
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
    onceLanded(written.receipt, () => {
      emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
      track('roadmap_board_create', { step: 'saved', door: 'canvas', view: 'graph' });
    });
    return { id, ...written };
  }, [setSelectedId, emit]);

  const handleCreateRoot = useCallback(() => {
    if (!desktopEditorRef.current) return;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const color = legendRef.current[0]?.hue ?? 'terracotta';
    const written = write({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color });
    if (!written) return;
    sceneRef.current?.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    onceLanded(written.receipt, () => {
      emit({ verb: 'added', nodeId: id, label: '', kind: color });
      track('roadmap_board_create', { step: 'saved', door: 'empty', view: 'graph' });
    });
  }, [emit, setSelectedId]);

  const handleConnect = useCallback((sourceId, targetId) => writeEdit({ kind: 'AddEdge', from: sourceId, to: targetId }, { prerequisites: true }), []);

  const handleDeleteEdge = useCallback((sourceId, targetId) => writeEdit({ kind: 'RemoveEdge', from: sourceId, to: targetId }, { prerequisites: true }), []);

  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    writeEdit({ kind: 'ReconnectEdge', oldFrom, oldTo, newFrom, newTo }, { prerequisites: true });
  }, []);

  const deleteNodeAt = useCallback((id) => {
    const node = projectionRef.current?.nodes.find((n) => n.id === id);
    if (!node || readEffects(standingTreeRef.current, [id])?.takesEveryStart) return;
    const written = write({ kind: 'DeleteNode', id });
    if (!written) return;
    if (selectedIdRef.current === id) setSelectedId(null);
    announce(written, 'delete', GRAPH_TOAST.stepDeleted);
    onceLanded(written.receipt, () => {
      emit({ verb: 'removed', nodeId: id, label: node.label, kind: node.color });
      track('roadmap_board_delete', { step: 'sent', via: 'direct', view: 'graph' });
    });
  }, [emit, announce]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  // Labels must be snapshotted BEFORE dispatch: the projection drops the doomed nodes synchronously.
  const bulkDelete = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    const edges = [...selectedEdgesRef.current].map(parseEdgeKey); // {from,to}
    if ((!ids.length && !edges.length) || readEffects(standingTreeRef.current, ids)?.takesEveryStart) return;
    const nodes = projectionRef.current?.nodes ?? [];
    const doomed = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    const written = write({ kind: 'BulkDelete', nodeIds: ids, edges });
    if (!written) return;
    leaveMulti();
    announce(written, 'delete', deletedSelectionToast({ steps: ids.length, links: edges.length }));
    onceLanded(written.receipt, () => {
      for (const node of doomed) emit({ verb: 'removed', nodeId: node.id, label: node.label, kind: node.color });
      track('roadmap_board_bulk', { step: 'delete', count: countBucket(ids.length), view: 'graph' });
    });
  }, [emit, announce, leaveMulti]);

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return null;
    return writeEdit({ kind: 'SetNodeColor', id, color: kind }, { kind: true });
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

  // The step's new key, and the sibling it now sits below with the siblings it sits among, so either session can place it.
  const handleSetNodeOrder = useCallback((id, order) => {
    if (!id) return;
    const siblings = (reorderContext(id)?.siblings ?? []).filter((sibling) => sibling.id !== id);
    const below = siblings.filter((sibling) => sibling.order && sibling.order < order).at(-1)?.id ?? null;
    writeEdit({ kind: 'SetNodeOrder', id, order, below, siblings: siblings.map((sibling) => sibling.id) }, { order: true });
  }, [reorderContext]);

  const bulkRecolor = useCallback((color, { silent = false } = {}) => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    const written = write({ kind: 'BulkRecolor', nodeIds: ids, color });
    if (!silent) announce(written, 'recolor', recoloredToast({ count: ids.length }));
    if (written) onceLanded(written.receipt, () => track('roadmap_board_bulk', { step: 'recolor', count: countBucket(ids.length), view: 'graph' }));
  }, [announce]);

  // A grafted step is named by the id it was written under: the graft's own on roadmap's session, the one the domain gave it on
  // the device's copy (the import's result). Its model reaches the scene before the graft lands, so it is seated before it
  // is pulsed; the toast stands on the view that took the plan.
  const graftImported = useCallback((parse, view) => {
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
    if (graft === null) {
      setComposerOpen(false);
      return;
    }

    const written = write({ kind: 'ImportSubgraph', nodes: graft.nodes, edges: graft.edges, kinds: graft.kinds });
    if (!written) return;
    setComposerOpen(false);
    onceLanded(written.receipt, (results) => {
      const idOf = (grafted) => results?.[0]?.[grafted.id] ?? grafted.id;
      for (const grafted of graft.nodes) {
        emit({ verb: 'added', nodeId: idOf(grafted), label: grafted.label, kind: grafted.color }, { silent: true });
        sceneRef.current?.pulseNode(idOf(grafted));
      }
    });
    const under = targetId ? (nodes.find((node) => node.id === targetId)?.label || t('roadmap.toast.graftedUnderTree')) : null;
    const message = graftedToast({ count: graft.nodes.length, under });
    if (view === 'board') onceLanded(written.receipt, () => showToast(message, { surface: 'board', act: 'graft', action: undoOf(written, () => track('roadmap_board_undo', { act: 'graft' })) }));
    else announce(written, 'graft', message);
    onceLanded(written.receipt, () => track('roadmap_board_create', { step: 'saved', door: 'paste', view, count: countBucket(graft.nodes.length) }));
  }, [emit, announce, showToast]);

  return {
    autoFocusNameId, composerOpen, draft, setDraft, draftKinds, setDraftKinds, draftParse, closeComposer, openComposer,
    undo, redo, announce, handleRename, handleCreateChild, handleCreateRoot, handleConnect, handleDeleteEdge, handleReconnect,
    deleteNodeAt, deleteSelected, bulkDelete, handleSetKind, reorderContext, handleSetNodeOrder, bulkRecolor, graftImported,
  };
}
