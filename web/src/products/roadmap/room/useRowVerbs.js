import { useCallback, useEffect, useMemo, useRef } from 'react';
import { navigate, requestNavigation } from '../../../shell/navigation.js';
import { track } from '../../../telemetry/beacon.js';
import { Board } from '../board/Board.js';
import { LINK_COPIED } from '../copy.js';
import { t } from '../i18n/index.js';
import { deleteTree, listAllTrees, renameTree } from '../persistence/TreeRegistry.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { buildRoadmapExport, downloadExport } from '../settings/exportArchive.js';
import { treeShareUrl } from '../share/ShareDialog.jsx';
import { deleteDeviceTree, deleteLocalTree, readDeviceTrees, renameLocalTree } from '../sync/localTrees.js';
import { withDeviceOpeners } from '../identity/deleteCost.js';

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
    document.title = pageTitle ? t('roadmap.room.pageTitle', { title: pageTitle }) : 'Windmill';
    return () => { document.title = 'Windmill'; };
  }, [pageTitle]);

  const onIdentityQuery = useCallback((change) => {
    const query = typeof change === 'function' ? change(boardQueryRef.current) : change;
    const apply = () => { boardQueryRef.current = query; setBoardQuery(query); };
    if (boardActive || !query.searching) { apply(); return; }
    return requestNavigation({ key: 'view:find', run: (tx) => {
      apply();
      switchView('board', { keepFocus: true, transaction: tx });
      track('roadmap_graph_find', { step: 'handoff' });
    } });
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
    if (feedVisible) {
      if (door === 'key') track('roadmap_verb', { verb: 'activity', door: 'key', view: boardActive ? 'board' : 'graph', band: breakpoint });
      closeRowActivity();
      return;
    }
    return requestNavigation({ key: 'view:activity', run: (tx) => {
      if (door === 'key') track('roadmap_verb', { verb: 'activity', door: 'key', view: boardActive ? 'board' : 'graph', band: breakpoint });
      if (breakpoint === 'desktop' && boardActive) switchView('tree', { keepFocus: true, transaction: tx });
      setSelectedId(null);
      openActivity();
    } });
  }, [activityEnabled, feedVisible, closeRowActivity, breakpoint, boardActive, switchView, setSelectedId, openActivity]);
  const openActivityStep = useCallback((id, transaction) => {
    const run = (tx) => {
      closeActivity();
      if (canvasView) graphStepReturnRef.current = true;
      address.open(id, 'activity', tx);
    };
    if (transaction) return run(transaction);
    return requestNavigation({ key: `step:open:${id}`, run });
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
    onPickTree: (id, transaction) => transaction ? transaction.navigate(`#/app/${id}`) : navigate(`#/app/${id}`),
    onNewRoadmap: newRoadmap,
    onBrowse: (transaction) => transaction ? transaction.navigate('#/browse') : navigate('#/browse'),
    activity: sheetActivity,
  }), [currentRoadmap, sheetActivity]);

  const switcher = {
    current: currentRoadmap,
    listTrees: listSwitcherTrees,
    onNew: newRoadmap,
    onPreviewTitle: (id, title) => {
      if (id === treeId) document.title = t('roadmap.room.pageTitle', { title: title.trim() || t('roadmap.common.untitled') });
    },
    // A local row renames the blob and device index; a server row goes through the registry.
    onRename: (id, title, { local = false } = {}) => {
      if (id === treeId && sessionRef.current?.renameTree(title)) return undefined;
      return local ? renameLocalTree(id, title) : renameTree(id, title);
    },
    // The server first, so a refused delete leaves the room live; then the session, or its pagehide flush resurrects the blob.
    // A tree that lives only here goes with the steps of the other trees here that open it, or not at all (deleteDeviceTree).
    onDelete: async (id, { local = false } = {}) => {
      if (local) return deleteDeviceTree(id, { live: sessionRef.current });
      await deleteTree(id);
      if (id === treeId) sessionRef.current?.close();
      return deleteLocalTree(id);
    },
  };

  return {
    switcher, activityEnabled, identityFind, graphNext, identityNext, shareFromRow, exportFromRow, currentRoadmap, identitySheet,
    closeRowActivity, openRowActivity, openActivityStep,
    openRowSettings: (transaction) => transaction?.navigate ? transaction.navigate('/app/settings') : navigate('/app/settings'),
  };
}

// The switcher's list, each row of a tree that lives only here with what deleting it takes, as the device counts it. A
// device read that fails, already reported, leaves those rows without it and the confirmation asks its question alone.
async function listSwitcherTrees() {
  const [rows, trees] = await Promise.all([listAllTrees(), readDeviceTrees().catch(() => null)]);
  return trees ? withDeviceOpeners(rows, trees) : rows;
}

function newRoadmap(transaction) {
  if (transaction?.navigate) return transaction.navigate('#/app/new');
  return navigate('#/app/new');
}
