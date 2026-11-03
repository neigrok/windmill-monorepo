import { useCallback, useEffect, useRef } from 'react';
import { stepIsStale } from '../step/stepAddress.js';
import { reportRoadmapFailure } from '../reportFailure.js';

// A step opens over either view and rides the URL: a link lands on it, Back leaves it, and selection follows it.
export function useStepPage({ treeId, tree, loading, address, setSelectedId, view, anchors, sceneRef, boardActs, viewBranch, onGraphStepOpen }) {
  const { rootRef, identityRef, boardLayerRef } = anchors;
  const { canvasView, switchView } = view;
  const graphStepReturnRef = useRef(false);
  const detailId = tree?.treeId === treeId && address.id !== null && tree.nodesById.has(address.id) ? address.id : null;

  const focusGraph = useCallback(() => {
    const primary = rootRef.current?.querySelector('[data-graph-step-primary]');
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
    const frame = requestAnimationFrame(focusGraph);
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

  return {
    detailId, focusGraph, focusLayer, graphStepReturnRef,
    openFromBoard: (id) => {
      setSelectedId(id);
      address.open(id, 'card');
    },
    openFromGraph: (id) => {
      onGraphStepOpen();
      graphStepReturnRef.current = true;
      address.open(id, 'graph');
    },
    close: () => {
      const origin = address.trail[0];
      address.close();
      if (origin && tree?.nodesById.has(origin)) setSelectedId(origin);
    },
    openInGraph: (id) => {
      address.close();
      setSelectedId(id);
      switchView('tree');
      sceneRef.current?.revealNode(id);
    },
    viewBranch: (id) => {
      address.close();
      viewBranch(id);
    },
    deleteStep: (id) => {
      address.close();
      const held = boardActs.delete([id], 'menu');
      if (held && canvasView) setSelectedId(null);
    },
    crash: (error) => {
      reportRoadmapFailure('roadmap-board-step', error);
      address.close();
      focusLayer();
    },
  };
}
