import { useCallback, useEffect, useMemo, useRef } from 'react';
import { navigate } from '../../../shell/navigation.js';
import { track } from '../../../telemetry/beacon.js';
import { Board } from '../board/Board.js';
import { LINK_COPIED } from '../copy.js';
import { t } from '../i18n/index.js';
import { deleteTree, listAllTrees, renameTree } from '../persistence/TreeRegistry.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { buildRoadmapExport, downloadExport } from '../settings/exportArchive.js';
import { treeShareUrl } from '../share/ShareDialog.jsx';
import { deleteLocalTree, renameLocalTree } from '../sync/localTrees.js';

// What the identity row reads and does: Find's handoff, the Next chip, the switcher, the phone's sheet and its verbs.
export function useRowVerbs({ treeId, tree, boardTree, shownStats, who, view, boardQuery, setBoardQuery, progress, activity, graphUnavailable = false, address, graphStepReturnRef, anchors: { identityRef }, room: { sessionRef, projectionRef }, revealOnGraph, setSelectedId, setShareOpen, showToast }) {
  const { owner, phone, breakpoint } = who;
  const { boardActive, canvasView, switchView } = view;
  const { completed, completedAt } = progress;
  const { feedVisible, activityGroups, openActivity, closeActivity } = activity;
  const activityEnabled = owner && !phone && !(graphUnavailable && breakpoint === 'desktop');
  const boardQueryRef = useRef(boardQuery);
  boardQueryRef.current = boardQuery;
  const shareRequestRef = useRef(0);
  const currentTreeIdRef = useRef(treeId);
  currentTreeIdRef.current = treeId;
  const graphViewRef = useRef(canvasView);
  graphViewRef.current = canvasView;
  useEffect(() => () => { shareRequestRef.current += 1; }, [treeId, canvasView]);

  const pageTitle = tree?.title?.trim();
  useEffect(() => {
    document.title = pageTitle ? t('roadmap.pageTitle', { title: pageTitle }) : 'Windmill';
    return () => { document.title = 'Windmill'; };
  }, [pageTitle]);

  const onIdentityQuery = useCallback((change) => {
    const query = typeof change === 'function' ? change(boardQueryRef.current) : change;
    boardQueryRef.current = query;
    setBoardQuery(query);
    if (boardActive || !query.searching) return;
    switchView('board', { keepFocus: true });
    track('roadmap_graph_find', { step: 'handoff' });
  }, [boardActive, switchView, setBoardQuery]);
  const identityFind = useMemo(() => ({ query: boardQuery, onQuery: onIdentityQuery }), [boardQuery, onIdentityQuery]);

  const identityBoard = useMemo(() => {
    if (!boardTree) return null;
    return new Board(boardTree, { completed, completedAt });
  }, [boardTree, completed, completedAt]);
  const graphNext = identityBoard?.upNext ?? null;
  const identityNext = useMemo(() => graphNext
    ? { count: graphNext.count, cards: graphNext.cards, onOpen: revealOnGraph } : null,
  [graphNext, revealOnGraph]);

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
      if (request !== shareRequestRef.current || treeId !== currentTreeIdRef.current || graph !== graphViewRef.current) return;
      showToast(LINK_COPIED, { surface: graph ? 'graph' : 'board', act: 'link', holdMs: 6000 });
      if (graph) track('roadmap_graph_toast', { act: 'link', step: 'shown' });
    } catch {
      track('roadmap_graph_toast', { act: 'link', outcome: 'failed' });
    }
  }, [owner, treeId, showToast, setShareOpen]);

  const exportFromRow = useCallback(() => {
    const door = phone ? 'sheet' : 'more';
    try {
      const projection = projectionRef.current;
      if (!projection || !boardTree) {
        track('roadmap_export', { outcome: 'failed', door });
        return;
      }
      downloadExport(buildRoadmapExport({ ...projection, nodes: boardTree.nodes }, { completed }));
      track('roadmap_export', { outcome: 'done', door });
    } catch (error) {
      reportRoadmapFailure('roadmap-export', error);
      track('roadmap_export', { outcome: 'failed', door });
    }
  }, [phone, completed, boardTree]);

  const closeRowActivity = useCallback(() => {
    closeActivity();
    requestAnimationFrame(() => identityRef.current?.querySelector('[data-roadmap-more]')?.focus({ preventScroll: true }));
  }, [closeActivity]);
  const openRowActivity = useCallback((door) => {
    if (!activityEnabled) return;
    if (door === 'key') track('roadmap_verb', { verb: 'activity', door: 'key', view: boardActive ? 'board' : 'graph', band: breakpoint });
    if (feedVisible) {
      closeRowActivity();
      return;
    }
    if (breakpoint === 'desktop' && boardActive) switchView('tree', { keepFocus: true });
    setSelectedId(null);
    openActivity();
  }, [activityEnabled, feedVisible, closeRowActivity, breakpoint, boardActive, switchView, setSelectedId, openActivity]);
  const openActivityStep = useCallback((id) => {
    closeActivity();
    if (canvasView) graphStepReturnRef.current = true;
    address.open(id, 'activity');
  }, [closeActivity, canvasView, address.open]);

  const currentRoadmap = useMemo(() => ({
    id: treeId, title: tree?.title, done: shownStats?.done, total: shownStats?.total, dominantKind: shownStats?.dominantKind,
    upNext: identityBoard?.upNext.count, locked: identityBoard?.locked.count,
  }), [treeId, tree?.title, shownStats?.done, shownStats?.total, shownStats?.dominantKind, identityBoard]);
  const sheetActivity = useMemo(() => owner && phone
    ? { groups: activityGroups, nodesById: tree?.nodesById ?? new Map(), onOpenStep: openActivityStep }
    : null, [owner, phone, activityGroups, tree, openActivityStep]);
  const identitySheet = useMemo(() => ({
    listTrees: listAllTrees, current: currentRoadmap,
    onPickTree: (id) => { window.location.hash = `#/app/${id}`; },
    onNewRoadmap: newRoadmap,
    onBrowse: () => { window.location.hash = '#/browse'; },
    activity: sheetActivity,
  }), [currentRoadmap, sheetActivity]);

  const switcher = {
    current: currentRoadmap,
    listTrees: listAllTrees,
    onNew: newRoadmap,
    onPreviewTitle: (id, title) => {
      if (id === treeId) document.title = t('roadmap.pageTitle', { title: title.trim() || t('roadmap.untitled') });
    },
    // A local row renames the blob and device index; a server row goes through the registry.
    onRename: (id, title, { local = false } = {}) => {
      if (id === treeId && sessionRef.current?.renameTree(title)) return undefined;
      return local ? renameLocalTree(id, title) : renameTree(id, title);
    },
    // The server first, so a refused delete leaves the room live; then the session, or its pagehide flush resurrects the blob.
    onDelete: async (id, { local = false } = {}) => {
      if (!local) await deleteTree(id);
      if (id === treeId) sessionRef.current?.close();
      await deleteLocalTree(id);
    },
  };

  return {
    switcher, activityEnabled, identityFind, graphNext, identityNext, shareFromRow, exportFromRow, currentRoadmap, identitySheet,
    closeRowActivity, openRowActivity, openActivityStep,
    openRowSettings: () => navigate('/app/settings'),
  };
}

function newRoadmap() {
  window.location.hash = '#/app/new';
}
