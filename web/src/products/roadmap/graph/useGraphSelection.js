import { useCallback, useEffect, useRef, useState } from 'react';
import { edgeKey, parseEdgeKey } from '../scene/edgeKey.js';

// The Graph's selection. The tablet's multi-select mode lives with it; the Board keeps its own in `useStepSelection`.
export function useGraphSelection(sceneRef) {
  const [selectedId, commitSelectedId] = useState(null);
  // Two sets: nodes and edge keys. selectedId / scene.selectedEdge are their size<=1 projections, null once the total exceeds one.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedEdges, setSelectedEdges] = useState(() => new Set());
  const [multiMode, setMultiMode] = useState(false);
  const selectedIdRef = useRef(null);
  const selectedIdsRef = useRef(new Set());
  const selectedEdgesRef = useRef(new Set());

  // Must use projectEdge, not selectEdge: selectEdge's node-clear cascade reads lagging scene.selectedIds and would wipe a still-selected edge.
  const reconcileProjections = useCallback((nodeSet, edgeSet) => {
    const total = nodeSet.size + edgeSet.size;
    commitSelectedId(total === 1 && nodeSet.size === 1 ? [...nodeSet][0] : null);
    sceneRef.current?.projectEdge(total === 1 && edgeSet.size === 1 ? parseEdgeKey([...edgeSet][0]) : null);
  }, []);

  const setSelectedId = useCallback((id) => {
    const nodes = id ? new Set([id]) : new Set();
    setSelectedIds(nodes);
    setSelectedEdges(new Set());
    reconcileProjections(nodes, new Set());
  }, [reconcileProjections]);

  const onSelectionToggle = useCallback((id) => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    reconcileProjections(next, selectedEdgesRef.current);
  }, [reconcileProjections]);
  const onMarqueeSelect = useCallback((ids, additive) => {
    const next = additive ? new Set(selectedIdsRef.current) : new Set();
    for (const id of ids) next.add(id);
    const nextEdges = additive ? selectedEdgesRef.current : new Set();
    setSelectedIds(next);
    if (!additive) setSelectedEdges(new Set());
    reconcileProjections(next, nextEdges);
  }, [reconcileProjections]);

  const onEdgeToggle = useCallback((edge) => {
    const key = edgeKey(edge.from, edge.to);
    const next = new Set(selectedEdgesRef.current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelectedEdges(next);
    reconcileProjections(selectedIdsRef.current, next);
  }, [reconcileProjections]);

  const onEdgePick = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedEdges(new Set());
    commitSelectedId(null);
  }, []);

  const selectAll = useCallback((ids) => {
    const set = new Set(ids);
    setSelectedIds(set);
    setSelectedEdges(new Set());
    reconcileProjections(set, new Set());
  }, [reconcileProjections]);

  const clearEdges = useCallback(() => {
    setSelectedEdges(new Set());
    sceneRef.current?.projectEdge(null);
  }, []);

  const enterMulti = useCallback((id) => {
    setMultiMode(true);
    selectAll([id]);
  }, [selectAll]);

  const leaveMulti = useCallback(() => {
    setMultiMode(false);
    setSelectedId(null);
  }, [setSelectedId]);

  const toggleMember = useCallback((id) => {
    if (id === null) {
      setSelectedIds(new Set());
      reconcileProjections(new Set(), new Set());
      return;
    }
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size === 0) setMultiMode(false);
    setSelectedIds(next);
    reconcileProjections(next, selectedEdgesRef.current);
  }, [reconcileProjections]);

  // Leaving the Graph ends a multi-select and folds a mixed selection back to its one step.
  const collapse = useCallback(() => {
    if (multiMode) {
      setMultiMode(false);
      setSelectedIds(new Set());
      reconcileProjections(new Set(), new Set());
      return;
    }
    if (selectedIdsRef.current.size + selectedEdgesRef.current.size > 1) setSelectedId(selectedIdRef.current);
  }, [multiMode, reconcileProjections, setSelectedId]);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { selectedEdgesRef.current = selectedEdges; }, [selectedEdges]);

  // setSelectedSet sweeps the whole array: it is the authority for the GPU highlight.
  useEffect(() => {
    sceneRef.current?.setSelection(selectedId);
    sceneRef.current?.setSelectedSet(selectedIds);
    sceneRef.current?.setSelectedEdges(selectedEdges);
  }, [selectedId, selectedIds, selectedEdges]);

  return {
    selectedId, selectedIds, selectedEdges, multiMode,
    selectedIdRef, selectedIdsRef, selectedEdgesRef,
    setSelectedId, selectAll, clearEdges, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick,
    enterMulti, leaveMulti, toggleMember, collapse,
  };
}
