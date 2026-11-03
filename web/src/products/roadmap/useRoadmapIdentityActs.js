import { useCallback, useMemo } from 'react';
import { navigate } from '../../shell/navigation.js';
import { track } from '../../telemetry/beacon.js';
import { Board } from './board/Board.js';
import { LINK_COPIED } from './board/copy.js';
import { listAllTrees } from './persistence/TreeRegistry.js';
import { treeShareUrl } from './share/ShareDialog.jsx';
import { buildRoadmapExport, downloadExport } from './settings/exportArchive.js';

export function useRoadmapIdentityActs({
  owner, phone, treeId, tree, boardTree, shownStats, identityActive, boardActive, completed, completedAt,
  boardQuery, boardQueryRef, setBoardQuery, switchView, switchFocusRef, setTendOpen, setForkOpen,
  setShortcutsOpen, setShareOpen, newStepFromBoard, handleSheetJump, editorRef, showToast, reportBoardFailure,
  shareRequestRef, currentTreeIdRef, graphViewRef, identityActiveRef,
}) {
  const openRowTend = useCallback(() => setTendOpen(true), [setTendOpen]);
  const openRowFork = useCallback(() => setForkOpen(true), [setForkOpen]);
  const openRowShortcuts = useCallback(() => setShortcutsOpen(true), [setShortcutsOpen]);
  const openRowSettings = useCallback(() => navigate('/app/settings'), []);
  const openRowCreate = useCallback(() => newStepFromBoard('verbs'), [newStepFromBoard]);
  const onIdentityQuery = useCallback((change) => {
    const query = typeof change === 'function' ? change(boardQueryRef.current) : change;
    boardQueryRef.current = query;
    setBoardQuery(query);
    if (boardActive || !query.searching) return;
    switchView('board');
    switchFocusRef.current = false;
    track('roadmap_graph_find', { step: 'handoff' });
  }, [boardActive, switchView, boardQueryRef, setBoardQuery, switchFocusRef]);
  const identityFind = useMemo(() => ({ query: boardQuery, onQuery: onIdentityQuery }), [boardQuery, onIdentityQuery]);
  const identityBoard = useMemo(() => {
    if (!identityActive || !boardTree) return null;
    return new Board(boardTree, { completed, completedAt });
  }, [identityActive, boardTree, completed, completedAt]);
  const graphNext = identityBoard?.upNext ?? null;
  const identityNext = useMemo(() => graphNext
    ? { count: graphNext.count, cards: graphNext.cards, onOpen: handleSheetJump } : null,
  [graphNext, handleSheetJump]);
  const shareFromRow = useCallback(async () => {
    if (owner) {
      setShareOpen(true);
      return;
    }
    const url = treeShareUrl(treeId);
    if (!url) return;
    const graph = graphViewRef.current;
    const request = ++shareRequestRef.current;
    try {
      await navigator.clipboard.writeText(url);
      track('link_copy', {});
      if (request !== shareRequestRef.current || treeId !== currentTreeIdRef.current
        || graph !== graphViewRef.current || !identityActiveRef.current) return;
      showToast(LINK_COPIED, { surface: graph ? 'graph' : 'board', act: 'link', holdMs: 6000 });
      if (graph) track('roadmap_graph_toast', { act: 'link', step: 'shown' });
    } catch {
      track('roadmap_graph_toast', { act: 'link', outcome: 'failed' });
    }
  }, [owner, treeId, showToast, setShareOpen, shareRequestRef, currentTreeIdRef, graphViewRef, identityActiveRef]);
  const exportFromRow = useCallback(() => {
    const door = phone ? 'sheet' : 'more';
    try {
      const projection = editorRef.current?.treeData;
      if (!projection || !boardTree) {
        track('roadmap_export', { outcome: 'failed', door });
        return;
      }
      downloadExport(buildRoadmapExport({ ...projection, nodes: boardTree.nodes }, { completed }));
      track('roadmap_export', { outcome: 'done', door });
    } catch (error) {
      reportBoardFailure('roadmap-export', error);
      track('roadmap_export', { outcome: 'failed', door });
    }
  }, [phone, completed, boardTree, editorRef, reportBoardFailure]);
  const pickRoadmap = useCallback((id) => { window.location.hash = `#/app/${id}`; }, []);
  const newRoadmap = useCallback(() => { window.location.hash = '#/app/new'; }, []);
  const browseRoadmaps = useCallback(() => { window.location.hash = '#/browse'; }, []);
  const currentRoadmap = useMemo(() => ({
    id: treeId, title: tree?.title, done: shownStats?.done, total: shownStats?.total, dominantKind: shownStats?.dominantKind,
    upNext: identityBoard?.upNext.count, locked: identityBoard?.locked.count,
  }), [treeId, tree?.title, shownStats?.done, shownStats?.total, shownStats?.dominantKind, identityBoard]);
  const identitySheet = useMemo(() => ({
    listTrees: listAllTrees, current: currentRoadmap,
    onPickTree: pickRoadmap, onNewRoadmap: newRoadmap, onBrowse: browseRoadmaps,
  }), [currentRoadmap, pickRoadmap, newRoadmap, browseRoadmaps]);
  return {
    openRowTend, openRowFork, openRowShortcuts, openRowSettings, openRowCreate, identityFind, graphNext,
    identityNext, shareFromRow, exportFromRow, newRoadmap, currentRoadmap, identitySheet,
  };
}
