import { useCallback, useLayoutEffect, useRef } from 'react';
import { COLUMN_OF_STATE } from '../model/UnlockRules.js';
import { titleOf } from '../board/StepFacts.js';
import { track } from '../../../telemetry/beacon.js';

// The phone Graph's bottom bar: the one selected step while nothing covers it, else the reader's Fork pill. A bar that goes
// with focus inside hands focus back to the Graph.
export function useGraphStepBar({ phoneGraph, selection, selectedNode, selectedState, covered, forkPresent, forkOpen, setForkOpen, rootRef, focusGraph }) {
  const { selectedIds, selectedEdges } = selection;
  const barRef = useRef(null);
  const barFocusedRef = useRef(false);
  const rememberGraphFocus = useCallback((event) => {
    barFocusedRef.current = Boolean(event.target.closest('[data-graph-step-bar]'));
  }, []);

  const graphStep = phoneGraph && selectedNode && selectedIds.size === 1 && selectedEdges.size === 0 && !covered
    ? { id: selectedNode.id, title: titleOf(selectedNode), state: COLUMN_OF_STATE[selectedState] ?? 'locked' }
    : null;

  const openGraphFork = useCallback(() => {
    if (graphStep) track('roadmap_verb', { verb: 'fork', door: 'bar', view: 'graph', band: 'phone' });
    setForkOpen(true);
  }, [graphStep?.id]);

  useLayoutEffect(() => {
    if (graphStep) {
      barRef.current = rootRef.current?.querySelector('[data-graph-step-bar]');
      return;
    }
    const previous = barRef.current;
    barRef.current = null;
    if (covered || forkOpen || !previous) return;
    if (barFocusedRef.current) {
      barFocusedRef.current = false;
      focusGraph();
    }
  }, [graphStep?.id, covered, forkOpen, focusGraph]);

  return { graphStep, forkPillShown: forkPresent && phoneGraph && !graphStep, openGraphFork, rememberGraphFocus };
}
