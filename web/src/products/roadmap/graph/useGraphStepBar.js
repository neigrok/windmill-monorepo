import { useCallback, useLayoutEffect, useRef } from 'react';
import { COLUMN_OF_STATE } from '../model/UnlockRules.js';
import { titleOf } from '../step/StepFacts.js';
import { track } from '../../../telemetry/beacon.js';

// The compatibility mousedown of a touch tap lands within this window of its pointer up.
const TAP_MOUSEDOWN_MS = 350;

// The phone Graph's bar: the one selected step while nothing covers it; going with focus inside, it hands focus to the Graph.
export function useGraphStepBar({ phoneGraph, selection, selectedNode, selectedState, covered, forkPresent, forkOpen, setForkOpen, rootRef, canvasRef, focusGraph }) {
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
    track('roadmap_verb', { verb: 'fork', door: graphStep ? 'bar' : 'pill', view: 'graph', band: 'phone' });
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
    if (!barFocusedRef.current) return;
    barFocusedRef.current = false;
    focusGraph();
    // A tap deselects on pointer up; the mousedown the browser sends after it would blur the option focus just reached.
    const canvas = canvasRef.current;
    const keepFocus = (event) => event.preventDefault();
    canvas?.addEventListener('mousedown', keepFocus, { once: true });
    setTimeout(() => canvas?.removeEventListener('mousedown', keepFocus), TAP_MOUSEDOWN_MS);
  }, [graphStep?.id, covered, forkOpen, focusGraph]);

  return { graphStep, forkPillShown: forkPresent && phoneGraph && !graphStep, openGraphFork, rememberGraphFocus };
}
