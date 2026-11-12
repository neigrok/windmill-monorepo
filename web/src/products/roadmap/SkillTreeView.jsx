// The roadmap room: repository -> domain -> layout -> scene, with the Board and chrome around the canvas; room/ owns each concern.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useSignInDoor } from '../../shell/auth/SignInDoor.jsx';
import { Button, ErrorBoundary } from '../../design-system';
import { track } from '../../telemetry/beacon.js';
import { ActivityPanel } from './activity/ActivityRows.jsx';
import { ActorAvatar, EventSentence } from './activity/grammar.jsx';
import { useActivity } from './activity/useActivity.js';
import { BoardQuery } from './board/Board.js';
import { BoardToast } from './board/BoardToast.jsx';
import BoardView from './board/BoardView.jsx';
import { RoadmapIdentity, RoadmapIdentityFallback } from './identity/RoadmapIdentity.jsx';
import { GuideEntry } from './guide/GuideEntry.jsx';
import { GuideNote } from './guide/GuideNote.jsx';
import { useRoomGuide } from './guide/useGuide.js';
import { StepComposer } from './step/StepComposer.jsx';
import { StepDetail } from './step/StepDetail.jsx';
import { RefusedSync } from './sync/SyncNotices.jsx';
import { deletable, takesEveryRoot } from './board/acts.js';
import { ASK_AI_PLACEHOLDER, GRAPH_LOAD, GRAPH_UNAVAILABLE, LOAD_ERROR, forkedToast } from './copy.js';
import { t } from './i18n/index.js';
import { hashWithStep, useStepAddress } from './step/stepAddress.js';
import { BoardComposer, useBoardActs } from './board/useBoardActs.js';
import { CoachChip } from './demo/CoachChip.jsx';
import { COACHED_NODE_ID } from './demo/demoStage.js';
import { useDemoCoach } from './demo/useDemoCoach.js';
import { useGraphEditing } from './graph/useGraphEditing.js';
import { useGraphStructure } from './graph/useGraphStructure.js';
import { inUseCount, withCounts } from './model/Legend.js';
import { emptyWorkspace } from './model/NodeWorkspace.js';
import { UnlockRules } from './model/UnlockRules.js';
import { PasteComposer } from './paste/PasteComposer.jsx';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { listServerTrees, readTreeCard } from './persistence/TreeRegistry.js';
import { reportRoadmapFailure } from './reportFailure.js';
import { toastSeat, useRoadmapToast } from './room/useRoadmapToast.js';
import { useRoomAuthority } from './room/useRoomAuthority.js';
import { useRoomLoad } from './room/useRoomLoad.js';
import { useRoomProgress } from './room/useRoomProgress.js';
import { useRoomScene } from './room/useRoomScene.js';
import { useRoomView } from './room/useRoomView.js';
import { useRowVerbs } from './room/useRowVerbs.js';
import { useStepPage } from './room/useStepPage.js';
import { TreeDoor, readTreeVisit, useTreeVisit } from './room/useTreeVisit.js';
import { bulkKindChoice } from './model/bulkSelection.js';
import { useGraphSelection } from './graph/useGraphSelection.js';
import { ForkDoor } from './share/ForkDoor.jsx';
import { ShareDialog, treeShareUrl } from './share/ShareDialog.jsx';
import { ShareStats } from './share/ShareStats.js';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog.jsx';
import { useRoadmapKeys } from './shortcuts/useRoadmapKeys.js';
import { useRoomSyncNotices } from './sync/useRoomSyncNotices.js';
import { TendBar } from './tending/TendBar.jsx';
import { TendToast } from './tending/TendToast.jsx';
import { useRoomTend } from './tending/useTend.js';
import { EmptyGraphCard, GraphChrome, GraphSelectionBar } from './graph/GraphChrome.jsx';
import { GraphDocks } from './graph/GraphDocks.jsx';
import { StatusChip, VisitorNotice } from './room/HonestyChrome.jsx';
import { Minimap } from './graph/Minimap.jsx';
import { TreeSwitcher } from './identity/TreeSwitcher.jsx';
import { useTabletEditing } from './graph/tablet/useTabletEditing.js';
import { KindLegend } from './graph/tree/KindLegend.jsx';
import { useLegend } from './graph/tree/useLegend.js';
import { useWorkspace } from './graph/tree/useWorkspace.js';
import { useGraphGeometry } from './graph/useGraphGeometry.js';
import { useGraphStepBar } from './graph/useGraphStepBar.js';
import { useViewMode } from './room/useViewMode.js';
import { frontierTarget } from './graph/viewport.js';

const handle = () => ({ current: null });
// What the seams reach for after render: the live objects, the chrome's DOM, and what the camera has been asked to frame.
const roomHandles = () => ({ sceneRef: handle(), sessionRef: handle(), projectionRef: handle(), treeRef: handle(), standingTreeRef: handle(), viewRef: handle(), seedRef: handle(), peersRef: { current: new Map() } });
const chromeAnchors = () => ({ canvasRef: handle(), rootRef: handle(), identityRef: handle(), boardLayerRef: handle(), legendDockRef: handle() });
const cameraFraming = () => ({ insetsRef: handle(), firstFrameRef: handle(), graphRevealRef: handle() });

const leavesWithItsView = (toast) => toast.surface === 'board' || toast.surface === 'graph';

export function SkillTreeView({ treeId, demo = false }) {
  const openSignInDoor = useSignInDoor();
  const { breakpoint, shared } = useViewMode();
  const { status, refresh, account, confirmed: accountConfirmed, lapsed: sessionLapsed } = useAuth();
  const [room] = useState(roomHandles);
  const [anchors] = useState(chromeAnchors);
  const [framing] = useState(cameraFraming);
  const { sceneRef, sessionRef, projectionRef, peersRef } = room;
  const { canvasRef, rootRef, identityRef, boardLayerRef, legendDockRef } = anchors;

  // Who is looking, and what this device keeps for them.
  const knownReaderRef = useRef(false);
  const { lapsed, demotion, setDemotion } = useRoomAuthority({ treeId, status, account, refresh, knownReaderRef, room });
  const placeKept = !shared && breakpoint === 'desktop';
  const desktopEditorRef = useRef(false);
  const phone = breakpoint === 'phone';

  // What the room holds and does, whichever view it stands on.
  const selection = useGraphSelection(sceneRef);
  const { selectedId, selectedIds, selectedEdges, selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, selectAll, clearEdges, collapse } = selection;
  const { toast, showToast, toastShown, pauseToast, dismissToast, dismissToastIf, runToastAction } = useRoadmapToast();
  const legendKit = useLegend(room);
  const { legend, legendRef, highlightedKindId, highlightedKindIdRef, clearHighlightedKind } = legendKit;
  const { workspaceByNode, hydrateWorkspaces, pushArcs, ...workspaceActions } = useWorkspace(room);
  const activity = useActivity({ sceneRef, selectedId });
  const { emit, ticker, feedVisible, feedSummonedRef, closeActivity } = activity;
  const { coachAllowed, demoCompletions, ctaEcho, noteCompletion } = useDemoCoach({ demo, status });
  // What the history entry said of a tree visit as the room opened: a return to it is a step reached by going back.
  const [arrival] = useState(readTreeVisit);
  const stepAddress = useStepAddress(arrival.through === null ? 'link' : 'back');
  const [shareOpen, setShareOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShare = useCallback(() => setShareOpen(true), []);
  const openFork = useCallback(() => setForkOpen(true), []);
  const { progress, progressActs } = useRoomProgress({ ...room, treeId, demo, shared, demotion, emit, showToast, noteCompletion, openShare, band: breakpoint });
  const { completed, completedAt } = progress;
  const structure = useGraphStructure({ room, progressActs, showToast, syncLegendFromTree: legendKit.syncLegendFromTree });
  const { tree, renderModel, bounds, setBounds } = structure;
  const editing = useGraphEditing({ room, legendRef, desktopEditorRef, selection, emit, showToast });
  const { undo, redo, bulkDelete, deleteSelected, handleDeleteEdge, handleCreateRoot, graftImported, bulkRecolor, composerOpen, closeComposer, openComposer } = editing;

  // The canvas, then the tree it draws.
  const { scene, graphAvailability, panning, hoveredId } = useRoomScene({ anchors, sceneRef, desktopEditorRef, breakpoint, editing, selection, reorderHint: structure.reorderHint, onPickNothing: closeActivity, showToast });
  const graphUnavailable = graphAvailability === 'unavailable';
  const load = useRoomLoad({
    treeId, accountId: account?.id ?? null, demo, shared, demotion, breakpoint, placeKept, room, scene, framing, structure, progressActs, activity,
    legend: legendKit, workspace: { hydrateWorkspaces, pushArcs }, selection, dismissToast, desktopEditorRef,
    onRemoteProgress: (remote) => {
      const said = progressActs.adoptRemote(remote);
      if (!said) return;
      if (view.boardActive) showToast(said);
      else sceneRef.current?.announceCeremony(said);
    },
  });
  const { loading, loadError, syncSession, treeVisibility, setTreeVisibility, treeMine } = load;
  // A roadmap that loaded as someone else's reads as a share does, whichever address opened it.
  const knownReader = !loading && Boolean(tree) && !treeMine;
  knownReaderRef.current = knownReader;
  const desktopEditor = placeKept && !demotion && !knownReader;
  desktopEditorRef.current = desktopEditor;
  useEffect(() => { if (knownReader) sceneRef.current?.setReadOnly?.(); }, [knownReader, scene]);
  const states = useMemo(() => (tree ? UnlockRules.derive(tree, { completed }) : new Map()), [tree, completed]);
  useEffect(() => { sceneRef.current?.applyStates(states); }, [states]);
  const shareStats = useMemo(() => (tree ? ShareStats.from(tree, states) : null), [tree, states]);
  const nodesById = tree?.nodesById ?? new Map();
  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null;
  const selectedState = selectedId ? states.get(selectedId) ?? 'locked' : null;
  const bulkChoice = useMemo(() => bulkKindChoice(tree, [...selectedIds], legend), [tree, selectedIds, legend]);

  // Who this roadmap takes them for.
  const owner = treeMine && !shared && !demo && !demotion;
  const reader = Boolean(tree) && !demo && (!treeMine || Boolean(demotion));
  const tabletEditor = owner && breakpoint === 'tablet';
  const who = { owner, reader, role: demo ? 'demo' : owner ? 'owner' : 'reader', demo, shared, phone, breakpoint, desktopEditor, tabletEditor };
  const { canTend, tendOpen, setTendOpen, tendDraft, setTendDraft, tendWorking, tendFailure, submitTend } = useRoomTend({ treeId, treeMine, status, shared, demo, demotion, room, showToast });
  const tablet = useTabletEditing({ tabletEditor, scene, tree, nodesById, selectedNode, projectionRef, selection, editing });
  const { stopEditing } = tablet;

  // The view: Board or Graph.
  const [boardComposer, setBoardComposer] = useState(null);
  const onLeaveView = useCallback(() => {
    framing.graphRevealRef.current = null;
    dismissToastIf(leavesWithItsView, 'left');
    setBoardComposer(null);
  }, [dismissToastIf]);
  const onViewSwitched = useCallback((next) => {
    if (next === 'board') closeComposer();
    stopEditing();
    collapse();
  }, [closeComposer, stopEditing, collapse]);
  // The account that holds this room as its owner, once the server has answered for it in this document: a lapsed
  // session, a device's copy with nobody signed in and a start with no connection have none.
  const holder = owner && accountConfirmed && !lapsed ? account.id : null;
  const treeVisit = useTreeVisit({ room, arrival, holder, band: breakpoint });
  const view = useRoomView({ treeId, tree, loading, loadError, who, linkedStep: stepAddress.id, carried: treeVisit, scene, graphAvailability, anchors, onLeave: onLeaveView, onSwitched: onViewSwitched });
  const { decidedView, boardActive, canvasView, shownView, boardFacts, boardAwaitsRoadmap, switchView, onSwitchView } = view;
  room.viewRef.current = shownView;

  const graphMulti = canvasView && (selection.multiMode || selectedIds.size + selectedEdges.size > 1);
  const graphMultiRef = useRef(false);
  useEffect(() => {
    if (graphMulti === graphMultiRef.current) return;
    graphMultiRef.current = graphMulti;
    track('roadmap_board_select', { step: graphMulti ? 'start' : 'end', view: 'graph' });
  }, [graphMulti]);
  useEffect(() => { setBoardComposer(null); }, [shownView]);
  useEffect(() => {
    if (decidedView === null || !load.takeForkNote()) return;
    showToast(forkedToast({ count: tree.nodes.length }), { surface: decidedView === 'board' ? 'board' : 'graph', act: 'fork' });
  }, [decidedView]);

  // The Board's query, its acts and what a held delete projects.
  const [boardQuery, setBoardQuery] = useState(() => new BoardQuery());
  const [boardQuiet, setBoardQuiet] = useState(0);
  const [boardReveal, setBoardReveal] = useState(null);
  const [boardSelect, setBoardSelect] = useState(null);
  const selectRequestTaken = useCallback((key) => {
    setBoardSelect((current) => current?.key === key ? null : current);
  }, []);
  const crashBoard = useCallback((error) => {
    setBoardSelect(null);
    view.crashBoard(error);
  }, [view.crashBoard]);
  const boardSelectionOpen = phone && boardActive && owner;
  const [boardOverall, setBoardOverall] = useState(null);
  useEffect(() => { setBoardComposer(null); setBoardOverall(null); setBoardReveal(null); setBoardSelect(null); }, [treeId, load.reloadKey]);
  const { syncSnapshot, deviceLine, refusal } = useRoomSyncNotices({ treeId, syncSession, owner, status, lapsed: sessionLapsed || lapsed, phone, openSignInDoor, setBoardQuiet });
  const guide = useRoomGuide({ treeId, tree, who, holder, deviceLine, sessionRef });
  const guideView = boardActive ? 'board' : 'graph';
  const guideEntry = guide && !boardAwaitsRoadmap ? (
    <ErrorBoundary fallback={null} onCrash={(error) => reportRoadmapFailure('roadmap-guide', error)}>
      <GuideEntry guide={guide} band={breakpoint} view={guideView} />
    </ErrorBoundary>
  ) : null;
  const revealOnGraph = useCallback((id) => {
    if (selectedIdRef.current !== id) framing.graphRevealRef.current = id;
    else sceneRef.current?.revealNode(id);
    setSelectedId(id);
  }, [setSelectedId]);
  const { held: boardHeld, acts: boardActs } = useBoardActs({
    active: boardActive, graphActive: canvasView, owner, treeId, tree,
    progress, query: boardQuery, session: sessionRef.current,
    completeStep: (id, options) => progressActs.complete(id, { ...options, tree: boardTree }),
    restoreStep: (id, snapshot) => progressActs.restore(id, snapshot),
    showToast, setQuery: setBoardQuery, now: Date.now,
    receiptVersion: syncSnapshot?.receiptVersion,
    syncReady: syncSession?.ready,
    dismissInvalidatedToast: () => dismissToastIf((shown) => shown.action?.receipt),
    clearBoardToast: () => dismissToastIf((shown) => shown.surface === 'board' || (shown.surface === 'graph' && shown.act === 'delete')),
    onGraphReveal: revealOnGraph, graphFocusTarget: boardComposer?.opener,
    onReveal: (id) => setBoardReveal((current) => ({ id, key: (current?.key ?? 0) + 1 })),
    onQuiet: () => setBoardQuiet((current) => current + 1),
    openTree: treeVisit.open,
    band: breakpoint,
    track, emit, report: reportRoadmapFailure,
  });
  // Attaching, changing and detaching the tree a step opens: the holder's, while the session can take a write. A chosen
  // tree's row stands at once from what the picker knew of it, and a read the server refuses for want of a session is
  // the room's lapse, as a refused write is.
  const treeActs = holder !== null && syncSession?.ready && !syncSnapshot?.rebaselining ? {
    view: boardActive ? 'board' : 'graph',
    trees: { list: listServerTrees, read: readTreeCard },
    set: (id, chosen) => {
      if (chosen) load.knowTree(id, chosen);
      return boardActs.setTree(id, chosen?.id ?? '');
    },
    lapsed: () => window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'sign-in-required' } })),
  } : null;
  // Coming back from a step's tree lands on that step once the roadmap and its view stand: selected and in view on either one.
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current || decidedView === null || !tree) return;
    landedRef.current = true;
    if (!tree.nodesById.has(treeVisit.through)) return;
    if (decidedView === 'board') setBoardReveal((current) => ({ id: treeVisit.through, key: (current?.key ?? 0) + 1 }));
    else revealOnGraph(treeVisit.through);
  }, [decidedView, tree]);
  const explainGraphUnavailable = useCallback(() => {
    track('roadmap_graph_unavailable', { band: breakpoint });
    if (phone && !boardHeld) showToast(GRAPH_UNAVAILABLE);
  }, [breakpoint, phone, boardHeld, showToast]);
  const boardTree = useMemo(() => (boardHeld && tree ? boardHeld.projected(tree) : tree), [boardHeld, tree]);
  room.standingTreeRef.current = boardTree;
  const heldGraphModel = useMemo(() => {
    if (!canvasView || !boardHeld || !boardTree || !renderModel) return renderModel;
    const positions = new Map(renderModel.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    return boardTree.toRenderModel(positions, UnlockRules.derive(boardTree, { completed }));
  }, [canvasView, boardHeld, boardTree, renderModel, completed]);
  const graphHeldRef = useRef(false);
  useEffect(() => {
    const held = canvasView && boardHeld !== null;
    if (!held && !graphHeldRef.current) return;
    graphHeldRef.current = held;
    if (heldGraphModel) sceneRef.current?.applyModel(heldGraphModel);
  }, [canvasView, boardHeld, heldGraphModel]);
  const boardStats = useMemo(() => (boardTree ? ShareStats.from(boardTree, UnlockRules.derive(boardTree, { completed })) : null), [boardTree, completed]);
  const shownStats = boardActive ? { ...boardStats, ...(boardOverall ?? {}) } : shareStats;

  // A step open over either view, and the composer that writes one.
  const stepPage = useStepPage({
    treeId, tree, loading, address: stepAddress, setSelectedId, view, anchors, sceneRef, boardActs, boardTree, setBoardQuery, setBoardSelect,
    viewBranch: (id) => setBoardQuery((query) => query.inBranch(id)),
    onGraphStepOpen: () => { framing.firstFrameRef.current = null; },
  });
  const { detailId, focusGraph, focusLayer } = stepPage;
  const shownDetailId = detailId !== null && boardTree?.nodesById.has(detailId) ? detailId : null;
  const newStepFromBoard = useCallback((door = 'verbs') => {
    if (!owner) return;
    setBoardComposer({ door, view: boardActive ? 'board' : 'tree', opener: document.activeElement });
    track('roadmap_board_create', { step: 'open', door, view: boardActive ? 'board' : 'graph' });
  }, [boardActive, owner]);
  const composerDoor = new BoardComposer({ view: canvasView ? 'tree' : 'board', owner, detailId: shownDetailId, composer: boardComposer, acts: boardActs, onOpen: setBoardComposer });
  const shownComposer = composerDoor.shown;
  if (boardComposer !== null && shownComposer === null) setBoardComposer(null);
  const stepCovering = detailId !== null || boardComposer !== null;
  // A step's link opens for anyone only where the roadmap itself does: public or unlisted, on the server.
  const stepShareUrl = !demo && (treeVisibility === 'public' || treeVisibility === 'unlisted') ? treeShareUrl(treeId) : null;

  // The row, the phone's bar and where each piece of chrome stands.
  const phoneGraph = phone && canvasView;
  useEffect(() => {
    if (phoneGraph && selectedId) sceneRef.current?.revealNode(selectedId);
  }, [phoneGraph, selectedId]);
  const forkPresent = (reader || demo) && !demotion?.cardOpen;
  const { graphStep, forkPillShown, openGraphFork, rememberGraphFocus } = useGraphStepBar({ phoneGraph, selection, selectedNode, selectedState, covered: stepCovering, forkPresent, forkOpen, setForkOpen, rootRef, canvasRef, focusGraph });
  const verbs = useRowVerbs({
    treeId, tree, boardTree, shownStats, who, view, boardQuery, setBoardQuery, progress, activity, graphUnavailable, address: stepAddress,
    graphStepReturnRef: stepPage.graphStepReturnRef, anchors, room, revealOnGraph, setSelectedId, setShareOpen, showToast,
  });
  const legendWithCounts = useMemo(() => withCounts(legend, tree?.nodes ?? []), [legend, tree]);
  const legendVisible = useMemo(() => inUseCount(legend, tree?.nodes ?? []) >= 2, [legend, tree]) || legendKit.legendForceOpen;
  const activityOpen = owner && feedVisible;
  const dockOpen = !phone && (composerOpen || (canvasView && (!!selectedNode || activityOpen)));
  const geometry = useGraphGeometry({
    breakpoint, canvasView, dockOpen, refusal, forkPillShown, graphStepShown: Boolean(graphStep), scene, selectedId, renderModel,
    toastKey: toast?.key ?? null, tendOpen, activityOpen, legendVisible, anchors, framing,
  });
  const { topbarBottom, setTopbarBottom, insets } = geometry;

  // The room's toast, wherever it stands.
  const seat = toastSeat(toast, { canvasView, stepOpen: shownDetailId !== null });
  useEffect(() => {
    if (toast?.surface === 'graph' && !canvasView) dismissToast();
  }, [toast?.surface, canvasView, dismissToast]);
  const revealGraphToast = () => {
    if (!toast?.reveal) return;
    track('roadmap_board_toast_reveal', { act: toast.act, view: 'graph' });
    revealOnGraph(toast.reveal);
  };
  const undoGraphToast = useCallback(() => {
    const origin = toast?.focusTarget;
    runToastAction(toast);
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      if (origin !== document.body && origin?.isConnected && !origin.closest('[inert]')) {
        origin.focus({ preventScroll: true });
        if (document.activeElement === origin) return;
      }
      identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus({ preventScroll: true });
    });
  }, [toast, runToastAction]);

  const focusCamera = () => {
    if (scene && tree) scene.focusWorking(selectedIdRef.current ?? frontierTarget(tree, { completed, completedAt }));
  };
  const showAllSteps = () => {
    if (!scene) return;
    scene.fitToView();
    setBounds(scene.getBounds());
  };
  const keyboardCovered = useCallback(() => stepCovering || composerOpen || document.querySelector('[aria-modal="true"]') !== null, [stepCovering, composerOpen]);
  useRoadmapKeys({
    canTend, tendOpen, setTendOpen, desktopEditor, boardActive, band: breakpoint, undo, redo, focusCamera, showAllSteps,
    activityEnabled: verbs.activityEnabled, openActivity: verbs.openRowActivity,
    covered: keyboardCovered,
    // G follows the switch from 744px, for either role.
    switchViews: !graphUnavailable && !phone && onSwitchView ? () => switchView(boardActive ? 'tree' : 'board') : null,
    toggleShortcuts: () => setShortcutsOpen((visible) => !visible),
    openComposer,
    selectEveryStep: () => selectAll(projectionRef.current?.nodes.map((node) => node.id) ?? []),
    focusFind: () => {
      const find = identityRef.current?.querySelector('.st-board-find-input');
      const folded = identityRef.current?.querySelector('.st-board-find-toggle');
      if (find) find.focus();
      else folded?.click();
      return Boolean(find || folded);
    },
    stepBack: () => {
      if (highlightedKindIdRef.current) clearHighlightedKind();
      else if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) setSelectedId(null);
      else if (sceneRef.current?.selectedEdge) sceneRef.current.selectEdge(null);
      else if (feedSummonedRef.current) verbs.closeRowActivity();
    },
    deleteSelection: () => {
      const edge = sceneRef.current?.selectedEdge;
      if (selectedIdsRef.current.size + selectedEdgesRef.current.size > 1) bulkDelete();
      else if (selectedIdRef.current) deleteSelected();
      else if (edge) {
        handleDeleteEdge(edge.from, edge.to);
        clearEdges();
      } else return false;
      return true;
    },
  });

  const activityPanel = activityOpen && breakpoint === 'tablet' ? (
    <ActivityPanel top={geometry.activityPanelTop} groups={activity.activityGroups} nodesById={nodesById} onClose={verbs.closeRowActivity} onOpenStep={verbs.openActivityStep} />
  ) : null;
  return (
    <TreeDoor.Provider value={treeVisit.open}>
    <div className={`st-root ${panning ? 'panning' : ''}`} ref={rootRef} onFocusCapture={rememberGraphFocus}>
      <canvas
        ref={canvasRef}
        className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''} ${decidedView !== null ? 'st-canvas--layer' : ''}`}
        style={boardActive ? { opacity: 0, pointerEvents: 'none' } : undefined}
      />

      {desktopEditor && (
        <PresenceLayer peersRef={peersRef} scene={scene} canvasRef={canvasRef} sessionRef={sessionRef} selection={selectedId} />
      )}

      {desktopEditor && tree && tree.nodes.length === 0 && !boardActive && <EmptyGraphCard onAddFirstStep={handleCreateRoot} />}

      <div className="st-roadmap-identity-host" ref={identityRef}>
        <ErrorBoundary
          fallback={<RoadmapIdentityFallback view={boardActive ? 'board' : 'tree'} phone={phone} onSwitchView={onSwitchView} graphUnavailable={graphUnavailable} onGraphUnavailable={explainGraphUnavailable} onBottom={setTopbarBottom} />}
          onCrash={(error) => reportRoadmapFailure('roadmap-identity', error)}
        >
          <RoadmapIdentity
            band={breakpoint}
            view={boardActive ? 'board' : 'tree'}
            role={who.role}
            title={boardAwaitsRoadmap ? undefined : tree?.title}
            back={treeVisit.from === null ? null : { title: treeVisit.from.title, onBack: treeVisit.back }}
            switcher={owner && !phone && !boardAwaitsRoadmap ? <TreeSwitcher {...verbs.switcher} /> : null}
            progress={boardAwaitsRoadmap || !shownStats ? null : { done: shownStats.done, total: shownStats.total }}
            onSwitchView={onSwitchView}
            graphUnavailable={graphUnavailable}
            onGraphUnavailable={explainGraphUnavailable}
            find={!phone && boardFacts.loaded && !boardFacts.empty ? verbs.identityFind : null}
            next={canvasView && owner && !phone && verbs.graphNext?.count > 0 ? verbs.identityNext : null}
            onAskAI={canTend && owner ? () => setTendOpen(true) : null}
            onShare={!boardAwaitsRoadmap && tree ? verbs.shareFromRow : null}
            onNewStep={owner && boardFacts.loaded ? () => newStepFromBoard('verbs') : null}
            onExport={owner && boardFacts.loaded ? verbs.exportFromRow : null}
            onSettings={owner ? verbs.openRowSettings : null}
            onShortcuts={owner ? () => setShortcutsOpen(true) : null}
            onActivity={verbs.activityEnabled ? verbs.openRowActivity : null}
            activityOpen={activityOpen}
            onFork={!owner && forkPresent ? openFork : null}
            sheet={phone && owner && boardFacts.loaded ? verbs.identitySheet : null}
            onBottom={setTopbarBottom}
          />
        </ErrorBoundary>
      </div>

      {view.boardMounted && (
        <div ref={boardLayerRef} className={`st-view-layer st-view-layer--board ${boardActive ? 'is-active' : ''}`}>
          <ErrorBoundary fallback={graphUnavailable ? undefined : null} onCrash={crashBoard}>
            <BoardView
              tree={boardTree}
              completed={completed}
              completedAt={completedAt}
              loading={loading}
              failed={loadError}
              selectedId={selectedId}
              onSelect={stepPage.openFromBoard}
              onAnchor={setSelectedId}
              refusal={refusal}
              deviceLine={phone ? deviceLine : null}
              guide={boardActive ? guideEntry : null}
              onFork={phone && forkPresent ? openFork : null}
              breakpoint={breakpoint}
              topInset={topbarBottom}
              active={boardActive}
              onRetry={load.retryLoad}
              onShare={owner ? openShare : undefined}
              onNewStep={owner ? newStepFromBoard : undefined}
              onComplete={owner ? (id, door) => boardActs.complete(id, door) : undefined}
              editable={boardActive && owner}
              onRecolor={owner ? (ids, hue) => boardActs.recolor(ids, hue) : undefined}
              onDelete={owner ? (ids, door) => boardActs.delete(ids, door) : undefined}
              quiet={boardQuiet}
              onDisplayedOverall={setBoardOverall}
              reveal={boardReveal}
              wake={treeVisit.view === 'board' ? treeVisit.through : null}
              selectionOpen={boardSelectionOpen}
              selectRequest={stepAddress.id === null ? boardSelect : null}
              onSelectRequestTaken={selectRequestTaken}
              toast={seat === 'board' ? toast : null}
              onToastShown={toastShown}
              onToastReveal={() => boardActs.revealToast(toast)}
              onToastUndo={() => { runToastAction(toast); focusLayer(); }}
              query={boardQuery}
              onQuery={setBoardQuery}
              legend={legend}
            />
          </ErrorBoundary>
          {boardActive && activityPanel}
        </div>
      )}

      {shownDetailId !== null && (
        <ErrorBoundary fallback={null} onCrash={stepPage.crash}>
          <StepDetail
            tree={boardTree}
            completed={completed}
            completedAt={completedAt}
            address={stepAddress}
            breakpoint={breakpoint}
            roadmapTitle={tree.title}
            editable={owner}
            deletable={deletable(boardTree, [detailId])}
            onEdit={owner ? (id) => composerDoor.openEdit(id) : undefined}
            treeActs={treeActs}
            stepLink={stepShareUrl && `${stepShareUrl}${hashWithStep('', detailId)}`}
            workspace={workspaceByNode[detailId] ?? emptyWorkspace()}
            workspaceActions={workspaceActions}
            history={activity.selectedHistory}
            onOpenStep={(id) => stepAddress.open(id, 'step')}
            onBack={stepAddress.back}
            onClose={stepPage.close}
            onComplete={(id) => progressActs.complete(id, { quiet: true })}
            onReset={(id) => progressActs.reset(id)}
            onRestore={(id, snapshot) => {
              setBoardQuiet((current) => current + 1);
              progressActs.restore(id, snapshot);
            }}
            onOpenInGraph={boardActive && !graphUnavailable ? stepPage.openInGraph : null}
            onSelect={boardSelectionOpen && deletable(boardTree, [detailId]) ? stepPage.select : null}
            onViewBranch={stepPage.viewBranch}
            onDelete={stepPage.deleteStep}
            onDeletePrompt={(step) => boardActs.deletePrompt(step)}
            onNotify={showToast}
          />
        </ErrorBoundary>
      )}

      {shownComposer !== null && (
        <ErrorBoundary fallback={null} onCrash={(error) => {
          reportRoadmapFailure('roadmap-board-composer', error);
          setBoardComposer(null);
          focusLayer();
        }}>
          <StepComposer key={shownComposer.editing ?? 'create'} tree={boardTree} completed={completed} legend={legend} band={breakpoint}
            editing={shownComposer.editing ?? null} savingBlocked={Boolean(syncSnapshot?.rebaselining)} onEdit={(request) => composerDoor.saveEdit(request)}
            onCreate={(request) => boardActs.create(request)} onClose={() => setBoardComposer(null)} />
        </ErrorBoundary>
      )}

      {geometry.graphRefusalShown && (
        <div ref={geometry.attachGraphRefusal} className={`st-graph-refusal${phone ? ' st-graph-refusal--phone' : ''}`}
          style={geometry.graphRefusalStyle}>
          <RefusedSync band={breakpoint} {...refusal} />
        </div>
      )}

      <GraphChrome band={breakpoint} view={canvasView ? 'tree' : 'board'} rowBottom={topbarBottom}
        onTopBottom={geometry.setGraphChromeBottom}
        step={graphStep}
        ctaEcho={demo && ctaEcho}
        onOpenStep={stepPage.openFromGraph}
        onBarBottom={geometry.setGraphBarBottom}
        deviceLine={phone ? deviceLine : null}
        guide={canvasView ? guideEntry : null}
        guideTop={geometry.guideTop}
        guideRight={insets.right}
        onGuideBox={geometry.publishGuideCard}
        cameraRight={phone || !canvasView ? undefined : insets.blocks.at(-1)?.right}
        cameraBottom={phone || !canvasView ? undefined : insets.blocks.at(-1)?.bottom}
        onZoomIn={() => sceneRef.current?.zoomBy(1.2)}
        onZoomOut={() => sceneRef.current?.zoomBy(1 / 1.2)}
        onFocus={focusCamera}
        onShowAll={showAllSteps}
        onFork={forkPresent && phoneGraph ? openGraphFork : undefined} />

      {/* After the Graph's chrome, so the entry the note opens over is already in place when it measures it. */}
      {guide?.opened && (
        <ErrorBoundary fallback={null} onCrash={(error) => {
          reportRoadmapFailure('roadmap-guide', error);
          guide.close();
        }}>
          <GuideNote guide={guide} band={breakpoint} view={guideView} onSeat={canvasView ? geometry.publishGuideNote : undefined} />
        </ErrorBoundary>
      )}

      {canTend && tendOpen && (
        <TendBar
          presentation={phone ? 'docked' : 'overlay'}
          topInset={geometry.tendTopInset}
          working={tendWorking}
          value={tendDraft}
          onChange={setTendDraft}
          failure={tendFailure}
          placeholder={tree?.nodes.length > 0 ? (phone ? ASK_AI_PLACEHOLDER.phone : ASK_AI_PLACEHOLDER.wide) : ASK_AI_PLACEHOLDER.empty}
          examples={tree?.nodes.length > 0 ? [t('roadmap.askAI.exampleRealistic'), t('roadmap.askAI.exampleMissing')] : []}
          onSubmit={submitTend}
          onDismiss={() => setTendOpen(false)}
          portalTarget={rootRef.current?.closest('.wm-shell') ?? document.body}
        />
      )}

      {canvasView && <Minimap
        nodes={heldGraphModel?.nodes ?? []}
        states={states}
        bounds={bounds}
        subscribeViewport={scene?.subscribeViewport ?? null}
        onPanTo={(x, y) => sceneRef.current?.panTo(x, y)}
      />}

      {legendVisible && (
        <div ref={legendDockRef} className="st-legend-dock" style={{ position: 'absolute', left: 'var(--space-6)', bottom: 'calc(var(--space-6) + 196px)', zIndex: 16 }}>
          <KindLegend
            kinds={legendWithCounts}
            defaultOpen={legendKit.legendOpen}
            onOpenChange={legendKit.onLegendOpenChange}
            selectedId={highlightedKindId}
            onHighlight={legendKit.onHighlightKind}
            {...(desktopEditor ? {
              onRename: legendKit.onRenameKind,
              onRecolor: legendKit.onRecolorKind,
              onAdd: legendKit.onAddKind,
              onRemove: legendKit.onRemoveKind,
              onDescribe: legendKit.onDescribeKind,
            } : {})}
          />
        </div>
      )}

      {canvasView && activityPanel}

      <GraphDocks
        who={who}
        open={dockOpen}
        top={geometry.dockTop}
        canvasView={canvasView}
        tree={tree}
        standingTree={boardTree}
        states={states}
        selection={selection}
        selectedNode={selectedNode}
        selectedState={selectedState}
        progress={progress}
        legend={legend}
        editing={editing}
        progressActs={progressActs}
        tablet={tablet}
        bulkChoice={bulkChoice}
        composer={composerOpen && editing.draftParse ? (
          <PasteComposer
            append
            text={editing.draft}
            onTextChange={editing.setDraft}
            kinds={editing.draftKinds}
            onKindsChange={editing.setDraftKinds}
            parse={editing.draftParse}
            planting={false}
            onClose={closeComposer}
            onPlant={(parse) => graftImported(parse, canvasView ? 'graph' : 'board')}
          />
        ) : null}
        activity={activity}
        onCloseActivity={verbs.closeRowActivity}
        workspaceByNode={workspaceByNode}
        workspaceActions={workspaceActions}
        onJump={revealOnGraph}
        sceneRef={sceneRef}
        hoveredId={hoveredId}
        onLegendPicker={legendKit.openLegendFromPicker}
      />

      {demotion && !demotion.cardOpen && (
        <div style={{ position: 'absolute', top: 'calc(max(env(safe-area-inset-top, 0px), 44px) + 8px)', left: '50%', transform: 'translateX(-50%)', zIndex: 21 }}>
          <StatusChip>
            {demotion.edits > 0 ? t('roadmap.demotion.readOnlyKept', { count: demotion.edits }) : t('roadmap.demotion.readOnly')}
          </StatusChip>
        </div>
      )}

      {demotion?.cardOpen && (
        <VisitorNotice
          edits={demotion.edits}
          author={tree?.author}
          onFork={() => {
            track('roadmap_verb', { verb: 'fork', door: 'notice', view: canvasView ? 'graph' : 'board', band: breakpoint });
            setDemotion((d) => d && { ...d, cardOpen: false });
            setForkOpen(true);
          }}
          onDismiss={() => setDemotion((d) => d && { ...d, cardOpen: false })}
          onSignIn={openSignInDoor}
        />
      )}

      {(reader || demo) && (
        <ForkDoor open={forkOpen} presentation={phone ? 'sheet' : 'dialog'} treeId={treeId} signedIn={status === 'signed-in'} stepCount={shareStats?.total} onClose={() => setForkOpen(false)} />
      )}

      {demo && coachAllowed && scene && canvasView && (
        <CoachChip
          scene={scene}
          nodeId={COACHED_NODE_ID}
          onMarkDone={() => {
            track('roadmap_board_complete', { door: 'coach' });
            progressActs.complete(COACHED_NODE_ID);
          }}
          completionCount={demoCompletions}
          covered={keyboardCovered}
          bottomChrome={geometry.phoneGraphBottom}
        />
      )}

      {canvasView && desktopEditor && selectedIds.size + selectedEdges.size > 1 && (
        <GraphSelectionBar
          stepCount={selectedIds.size}
          linkCount={selectedEdges.size}
          choice={bulkChoice}
          onPreviewKind={(hue) => sceneRef.current?.previewKindSet([...selectedIdsRef.current], hue)}
          onRestoreKind={() => sceneRef.current?.restoreKindSet([...selectedIdsRef.current])}
          onRecolor={(hue) => bulkRecolor(hue, { silent: true })}
          onMarkDone={() => progressActs.markDone(selectedIdsRef.current)}
          onPreviewDelete={() => sceneRef.current?.previewDeleteCostSet([...selectedIdsRef.current])}
          onClearDelete={() => sceneRef.current?.clearDeleteCost()}
          onDelete={takesEveryRoot(boardTree, [...selectedIds]) ? null : bulkDelete}
        />
      )}

      {seat === 'room' && (
        <div className={`st-graph-toast${phone ? ' st-graph-toast--phone' : ''}`} style={shownDetailId === null ? geometry.graphToastStyle : undefined}>
          <BoardToast toast={toast} phone={phone} blocked={phone && Boolean(refusal)} onToastShown={toastShown} onToastReveal={revealGraphToast}
            onToastUndo={undoGraphToast} />
        </div>
      )}

      {toast?.surface === 'tend' && (
        <TendToast key={toast.key} toast={toast} overCanvas={canvasView} style={geometry.graphToastStyle}
          onShown={toastShown} onPause={pauseToast} onAct={() => runToastAction(toast)} />
      )}

      {canvasView && ticker.length > 0 && (
        <div className="st-ticker" role="status" aria-live="polite">
          {ticker.map((event) => (
            <div className="st-ticker-item" key={event.id}>
              <ActorAvatar event={event} size={20} />
              <span><EventSentence event={event} node={nodesById.get(event.nodeId) ?? null} /></span>
            </div>
          ))}
        </div>
      )}

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} readOnly={!desktopEditor} owner={owner} view={boardActive ? 'board' : 'graph'} graphAvailable={!graphUnavailable} />

      <ShareDialog
        key={treeId}
        treeId={treeId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        visibility={treeVisibility}
        mine={treeMine}
        onStanceChange={setTreeVisibility}
      />

      {loading && !loadError && !boardActive && <div className="st-loading"><span className="st-loading-msg">{GRAPH_LOAD.planting}</span></div>}
      {loadError && !boardActive && (
        <div className="st-load-error">
          <p className="st-loading-msg">{LOAD_ERROR.title}. {LOAD_ERROR.body}</p>
          <div className="st-load-error-actions">
            <Button onClick={load.retryLoad}>{LOAD_ERROR.action}</Button>
            <a href="#/app" className="st-load-error-link">{GRAPH_LOAD.home}</a>
          </div>
        </div>
      )}
    </div>
    </TreeDoor.Provider>
  );
}
