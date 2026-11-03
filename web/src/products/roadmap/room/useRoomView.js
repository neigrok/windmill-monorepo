import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { coverBeneath } from '../board/composerFocus.js';
import { ViewPrefs, boardCanShow, clearBorn, initialView, peekBorn, viewToShow } from '../persistence/ViewPrefs.js';
import { reportRoadmapFailure } from '../reportFailure.js';

// Board or Graph: decided once the moment the tree is ready, remembered per tree, and given up only where the Board cannot
// show. A switch keeps focus on the option it pressed; a key or a crash lands on the option the row now shows pressed.
export function useRoomView({ treeId, tree, loading, loadError, who, linkedStep, scene, anchors, onLeave, onSwitched }) {
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

  if (view === null && tree) {
    const decision = initialView({ saved: viewPrefs.lastView(treeId), owner, reader, empty: tree.nodes.length === 0, born: peekBorn(treeId), linkedStep, canAddFirstStep: owner });
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

  // Until the tree arrives, the Board's skeleton or load error stands where the Board would open: the saved choice, or
  // the owner's default anywhere but a share or the demo.
  const openingView = view ?? initialView({ saved: viewPrefs.lastView(treeId), owner: !shared && !demo, reader, empty: false, born: peekBorn(treeId), linkedStep }).view;
  const boardFacts = {
    crashed: boardCrashed,
    loaded: !loading && !loadError && !!tree,
    empty: tree?.nodes.length === 0,
    canAddFirstStep: owner,
  };
  const shownView = viewToShow(openingView, boardFacts);
  const boardActive = shownView === 'board';

  // The Board stays mounted through a reload or an emptied tree, so Done's fold survives (its columns, and their scroll,
  // give way to the skeleton or the empty roadmap); only a crash drops it.
  if (boardActive) boardShownRef.current = true;
  const boardMounted = !boardCrashed && boardShownRef.current;
  useEffect(() => (boardActive ? coverBeneath(boardLayerRef.current) : undefined), [boardActive]);

  // stop() only cancels the RAF; applyModel runs fine while stopped and renders on the first frame after start().
  useEffect(() => {
    if (!scene) return;
    if (boardActive) scene.stop(); else scene.start();
  }, [scene, boardActive]);

  const switchView = useCallback((next, { keepFocus = false } = {}) => {
    if (next !== shownView) onLeave();
    if (next === 'board') setBoardCrashed(false);
    setView(next);
    viewPrefs.setLastView(treeId, next);
    track('roadmap_view_switch', { view: next === 'board' ? 'board' : 'graph' });
    onSwitched(next);
    switchFocusRef.current = !keepFocus;
    const active = document.activeElement;
    switchOptionRef.current = active?.classList.contains('st-board-switch-option') ? active : null;
  }, [treeId, shownView, onLeave, onSwitched, viewPrefs]);

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
    setView('tree');
  }, []);
  useEffect(() => {
    if (boardCrashed) identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus();
  }, [boardCrashed]);

  return {
    decidedView: view, shownView, boardActive, canvasView: !boardActive, boardFacts, boardMounted, switchView, crashBoard,
    // While the Board stands in for a roadmap that has not loaded, the row names nothing and offers no Share; a failed
    // load offers no Graph either, whose load error would cover the row with no way back.
    boardAwaitsRoadmap: boardActive && !boardFacts.loaded,
    onSwitchView: boardCanShow({ ...boardFacts, crashed: false }) && !(boardActive && loadError) ? switchView : null,
  };
}
