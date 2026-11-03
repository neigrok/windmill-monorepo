import { useEffect } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { boardKey, graphOnlyKey } from './shortcutMap.js';

// The room's window-level keys: Ask AI, the editor's chords, the Board's letters and pasted plans.
export function useRoadmapKeys({
  canTend, tendOpen, setTendOpen, keyboardCovered, activityActsRef, boardActiveRef, boardSwitchRef, desktopEditorRef, composerOpenRef,
  identityRef, sceneRef, editorRef, legendRef, feedSummonedRef, highlightedKindIdRef, clearHighlightedKind,
  selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, selectAll, clearEdges,
  undo, redo, deleteSelected, bulkDelete, handleDeleteEdge, handleFocus, handleShowAll,
  setShortcutsOpen, setDraftKinds, setDraft, setComposerOpen,
}) {
  useEffect(() => {
    if (!canTend) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && tendOpen) { event.preventDefault(); setTendOpen(false); return; }
      if (keyboardCovered()) return;
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!tendOpen) {
          const { breakpoint, boardActive } = activityActsRef.current;
          track('roadmap_verb', { verb: 'askAI', door: 'key', view: boardActive ? 'board' : 'graph', band: breakpoint });
        }
        setTendOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canTend, tendOpen, keyboardCovered]);

  useEffect(() => {
    const onEditorKey = (event) => {
      if (event.defaultPrevented) return;
      const covered = keyboardCovered();
      const activeElement = document.activeElement;
      const typing = activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable);
      if (boardKey(event, { typing, covered }) === 'activity') {
        if (!activityActsRef.current?.enabled) return;
        event.preventDefault();
        activityActsRef.current.open('key');
        return;
      }
      if (boardActiveRef.current && graphOnlyKey(event)) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !typing) event.preventDefault();
        return;
      }
      if (desktopEditorRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        if (covered) return;
        event.preventDefault();
        track('roadmap_board_undo', { act: event.shiftKey ? 'redoKey' : 'undoKey' });
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (desktopEditorRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        event.preventDefault();
        selectAll(editorRef.current?.treeData.nodes.map((n) => n.id) ?? []);
        return;
      }
      if (event.key === 'Escape') {
        if (covered) return;
        if (highlightedKindIdRef.current) { clearHighlightedKind(); return; }
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) { setSelectedId(null); return; }
        if (sceneRef.current?.selectedEdge) { sceneRef.current.selectEdge(null); return; }
        if (feedSummonedRef.current) activityActsRef.current?.close();
        return;
      }
      const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey && !typing;
      const boardAction = boardKey(event, { typing, covered });
      if (boardAction === 'find') {
        const chrome = identityRef.current;
        const find = chrome?.querySelector('.st-board-find-input');
        const folded = chrome?.querySelector('.st-board-find-toggle');
        if (!find && !folded) return;
        event.preventDefault();
        if (find) find.focus();
        else folded.click();
        return;
      }
      if (boardAction === 'switch' && boardSwitchRef.current) {
        event.preventDefault();
        boardSwitchRef.current();
        return;
      }
      if (event.key.toLowerCase() === 'f' && plainKey) {
        event.preventDefault();
        handleFocus();
        return;
      }
      if (event.key === '0' && plainKey) {
        event.preventDefault();
        handleShowAll();
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (covered) return;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        event.preventDefault();
        setShortcutsOpen((visible) => !visible);
        return;
      }
      if (desktopEditorRef.current && (event.key === 'Backspace' || event.key === 'Delete')) {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (selectedIdsRef.current.size + selectedEdgesRef.current.size > 1) { event.preventDefault(); bulkDelete(); return; }
        if (selectedIdRef.current) { event.preventDefault(); deleteSelected(); return; }
        const edge = sceneRef.current?.selectedEdge;
        if (edge) {
          event.preventDefault();
          handleDeleteEdge(edge.from, edge.to);
          clearEdges();
        }
      }
    };
    window.addEventListener('keydown', onEditorKey);
    return () => window.removeEventListener('keydown', onEditorKey);
  }, [undo, redo, deleteSelected, bulkDelete, handleDeleteEdge, setSelectedId, selectAll, clearEdges, setShortcutsOpen, clearHighlightedKind, handleFocus, handleShowAll, keyboardCovered]);

  useEffect(() => {
    const onPaste = (event) => {
      if (!desktopEditorRef.current) return;
      const covered = keyboardCovered();
      if (composerOpenRef.current || covered) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const pasted = event.clipboardData?.getData('text/plain') ?? '';
      if (pasted.trim() === '') return;
      event.preventDefault();
      setDraftKinds(legendRef.current);
      setDraft(pasted);
      setComposerOpen(true);
      track('roadmap_board_create', { step: 'open', door: 'paste', view: 'graph' });
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [keyboardCovered]);
}
