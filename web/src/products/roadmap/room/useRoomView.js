import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { coverBeneath, useCoveredLayer } from '../step/composerFocus.js';
import { ViewPrefs, boardCanShow, clearBorn, initialView, peekBorn, viewToShow } from '../persistence/ViewPrefs.js';
import { reportRoadmapFailure } from '../reportFailure.js';

// Availability and the loaded tree decide the view; explicit switches are remembered per tree.
export function useRoomView({ treeId, tree, loading, loadError, who, linkedStep, scene, graphAvailability = 'available', anchors, onLeave, onSwitched }) {
  const { identityRef, boardLayerRef } = anchors;
  const { owner, reader, role, demo, shared, breakpoint } = who;
  const [viewPrefs] = useState(() => new ViewPrefs());
  const [view, setView] = useState(null); // 'tree' | 'board' | null when undecided
  const [boardCrashed, setBoardCrashed] = useState(false);
  const initialDecisionRef = useRef(null);
  const viewOpenedRef = useRef(null);
  const switchFocusRef = useRef(false);
  const switchOptionRef = useRef(null);
  const boardShownRef = useRef(false);

  const graphAvailable = graphAvailability === 'available';
  const graphSettled = graphAvailability !== 'pending';

  if (view === null && tree && graphSettled) {
    const decision = initialView({ saved: viewPrefs.lastView(treeId), owner, reader, empty: tree.nodes.length === 0, born: peekBorn(treeId), linkedStep, canAddFirstStep: owner, graphAvailable });
    setView(decision.view);
    initialDecisionRef.current = decision;
  }
  useEffect(() => {
    if (view !== null) clearBorn(treeId);
  }, [view, treeId]);
  useEffect(() => {
    const decision = initialDecisionRef.current;
    if (!decision || viewOpenedRef.current === treeId) return;
    viewOpenedRef.current = treeId;
    track('roadmap_view_open', { view: decision.view === 'board' ? 'board' : 'graph', band: breakpoint, role, door: decision.door });
  }, [treeId, view, breakpoint, role]);

  // Until the tree arrives, the skeleton or load error stands where the Board would open: the saved choice, or the owner's default.
  const openingView = view ?? initialView({ saved: viewPrefs.lastView(treeId), owner: !shared && !demo, reader, empty: false, born: peekBorn(treeId), linkedStep, graphAvailable }).view;
  const boardFacts = {
    crashed: boardCrashed,
    loaded: !loading && !loadError && !!tree,
    empty: tree?.nodes.length === 0,
    canAddFirstStep: owner,
  };
  const shownView = viewToShow(openingView, boardFacts, graphAvailable);
  const boardActive = shownView === 'board';

  // The Board retains its fold through reloads; without a Graph, a crash retains the Board's boundary.
  if (boardActive && graphSettled) boardShownRef.current = true;
  const boardMounted = (!boardCrashed || graphAvailability === 'unavailable') && boardShownRef.current;
  useCoveredLayer(boardLayerRef, boardMounted && !boardActive);
  useEffect(() => (boardActive && boardMounted ? coverBeneath(boardLayerRef.current) : undefined), [boardActive, boardMounted]);

  // stop() only cancels the RAF; applyModel runs fine while stopped and renders on the first frame after start().
  useEffect(() => {
    if (!scene) return;
    if (boardActive) scene.stop(); else scene.start();
  }, [scene, boardActive]);

  const switchView = useCallback((next, { keepFocus = false } = {}) => {
    if (next === 'tree' && !graphAvailable) return;
    if (next !== shownView) onLeave();
    if (next === 'board') setBoardCrashed(false);
    setView(next);
    viewPrefs.setLastView(treeId, next);
    track('roadmap_view_switch', { view: next === 'board' ? 'board' : 'graph' });
    onSwitched(next);
    switchFocusRef.current = !keepFocus;
    const active = document.activeElement;
    switchOptionRef.current = active?.classList.contains('st-board-switch-option') ? active : null;
  }, [treeId, shownView, onLeave, onSwitched, viewPrefs, graphAvailable]);

  // A switch keeps focus on the option it pressed; a key or a crash lands on the option the row now shows pressed.
  useEffect(() => {
    if (!switchFocusRef.current) return;
    switchFocusRef.current = false;
    const option = switchOptionRef.current;
    switchOptionRef.current = null;
    if (option?.isConnected && option.getAttribute('aria-pressed') === 'true' && !option.closest('[inert]')) {
      option.focus();
      return;
    }
    identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus();
  }, [shownView]);

  const crashBoard = useCallback((error) => {
    reportRoadmapFailure('roadmap-board', error);
    setBoardCrashed(true);
    if (graphAvailable) setView('tree');
  }, [graphAvailable]);
  useEffect(() => {
    if (boardCrashed) identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus();
  }, [boardCrashed]);

  return {
    decidedView: view, shownView, boardActive, canvasView: !boardActive, boardFacts, boardMounted, switchView, crashBoard,
    // A Board standing in for an unloaded roadmap names nothing; a failed load offers no Graph, whose error would cover the row.
    boardAwaitsRoadmap: boardActive && !boardFacts.loaded,
    onSwitchView: (!graphAvailable || boardCanShow({ ...boardFacts, crashed: false })) && !(boardActive && loadError) ? switchView : null,
  };
}
