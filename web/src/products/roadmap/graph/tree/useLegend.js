// The lattice is the authority: each edit is dispatched as one gesture and the displayed kinds
// re-derive from the projection. Only the open flag is a local preference (LegendStore).

import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../../../../telemetry/beacon.js';
import { LegendStore } from '../../persistence/LegendStore.js';
import { deriveLegend, withCounts, freeHue, addKind, recolorKind } from '../../model/Legend.js';

const legendStore = new LegendStore();

export function useLegend({ seedRef, sessionRef, projectionRef, sceneRef }) {
  const [legend, setLegend] = useState([]);
  const [legendOpen, setLegendOpen] = useState(true); // remembered per tree
  const [legendForceOpen, setLegendForceOpen] = useState(false); // the picker's "+" summoned the key on a 1-kind tree
  const [highlightedKindId, setHighlightedKindId] = useState(null); // a legend row is spotlighting its kind on the graph

  const legendRef = useRef([]); // the fresh read for legend ops + persistence
  const legendOpenRef = useRef(true); // mirrors legendOpen for persistence
  const highlightedKindIdRef = useRef(null); // mirrors the highlighted kind for the Esc/toggle checks

  useEffect(() => { legendRef.current = legend; }, [legend]);
  useEffect(() => { legendOpenRef.current = legendOpen; }, [legendOpen]);
  useEffect(() => { highlightedKindIdRef.current = highlightedKindId; }, [highlightedKindId]);

  // Every kind edit funnels through one seam: update the fresh ref, set state, persist.
  const persistLegend = useCallback((kinds, open) => {
    if (!seedRef.current) return;
    legendStore.save(seedRef.current.id, { kinds, open });
  }, [seedRef]);

  const commitLegend = useCallback((kinds) => {
    legendRef.current = kinds;
    setLegend(kinds);
    persistLegend(kinds, legendOpenRef.current);
  }, [persistLegend]);

  // Seats the whole key for a freshly-loaded tree. Nothing is written back.
  const hydrateLegend = useCallback((treeId, nodes, backendKinds) => {
    const saved = legendStore.load(treeId);
    const kinds = deriveLegend(nodes, backendKinds);
    const open = saved?.open ?? true;
    legendRef.current = kinds;
    legendOpenRef.current = open;
    highlightedKindIdRef.current = null;
    setLegend(kinds);
    setLegendOpen(open);
    setLegendForceOpen(false);
    setHighlightedKindId(null);
  }, []);

  const syncLegendFromTree = useCallback((treeData) => {
    commitLegend(deriveLegend(treeData.nodes, treeData.kinds));
  }, [commitLegend]);


  const onRenameKind = useCallback((id, label) => {
    sessionRef.current?.dispatch({ kind: 'RenameKind', id, label });
    track('roadmap_board_edit', { step: 'saved', view: 'graph', legend: 'rename' });
  }, [sessionRef]);
  const onDescribeKind = useCallback((id, description) => {
    sessionRef.current?.dispatch({ kind: 'DescribeKind', id, description });
    track('roadmap_board_edit', { step: 'saved', view: 'graph', legend: 'describe' });
  }, [sessionRef]);
  const onAddKind = useCallback((hue) => {
    const next = addKind(legendRef.current, hue ?? freeHue(legendRef.current));
    if (next === legendRef.current) return; // hue taken or palette full — nothing added
    const added = next[next.length - 1];
    sessionRef.current?.dispatch({ kind: 'AddKind', id: added.id, hue: added.hue });
    track('roadmap_board_edit', { step: 'saved', view: 'graph', legend: 'add' });
  }, [sessionRef]);

  // Remove is offered only for a kind no node wears; read the editor's live nodes against a stale click.
  const onRemoveKind = useCallback((id) => {
    const nodes = projectionRef.current?.nodes ?? [];
    const target = withCounts(legendRef.current, nodes).find((kind) => kind.id === id);
    if (!target || target.count > 0) return;
    sessionRef.current?.dispatch({ kind: 'RemoveKind', id });
    track('roadmap_board_edit', { step: 'saved', view: 'graph', legend: 'remove' });
  }, [sessionRef, projectionRef]);

  // Recolor swaps the kind's hue AND repaints every node of the old hue, as one atomic gesture.
  const onRecolorKind = useCallback((id, targetHue) => {
    const { newHue } = recolorKind(legendRef.current, id, targetHue);
    if (!newHue) return;
    sessionRef.current?.dispatch({ kind: 'RecolorKind', id, hue: newHue });
    track('roadmap_board_edit', { step: 'saved', view: 'graph', legend: 'recolor' });
  }, [sessionRef]);

  // State tracks the kind id, but the scene is handed the HUE, null to clear.
  const onHighlightKind = useCallback((id) => {
    const nextId = id === highlightedKindIdRef.current ? null : id;
    highlightedKindIdRef.current = nextId;
    setHighlightedKindId(nextId);
    const hue = nextId ? legendRef.current.find((kind) => kind.id === nextId)?.hue ?? null : null;
    sceneRef.current?.highlightKind?.(hue);
  }, [sceneRef]);

  const clearHighlightedKind = useCallback(() => {
    highlightedKindIdRef.current = null;
    setHighlightedKindId(null);
    sceneRef.current?.highlightKind?.(null);
  }, [sceneRef]);

  const onLegendOpenChange = useCallback((open) => {
    legendOpenRef.current = open;
    setLegendOpen(open);
    persistLegend(legendRef.current, open);
  }, [persistLegend]);

  const openLegendFromPicker = useCallback(() => {
    setLegendForceOpen(true);
    onLegendOpenChange(true);
  }, [onLegendOpenChange]);

  return {
    legend,
    legendRef,
    legendOpen,
    legendForceOpen,
    highlightedKindId,
    highlightedKindIdRef,
    hydrateLegend,
    syncLegendFromTree,
    clearHighlightedKind,
    onRenameKind,
    onDescribeKind,
    onAddKind,
    onRemoveKind,
    onRecolorKind,
    onHighlightKind,
    onLegendOpenChange,
    openLegendFromPicker,
  };
}
