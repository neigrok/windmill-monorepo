// The color key's editor (F6), over the pure model/Legend.js: the tree's ordered kinds, the
// open/collapsed preference, the spotlighted row, and every kind gesture. The lattice is the
// authority for the legend as for everything else — each edit is dispatched as one gesture and
// the displayed kinds re-derive from the projection through syncLegendFromTree, for our own edit
// and a collaborator's alike. Only the open flag is a local preference (LegendStore).
//
// The counts the key renders are NOT here: they are a join of the legend with the live nodes,
// so the view computes them (withCounts / inUseCount) beside the tree it already holds.

import { useCallback, useEffect, useRef, useState } from 'react';
import { LegendStore } from '../../persistence/LegendStore.js';
import { deriveLegend, withCounts, freeHue, addKind, recolorKind } from '../../model/Legend.js';

const legendStore = new LegendStore();

export function useLegend({ seedRef, collabRef, editorRef, sceneRef }) {
  const [legend, setLegend] = useState([]); // the tree's ordered kinds (F6 — color legend)
  const [legendOpen, setLegendOpen] = useState(true); // whether the key is expanded, remembered per tree
  const [legendForceOpen, setLegendForceOpen] = useState(false); // the picker's "+" summoned the key on a 1-kind tree
  const [highlightedKindId, setHighlightedKindId] = useState(null); // a legend row is spotlighting its kind on the graph

  const legendRef = useRef([]); // the current ordered kinds; the fresh read for legend ops + persistence
  const legendOpenRef = useRef(true); // mirrors legendOpen so persistence reads it without a dep churn
  const highlightedKindIdRef = useRef(null); // mirrors the highlighted kind for the Esc/toggle checks

  useEffect(() => { legendRef.current = legend; }, [legend]);
  useEffect(() => { legendOpenRef.current = legendOpen; }, [legendOpen]);
  useEffect(() => { highlightedKindIdRef.current = highlightedKindId; }, [highlightedKindId]);

  // Every kind edit funnels through one seam — update the fresh ref, set state, and persist —
  // mirroring commitWorkspace; the open flag rides in the payload.
  const persistLegend = useCallback((kinds, open) => {
    if (!seedRef.current) return;
    legendStore.save(seedRef.current.id, { kinds, open });
  }, [seedRef]);

  const commitLegend = useCallback((kinds) => {
    legendRef.current = kinds;
    setLegend(kinds);
    persistLegend(kinds, legendOpenRef.current);
  }, [persistLegend]);

  // The load pipeline seats the whole key for a freshly-loaded tree. The legend is served by the
  // backend (its `kinds`, reconciled so every in-use hue still has an entry); open/collapsed stays
  // a local UI preference in localStorage. Nothing is written back — this reads the record.
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

  // The lattice changed — a dispatched local gesture or a joined remote frame; the displayed
  // kinds re-derive from the new projection either way.
  const syncLegendFromTree = useCallback((treeData) => {
    commitLegend(deriveLegend(treeData.nodes, treeData.kinds));
  }, [commitLegend]);

  const clearLegendStore = useCallback((treeId) => legendStore.clear(treeId), []);

  // Each legend edit is dispatched as one gesture; the lattice is the authority for the
  // legend (F6) as for everything else, and onTreeChanged re-derives the displayed kinds
  // from it — for our own edit and a collaborator's alike.
  const onRenameKind = useCallback((id, label) => {
    collabRef.current?.dispatch({ kind: 'RenameKind', id, label });
  }, [collabRef]);
  const onDescribeKind = useCallback((id, description) => {
    collabRef.current?.dispatch({ kind: 'DescribeKind', id, description });
  }, [collabRef]);
  const onAddKind = useCallback((hue) => {
    const next = addKind(legendRef.current, hue ?? freeHue(legendRef.current));
    if (next === legendRef.current) return; // hue taken or palette full — nothing added
    const added = next[next.length - 1];
    collabRef.current?.dispatch({ kind: 'AddKind', id: added.id, hue: added.hue });
  }, [collabRef]);

  // Remove is offered only for a kind no node wears; guard here against a stale click,
  // reading the editor's live nodes (the freshest source of every node's hue).
  const onRemoveKind = useCallback((id) => {
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const target = withCounts(legendRef.current, nodes).find((kind) => kind.id === id);
    if (!target || target.count > 0) return;
    collabRef.current?.dispatch({ kind: 'RemoveKind', id });
  }, [collabRef, editorRef]);

  // Recolor a kind = swap its hue AND repaint every node of the old hue to the new — one
  // atomic RecolorKind gesture (materialize computes the fan-out; every peer repaints the
  // same set). A no-op swap (hue taken) leaves the nodes alone.
  const onRecolorKind = useCallback((id, targetHue) => {
    const { newHue } = recolorKind(legendRef.current, id, targetHue);
    if (!newHue) return;
    collabRef.current?.dispatch({ kind: 'RecolorKind', id, hue: newHue });
  }, [collabRef]);

  // A legend row spotlights its kind on the graph (WS-C's scene.highlightKind, called
  // defensively — a sibling adds it). Clicking the lit row again clears it. We track the
  // kind id in state but hand the scene the *hue* (the shared contract), null to clear.
  const onHighlightKind = useCallback((id) => {
    const nextId = id === highlightedKindIdRef.current ? null : id;
    highlightedKindIdRef.current = nextId;
    setHighlightedKindId(nextId);
    const hue = nextId ? legendRef.current.find((kind) => kind.id === nextId)?.hue ?? null : null;
    sceneRef.current?.highlightKind?.(hue);
  }, [sceneRef]);

  // Esc drops the spotlight before it reaches the selection (the view keeps that precedence).
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

  // The StepPanel picker's ghost "+" forces the key open on a still-keyless 1-kind tree.
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
    clearLegendStore,
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
