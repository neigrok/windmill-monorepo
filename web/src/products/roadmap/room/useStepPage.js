import { useCallback, useEffect, useRef } from 'react';
import { requestNavigation } from '../../../shell/navigation.js';
import { stepIsStale } from '../step/stepAddress.js';
import { reportRoadmapFailure } from '../reportFailure.js';

// A step opens over either view and rides the URL: a link lands on it, Back leaves it, and selection follows it.
export function useStepPage({ treeId, tree, loading, address, setSelectedId, view, anchors, sceneRef, boardActs, boardTree, setBoardQuery, setBoardSelect, viewBranch, onGraphStepOpen }) {
  const { rootRef, identityRef, boardLayerRef } = anchors;
  const { canvasView, switchView } = view;
  const graphStepReturnRef = useRef(false);
  const selectKey = useRef(0);
  const detailId = tree?.treeId === treeId && address.id !== null && tree.nodesById.has(address.id) ? address.id : null;

  const focusGraph = useCallback(() => {
    const primary = rootRef.current?.querySelector('canvas[data-graph-focus]');
    const pressed = identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]');
    (primary ?? pressed)?.focus({ preventScroll: true });
  }, []);

  // A step the loaded roadmap no longer holds leaves the URL, so restoring it later never reopens it.
  const staleStep = stepIsStale({ loading, tree, treeId, stepId: address.id });
  useEffect(() => {
    if (staleStep) address.drop();
  }, [staleStep, address.drop]);
  useEffect(() => {
    if (detailId !== null) setSelectedId(detailId);
  }, [detailId, setSelectedId]);
  useEffect(() => {
    if (detailId !== null || !graphStepReturnRef.current) return undefined;
    graphStepReturnRef.current = false;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== document.body && active?.isConnected && !active.closest('[inert]')) return;
      focusGraph();
    });
    return () => cancelAnimationFrame(frame);
  }, [detailId, focusGraph]);

  const focusLayer = () => requestAnimationFrame(() => {
    if (canvasView) {
      focusGraph();
      return;
    }
    const stops = boardLayerRef.current?.querySelectorAll('[data-column] [tabindex="0"], [data-column][tabindex="0"], .st-board-state button') ?? [];
    [...stops].find((element) => element.getClientRects().length > 0)?.focus();
  });

  // The Board's cards hold on to this one, so it keeps its identity through unrelated renders.
  const openFromBoard = useCallback((id) => requestNavigation({ key: `step:open:${id}`, run: (tx) => {
    setSelectedId(id);
    address.open(id, 'card', tx);
  } }), [setSelectedId, address.open]);

  return {
    detailId, focusGraph, focusLayer, graphStepReturnRef, openFromBoard,
    openFromGraph: (id) => requestNavigation({ key: `step:open:${id}`, run: (tx) => {
      onGraphStepOpen();
      graphStepReturnRef.current = true;
      address.open(id, 'graph', tx);
    } }),
    close: () => requestNavigation({ key: 'step:close', run: async (tx) => {
      const origin = address.trail[0];
      if (await address.close(tx) === false) return;
      if (origin && tree?.nodesById.has(origin)) setSelectedId(origin);
    } }),
    openInGraph: (id) => requestNavigation({ key: `step:graph:${id}`, run: async (tx) => {
      graphStepReturnRef.current = true;
      if (await address.close(tx) === false) return;
      setSelectedId(id);
      switchView('tree', { transaction: tx });
      sceneRef.current?.revealNode(id);
    } }),
    select: (id) => requestNavigation({ key: `step:select:${id}`, run: async (tx) => {
      if (await address.close(tx) === false) return;
      setSelectedId(id);
      const step = boardTree.nodesById.get(id);
      setBoardQuery((query) => query.revealing(step, boardTree));
      selectKey.current += 1;
      setBoardSelect({ id, key: selectKey.current });
    } }),
    viewBranch: (id) => requestNavigation({ key: `step:branch:${id}`, run: async (tx) => {
      graphStepReturnRef.current = false;
      if (await address.close(tx) === false) return;
      switchView('board', { transaction: tx });
      viewBranch(id);
    } }),
    deleteStep: (id) => requestNavigation({ key: `step:delete:${id}`, run: async (tx) => {
      if (await address.close(tx) === false) return;
      const held = boardActs.delete([id], 'menu');
      if (held && canvasView) setSelectedId(null);
    } }),
    crash: (error) => {
      reportRoadmapFailure('roadmap-board-step', error);
      address.close();
      focusLayer();
    },
  };
}
