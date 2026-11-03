// The roadmap room: repository -> domain -> layout -> scene, with the Board and the chrome around the GPU canvas.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog.jsx';
import { TreeSwitcher } from './ui/TreeSwitcher.jsx';
import { StepPanel } from './ui/StepPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { useViewMode } from './ui/useViewMode.js';
import { StatusChip, VisitorNotice } from './ui/HonestyChrome.jsx';
import { EmptyGraphCard, GraphChrome, GraphDock, GraphSelectionBar, FORK_PILL } from './ui/GraphChrome.jsx';
import { useGraphGeometry } from './ui/useGraphGeometry.js';
import { TendBar } from './tending/TendBar.jsx';
import { useRoomTend } from './tending/useTend.js';
import { TabletPanel } from './ui/tablet/TabletPanel.jsx';
import BoardView from './board/BoardView.jsx';
import { coverBeneath } from './board/composerFocus.js';
import { BoardQuery, COLUMN_OF_STATE } from './board/Board.js';
import { RoadmapIdentity, RoadmapIdentityFallback } from './board/RoadmapIdentity.jsx';
import { BoardToast } from './board/BoardToast.jsx';
import { useRoadmapToast } from './board/useRoadmapToast.js';
import { completedToast, completedStepsToast, ASK_AI_PLACEHOLDER, ROADMAP_VERBS, LABELS } from './board/copy.js';
import { useRoadmapIdentityActs } from './useRoadmapIdentityActs.js';
import { useRoomAuthority } from './useRoomAuthority.js';
import { StepDetail } from './board/StepDetail.jsx';
import { titleOf } from './board/StepFacts.js';
import { StepComposer } from './board/StepComposer.jsx';
import { BoardComposer, useBoardActs } from './board/useBoardActs.js';
import { countBucket, deletable } from './board/acts.js';
import { RefusedSync } from './board/SyncNotices.jsx';
import { useRoomSyncNotices } from './sync/useRoomSyncNotices.js';
import { useStepAddress, hashWithStep, stepIsStale } from './board/stepAddress.js';
import { useTabletEditing } from './ui/tablet/useTabletEditing.js';
import { markDoneTargets, sharedKind } from './selection/bulkSelection.js';
import { useGraphSelection } from './selection/useGraphSelection.js';
import { ForkDoor } from './share/ForkDoor.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useSignInDoor } from '../../shell/auth/SignInDoor.jsx';
import { ShareDialog, treeShareUrl } from './share/ShareDialog.jsx';
import { ShareStats } from './share/ShareStats.js';
import { ActivityFeed } from './activity/ActivityFeed.jsx';
import { ActivityRows } from './activity/ActivityRows.jsx';
import { useActivity } from './activity/useActivity.js';
import { ActorAvatar, EventSentence } from './activity/grammar.jsx';
import { SkillTree } from './model/SkillTree.js';
import { UnlockRules } from './model/UnlockRules.js';
import { layoutNameFrom, loadLayoutEngine } from './layout/index.js';
import { frontierTarget, viewportInsets } from './ui/viewport.js';
import { HttpTreeRepository } from './persistence/HttpTreeRepository.js';
import { listAllTrees, renameTree, deleteTree } from './persistence/TreeRegistry.js';
import { SyncSession } from './sync/SyncSession.js';
import { refusalEventCode, isExpectedRefusal } from './sync/refusals.js';
import { renameLocalTree, deleteLocalTree, loadDeviceTree } from './sync/localTrees.js';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { LocalTreeRegistry, resolveDeviceOwner } from './persistence/LocalTreeRegistry.js';
import { PlaceStore } from './persistence/PlaceStore.js';
import { ViewPrefs, initialView, boardCanShow, viewToShow, peekBorn, clearBorn } from './persistence/ViewPrefs.js';
import { ReturnLedger } from './persistence/ReturnLedger.js';
import { MilestoneLedger } from './persistence/MilestoneLedger.js';
import { detectMilestones } from './model/milestones.js';
import { advanceProgress, progressChanges, milestoneAnnouncement } from './model/progress.js';
import { emptyWorkspace } from './model/NodeWorkspace.js';
import { withCounts, inUseCount } from './model/Legend.js';
import { KindLegend } from './ui/tree/KindLegend.jsx';
import { useLegend } from './ui/tree/useLegend.js';
import { useWorkspace } from './ui/tree/useWorkspace.js';
import { Button, ErrorBoundary, Icon, IconButton } from '../../design-system';
import { PasteComposer } from './paste/PasteComposer.jsx';
import { parsePlan } from './paste/planGrammar.js';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { useGraphEditing } from './editing/useGraphEditing.js';
import { useGraphStructure } from './editing/useGraphStructure.js';
import { NODE_COLOR_NAMES, DEFAULT_NODE_COLOR, WORKING_ZOOM, PHONE_WORKING_ZOOM } from './theme.js';
import { track } from '../../telemetry/beacon.js';
import { captureError } from '../../telemetry/sentry.js';
import { useRoadmapKeys } from './shortcuts/useRoadmapKeys.js';
import { CoachChip } from './demo/CoachChip.jsx';
import { useDemoCoach } from './demo/useDemoCoach.js';
import { DEMO_TREE_ID, DEMO_STAGED_COMPLETED, COACHED_NODE_ID, FORKED_FROM_DEMO_KEY, DEMO_COPY } from './demo/demoStage.js';

const deviceTrees = new LocalTreeRegistry();
const placeStore = new PlaceStore();
const viewPrefs = new ViewPrefs();
const FORK_PILL_FOOTPRINT = FORK_PILL.bottom + FORK_PILL.height;
const returnLedger = new ReturnLedger();
const milestoneLedger = new MilestoneLedger();
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const PLANTED_QUEST_KEY = 'windmill:planted-quest';

function consumeSessionFlag(key) {
  try {
    if (sessionStorage.getItem(key) !== '1') return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function reportBoardFailure(operation, error) {
  const stack = typeof error?.stack === 'string' && error.stack.trim()
    ? error.stack
    : new Error(operation).stack;
  captureError('roadmap', operation, stack, '#/app');
}

export function SkillTreeView({ treeId, demo = false }) {
  const openSignInDoor = useSignInDoor();
  const { breakpoint, desktopEditor: desktopView, shared } = useViewMode();
  const { status, refresh, account, lapsed: sessionLapsed } = useAuth();

  // Who is looking, and what this room holds for them.
  const identityRef = useRef(null);
  const activityActsRef = useRef(null);
  const graphStepReturnRef = useRef(false);
  const graphBarFocusedRef = useRef(false);
  const rememberGraphFocus = useCallback((event) => {
    graphBarFocusedRef.current = Boolean(event.target.closest('[data-graph-step-bar]'));
  }, []);
  const graphViewRef = useRef(false);
  const currentTreeIdRef = useRef(treeId);
  currentTreeIdRef.current = treeId;
  const shareRequestRef = useRef(0);
  useEffect(() => () => { shareRequestRef.current += 1; }, [treeId]);

  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const focusGraph = useCallback(() => {
    const primary = rootRef.current?.querySelector('[data-graph-step-primary]');
    const pressed = identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]');
    (primary ?? pressed)?.focus({ preventScroll: true });
  }, []);
  const sceneRef = useRef(null);
  const editorRef = useRef(null);
  const treeRef = useRef(null);
  const firstFrameRef = useRef(null); // { id, at } — the step the first view opened on, until the chrome has measured itself
  const graphRevealRef = useRef(null);
  useEffect(() => { graphRevealRef.current = null; }, [treeId]);
  const insetsRef = useRef(null); // the live chrome insets, for the first view: the load lands long after the chrome has
  const legendDockRef = useRef(null);
  const completedRef = useRef(new Set());
  const seedRef = useRef(null);
  const collabRef = useRef(null);
  const { lapsed, demotion, setDemotion } = useRoomAuthority({ treeId, status, account, refresh, collabRef, sceneRef });
  const desktopEditor = desktopView && !demotion;
  const desktopEditorRef = useRef(desktopEditor);
  const [syncSession, setSyncSession] = useState(null);
  const peersRef = useRef(new Map()); // actor -> { name, color, cursor, selection }
  const onTreeChangedRef = useRef(null);
  const applyRemoteProgressRef = useRef(null);

  const plantedQuestRef = useRef(null); // null until consumed; survives StrictMode’s double effect
  const forkedFromDemoRef = useRef(null);
  const demoRef = useRef(demo);
  useEffect(() => { demoRef.current = demo; }, [demo]);
  const {
    selectedId, selectedIds, selectedEdges, multiMode,
    selectedIdRef, selectedIdsRef, selectedEdgesRef,
    setSelectedId, selectAll, clearEdges, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick,
    enterMulti, leaveMulti, toggleMember, collapse,
  } = useGraphSelection(sceneRef);
  const { toast, toastWhyOpen, setToastWhyOpen, toastTimersRef, boardToastRef, showToast, boardToastShown, dismissToast } = useRoadmapToast();
  const composerOpenRef = useRef(false);

  const {
    legend, legendRef, legendOpen, legendForceOpen, highlightedKindId, highlightedKindIdRef,
    hydrateLegend, syncLegendFromTree, clearHighlightedKind,
    onRenameKind, onDescribeKind, onAddKind, onRemoveKind, onRecolorKind,
    onHighlightKind, onLegendOpenChange, openLegendFromPicker,
  } = useLegend({ seedRef, collabRef, editorRef, sceneRef });

  const { workspaceByNode, hydrateWorkspaces, pushArcs, ...workspaceActions } = useWorkspace({ seedRef, sceneRef });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [completedAt, setCompletedAt] = useState(() => ({})); // { nodeId: ms }
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);
  const [autoFocusNameId, setAutoFocusNameId] = useState(null);

  const [reloadKey, setReloadKey] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [topbarBottom, setTopbarBottom] = useState(0); // px
  const [graphChromeBottom, setGraphChromeBottom] = useState(0);
  const [graphBarBottom, setGraphBarBottom] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [treeVisibility, setTreeVisibility] = useState(null); // 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [panning, setPanning] = useState(false);
  const [view, setView] = useState(null); // 'tree' | 'board' | null when undecided
  const [boardCrashed, setBoardCrashed] = useState(false);
  const [boardComposer, setBoardComposer] = useState(null);
  const [boardReveal, setBoardReveal] = useState(null);
  const [boardQuiet, setBoardQuiet] = useState(0);
  const [boardOverall, setBoardOverall] = useState(null);
  useEffect(() => { setBoardComposer(null); setBoardOverall(null); setBoardReveal(null); }, [treeId, reloadKey]);
  const boardActiveRef = useRef(false);
  const boardSwitchRef = useRef(null); // G's switch while the desktop offers one, else null
  const [boardQuery, setBoardQuery] = useState(() => new BoardQuery()); // sort, kinds, search and branch, for this visit
  const boardQueryRef = useRef(boardQuery);
  boardQueryRef.current = boardQuery;
  const viewBranch = useCallback((id) => setBoardQuery((query) => query.inBranch(id)), []); // a step's View branch
  const stepDetailOpenRef = useRef(false); // '/' and G wait while a step's page or modal is open
  const keyboardCovered = useCallback(() => stepDetailOpenRef.current || composerOpenRef.current
    || document.querySelector('[aria-modal="true"]') !== null, []);
  const switchFocusRef = useRef(false);
  const switchOptionRef = useRef(null);
  const { coachAllowed, demoCompletions, ctaEcho, noteCompletion } = useDemoCoach({ demo, status });

  // The tree and its picture.
  const states = useMemo(() => {
    if (!tree) return new Map();
    return UnlockRules.derive(tree, { completed });
  }, [tree, completed]);

  const shareStats = useMemo(() => (tree ? ShareStats.from(tree, states) : null), [tree, states]);

  // Records only that THIS DEVICE witnessed these completions; callers pass freshly computed values, since state setters are async.
  const witnessProgress = useCallback((next) => {
    if (demoRef.current) return;
    if (!seedRef.current?.mine || shared || demotion) return;
    returnLedger.save(seedRef.current.id, { completed: [...next.completed], at: Date.now() });
  }, [shared, demotion]);

  const { canTend, tendOpen, setTendOpen, tendWorking, submitTend } = useRoomTend({ treeId, treeMine, status, shared, demo, demotion, collabRef, sceneRef, showToast });

  const handlePanStateChange = useCallback((isPanning) => setPanning(isPanning), []);

  const {
    emit, seedActivity, ticker, newEventIds,
    feedVisible, feedSummonedRef, activityGroups, selectedHistory, eventCount,
    openActivity, closeActivity,
  } = useActivity({ sceneRef, selectedId });

  const { layoutRef, layoutCacheRef, layoutPositions, onTreeChanged } = useGraphStructure({
    editorRef, sceneRef, treeRef, collabRef, completedRef, showToast, syncLegendFromTree, setTree, setRenderModel, setBounds,
  });
  onTreeChangedRef.current = onTreeChanged;

  const pageTitle = tree?.title?.trim();
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} — Windmill` : 'Windmill';
    return () => { document.title = 'Windmill'; };
  }, [pageTitle]);
  const previewTreeTitle = useCallback((id, title) => {
    if (id !== treeId) return;
    document.title = `${title.trim() || 'Untitled roadmap'} — Windmill`;
  }, [treeId]);

  // A local row renames the blob + device index and never PATCHes the server; a server row goes through the registry.
  const handleRenameTree = useCallback((id, title, { local = false } = {}) => {
    if (id === treeId && collabRef.current?.renameTree(title)) return undefined;
    if (local) return renameLocalTree(id, title);
    return renameTree(id, title);
  }, [treeId]);

  // Deleting the open tree must close the session FIRST, or its pagehide flush resurrects the blob.
  const handleDeleteTree = useCallback(async (id, { local = false } = {}) => {
    if (id === treeId) collabRef.current?.close();
    if (!local) await deleteTree(id);
    await deleteLocalTree(id);
  }, [treeId]);

  const {
    undo, redo, handleRename, handleCreateChild, handleCreateRoot, handleConnect, handleDeleteEdge, handleReconnect,
    deleteNodeAt, deleteSelected, bulkDelete, handleSetKind, reorderContext, handleSetNodeOrder, bulkRecolor, graftImported,
  } = useGraphEditing({
    collabRef, editorRef, sceneRef, treeRef, legendRef, desktopEditorRef,
    selection: { selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, leaveMulti },
    emit, showToast, setAutoFocusNameId, setComposerOpen,
  });

  // The scene is constructed once; React drives it through the methods below.
  useEffect(() => {
    const editing = !desktopEditorRef.current ? {} : {
      onCreateChild: handleCreateChild,
      onConnectNodes: handleConnect,
      onDeleteNode: deleteNodeAt,
      onSetKind: handleSetKind,
      onDeleteEdge: handleDeleteEdge,
      onReconnectEdge: handleReconnect,
      onSelectionToggle,
      onMarqueeSelect,
      onEdgeToggle,
      onEdgePick,
      reorderContext,
      onSetNodeOrder: handleSetNodeOrder,
    };
    const nextScene = new SkillTreeScene(canvasRef.current, {
      readOnly: !desktopEditorRef.current,
      reorderHint: layoutCacheRef.current.result?.engine.constructor.reorder ?? 'none',
      onPanStateChange: handlePanStateChange,
      onNodePick: (id) => {
        if (id) { setSelectedId(id); return; }
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) setSelectedId(null);
        else closeActivity();
      },
      onNodeHover: (id) => setHoveredId(id),
      onCeremonyToast: showToast,
      ...editing,
    });
    if (plantedQuestRef.current === null) plantedQuestRef.current = consumeSessionFlag(PLANTED_QUEST_KEY);
    if (plantedQuestRef.current) nextScene.setArrivalNoun('Quest');
    if (forkedFromDemoRef.current === null) forkedFromDemoRef.current = consumeSessionFlag(FORKED_FROM_DEMO_KEY);
    if (forkedFromDemoRef.current) nextScene.setArrivalSummary(DEMO_COPY.forkToast);
    sceneRef.current = nextScene;
    setScene(nextScene);
    nextScene.start();

    const observer = new ResizeObserver(() => nextScene.resize());
    observer.observe(rootRef.current);

    return () => {
      observer.disconnect();
      nextScene.dispose();
      sceneRef.current = null;
      setScene(null);
    };
  }, [handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, showToast, handlePanStateChange, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick]);

  useEffect(() => {
    scene?.setWorkingZoom(breakpoint === 'phone' ? PHONE_WORKING_ZOOM : WORKING_ZOOM);
  }, [scene, breakpoint]);

  // Focus: the working zoom on the selected step, else on the frontier. All steps: the whole tree.
  const handleFocus = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene || !tree) return;
    scene.focusWorking(selectedIdRef.current ?? frontierTarget(tree, { completed, completedAt }));
  }, [tree, completed, completedAt]);

  const handleShowAll = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.fitToView();
    setBounds(scene.getBounds());
  }, []);

  useRoadmapKeys({
    canTend, tendOpen, setTendOpen, keyboardCovered, activityActsRef, boardActiveRef, boardSwitchRef, desktopEditorRef, composerOpenRef,
    identityRef, sceneRef, editorRef, legendRef, feedSummonedRef, highlightedKindIdRef, clearHighlightedKind,
    selectedIdRef, selectedIdsRef, selectedEdgesRef, setSelectedId, selectAll, clearEdges,
    undo, redo, deleteSelected, bulkDelete, handleDeleteEdge, handleFocus, handleShowAll,
    setShortcutsOpen, setDraftKinds, setDraft, setComposerOpen,
  });

  useEffect(() => {
    if (!scene || !desktopView) return undefined;
    let timer = null;
    const unsubscribe = scene.subscribeViewport(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!seedRef.current) return;
        placeStore.save({ treeId, layout: layoutRef.current.name, camera: scene.getViewpoint(), selectedId: selectedIdRef.current });
      }, 400);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [scene, treeId, desktopView]);

  useEffect(() => {
    if (!desktopView || loading || !seedRef.current) return;
    placeStore.save({ treeId, layout: layoutRef.current.name, camera: sceneRef.current?.getViewpoint?.() ?? null, selectedId });
  }, [selectedId, loading, treeId, desktopView]);

  useEffect(() => {
    if (autoFocusNameId && selectedId !== autoFocusNameId) setAutoFocusNameId(null);
  }, [selectedId, autoFocusNameId]);

  useEffect(() => {
    let cancelled = false;
    let unknownTree = false;
    const wanted = new AbortController();
    const { signal } = wanted;
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);
    setTreeVisibility(null);
    setTreeMine(false);
    firstFrameRef.current = null;

    async function loadTree() {
      const layoutName = layoutNameFrom(window.location);
      const engine = await loadLayoutEngine(layoutName);
      if (cancelled) return;
      layoutRef.current = { requestedName: layoutName, name: engine.constructor.layoutName, engine };
      const repo = new HttpTreeRepository({ treeId });
      // Confirm who holds this device before anything is read from it or written to it.
      await resolveDeviceOwner();
      let seed = null;
      try { seed = await repo.loadTree({ signal }); } catch { /* fall through to the blob */ }
      if (cancelled) return;
      if (!seed) {
        seed = await loadDeviceTree(treeId);
        if (!seed) {
          unknownTree = true;
          throw new Error(`tree ${treeId}: unknown to the server, and not this device's to open`);
        }
      }
      const treeData = seed;
      const nextTree = new SkillTree(treeData);
      const overlay = demo
        ? { completed: new Set(DEMO_STAGED_COMPLETED), completedAt: {}, server: false }
        : await repo.loadProgress(treeData, { signal });
      const serverActivity = await repo.loadActivity({ limit: 200, signal });
      if (cancelled) return;
      const states = UnlockRules.derive(nextTree, overlay);
      const positions = layoutPositions(nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
      const priorLedger = !demo && desktopEditorRef.current ? returnLedger.load(seed.id) : null;
      const sinceIds = ReturnLedger.since(overlay.completed, priorLedger, states);
      if (sinceIds.length) {
        scene.armReturnRecap(sinceIds, `Welcome back · ${sinceIds.length} step${sinceIds.length > 1 ? 's' : ''} done since your last visit`);
      }
      // The first view: a saved place is restored (clamped to the zoom range); the owner with none opens on the
      // frontier at the working zoom, no glide; a visitor keeps the whole-tree fit and the arrival ceremony.
      const place = desktopView ? placeStore.load(layoutRef.current.name) : null;
      const returning = place?.treeId === seed.id ? place : null;
      const savedCamera = returning?.camera
        && [returning.camera.x, returning.camera.y, returning.camera.zoom].every(Number.isFinite)
        ? returning.camera : null;
      const restoredSelection = returning?.selectedId && treeData.nodes.some((n) => n.id === returning.selectedId)
        ? returning.selectedId : null;
      const owner = seed.mine === true && !shared && !demo;
      const opensOnFrontier = !savedCamera && owner;
      if (opensOnFrontier) scene.suppressArrival();
      const justPlanted = !demo && (plantedQuestRef.current || forkedFromDemoRef.current || peekBorn(seed.id));
      if (!justPlanted) scene.suppressArrivalToast();
      scene.setModel(model);
      if (savedCamera) scene.restoreViewpoint(savedCamera);
      if (opensOnFrontier) {
        const target = frontierTarget(nextTree, overlay, { selectedId: restoredSelection });
        scene.setViewportInsets(insetsRef.current ?? viewportInsets({ breakpoint, dockOpen: !!restoredSelection && desktopView }));
        scene.focusWorking(target, { instant: true });
        firstFrameRef.current = { id: target, at: Date.now(), camera: scene.getViewpoint() };
      }

      editorRef.current = new TreeEditor(treeData);
      treeRef.current = nextTree;
      seedRef.current = seed;
      completedRef.current = new Set(overlay.completed);
      seedActivity({ tree: nextTree, states, completedAt: overlay.completedAt, serverActivity });
      setTree(nextTree);
      setRenderModel(model);
      setTreeVisibility(seed.visibility ?? null);
      setTreeMine(seed.mine ?? false);
      setCompleted(new Set(overlay.completed));
      setCompletedAt(overlay.completedAt);
      hydrateWorkspaces(seed.id);
      hydrateLegend(seed.id, nextTree.nodes, seed.kinds ?? null);
      pushArcs();
      setBounds(scene.getBounds());
      if (restoredSelection) setSelectedId(restoredSelection);
      if (desktopView) placeStore.save({ treeId: seed.id, layout: layoutRef.current.name, camera: scene.getViewpoint(), selectedId: restoredSelection });
      if (!demo && desktopEditorRef.current) returnLedger.save(seed.id, { completed: [...overlay.completed], at: Date.now() });
      setLoading(false);
      if (shared && seed.id === DEMO_TREE_ID) track('demo_open', { treeId: seed.id });

      // Only owned trees enter the device index, so a visited share cannot be claimed.
      collabRef.current?.close();
      peersRef.current.clear();
      const session = new SyncSession({ treeId: seed.id, title: seed.title, registry: seed.mine && !shared && !demo && !demotion ? deviceTrees : null })
        .onTreeChanged((data) => onTreeChangedRef.current?.(data))
        .onPresence((frame) => peersRef.current.set(frame.actor, {
          name: frame.profile?.name, color: frame.profile?.color,
          cursor: frame.cursor ?? null, selection: frame.selection ?? null,
        }))
        .onPeer((frame) => {
          if (frame.event === 'leave') { peersRef.current.delete(frame.actor); return; }
          if (!peersRef.current.has(frame.actor)) {
            peersRef.current.set(frame.actor, { name: frame.profile?.name, color: frame.profile?.color, cursor: null, selection: null });
          }
        })
        .onProgress((overlay) => applyRemoteProgressRef.current?.(overlay));
      collabRef.current = session;
      const reportedCodes = new Set();
      session.subscribeRefusals((refused) => {
        if (isExpectedRefusal(refused)) return;
        const code = refusalEventCode(refused);
        if (reportedCodes.has(code)) return;
        reportedCodes.add(code);
        captureError('roadmap', 'roadmap-sync-refused', new Error('Roadmap sync refused').stack, '#/app', { code });
      });
      setSyncSession(session);
      session.start();
    }

    // The repository reports its own transport failures, and a tree neither the server nor this device has is an
    // expected answer; anything else that stops the load reports `roadmap-load`.
    loadTree().catch((err) => {
      if (cancelled) return;
      console.warn('[tree] load failed', treeId, err);
      if (!unknownTree) captureError('roadmap', 'roadmap-load', err?.stack ?? '', '#/app');
      setLoadError(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      wanted.abort();
      if (boardToastRef.current) {
        boardToastRef.current.onLeave?.('left');
        dismissToast();
      }
      collabRef.current?.close();
      collabRef.current = null;
      setSyncSession(null);
    };
  }, [reloadKey, treeId, demo, dismissToast]);

  const legendWithCounts = useMemo(() => (tree ? withCounts(legend, tree.nodes) : []), [legend, tree, states]);
  const inUse = useMemo(() => (tree ? inUseCount(legend, tree.nodes) : 0), [legend, tree, states]);
  const legendVisible = inUse >= 2 || legendForceOpen;
  const recolorKinds = legend.length > 0 ? legend : NODE_COLOR_NAMES.map((hue) => ({ id: hue, hue }));

  useEffect(() => {
    sceneRef.current?.applyStates(states);
  }, [states]);

  useEffect(() => { completedRef.current = completed; }, [completed]);
  useEffect(() => { desktopEditorRef.current = desktopEditor; }, [desktopEditor]);
  useEffect(() => { composerOpenRef.current = composerOpen; }, [composerOpen]);

  const nodesById = useMemo(() => {
    if (!tree) return new Map();
    return new Map(tree.nodes.map((node) => [node.id, node]));
  }, [tree]);

  const ringedKind = useMemo(
    () => sharedKind([...selectedIds].map((id) => nodesById.get(id)?.color ?? DEFAULT_NODE_COLOR)),
    [selectedIds, nodesById],
  );

  const handleRowHover = useCallback((id) => sceneRef.current?.spotlightNode(id), []);
  const handleRowLeave = useCallback(() => sceneRef.current?.spotlightNode(null), []);
  const handleRevealNode = useCallback((id) => sceneRef.current?.revealNode(id), []);

  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null;
  const selectedState = selectedId ? states.get(selectedId) ?? 'locked' : null;
  // Only a SINGLE root gives up Delete and Mark done; never re-derive this from parentlessness.
  const singleRootId = useMemo(() => {
    const roots = tree?.roots() ?? [];
    return roots.length === 1 ? roots[0].id : null;
  }, [tree]);

  const prerequisites = useMemo(() => {
    if (!selectedNode) return [];
    return selectedNode.prerequisites.map((id) => {
      const node = nodesById.get(id);
      return {
        id,
        label: node?.label ?? id,
        color: node?.color,
        state: states.get(id) ?? 'locked',
        complete: states.get(id) === 'complete',
      };
    });
  }, [selectedNode, nodesById, states]);

  const unlocks = useMemo(() => {
    if (!selectedNode || !tree) return [];
    return tree.nodes
      .filter((node) => node.prerequisites.includes(selectedNode.id))
      .map((node) => ({
        id: node.id,
        label: node.label,
        color: node.color,
        state: states.get(node.id) ?? 'locked',
        complete: states.get(node.id) === 'complete',
      }));
  }, [selectedNode, tree, states]);

  const handleSheetJump = useCallback((id) => {
    if (selectedIdRef.current !== id) graphRevealRef.current = id;
    else sceneRef.current?.revealNode(id);
    setSelectedId(id);
  }, [setSelectedId]);

  // The view: Board or Graph, decided once the moment the tree is ready.
  const phone = breakpoint === 'phone';
  const owner = treeMine && !shared && !demo && !demotion;
  const tabletEditor = owner && breakpoint === 'tablet';
  const reader = Boolean(tree) && !demo && (!treeMine || Boolean(demotion));
  const role = demo ? 'demo' : owner ? 'owner' : 'reader';
  const tablet = useTabletEditing({
    tabletEditor, scene, tree, nodesById, selectedNode, collabRef, editorRef,
    selection: { multiMode, selectedIdRef, setSelectedId, enterMulti, toggleMember },
    editing: { undo, handleRename, handleCreateChild, handleConnect, handleDeleteEdge, handleSetKind },
    showToast,
  });
  const { stopEditing } = tablet;
  const stepAddress = useStepAddress();
  const initialDecisionRef = useRef(null);
  const viewOpenedRef = useRef(null);
  if (view === null && tree) {
    const decision = initialView({ saved: viewPrefs.lastView(treeId), owner, reader, empty: tree.nodes.length === 0, born: peekBorn(treeId), linkedStep: stepAddress.id, canAddFirstStep: owner });
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
  const openingView = view ?? initialView({ saved: viewPrefs.lastView(treeId), owner: !shared && !demo, reader, empty: false, born: peekBorn(treeId), linkedStep: stepAddress.id }).view;
  const boardFacts = {
    crashed: boardCrashed,
    loaded: !loading && !loadError && !!tree,
    empty: tree?.nodes.length === 0,
    canAddFirstStep: owner,
  };
  const shownView = viewToShow(openingView, boardFacts);
  const boardActive = shownView === 'board';
  boardActiveRef.current = boardActive;
  useEffect(() => { setBoardComposer(null); }, [shownView]);

  // The Board stays mounted through a reload or an emptied tree, so Done's fold survives (its columns, and their scroll,
  // give way to the skeleton or the empty roadmap); only a crash drops it.
  const boardShownRef = useRef(false);
  if (boardActive) boardShownRef.current = true;
  const boardMounted = !boardCrashed && boardShownRef.current;
  const boardLayerRef = useRef(null);
  useEffect(() => (boardActive ? coverBeneath(boardLayerRef.current) : undefined), [boardActive]);

  const canvasView = !boardActive;
  graphViewRef.current = canvasView;

  const graphMulti = canvasView && (multiMode || selectedIds.size + selectedEdges.size > 1);
  const graphMultiRef = useRef(false);
  useEffect(() => {
    if (graphMulti === graphMultiRef.current) return;
    graphMultiRef.current = graphMulti;
    track('roadmap_board_select', { step: graphMulti ? 'start' : 'end', view: 'graph' });
  }, [graphMulti]);

  const switchView = useCallback((next) => {
    if (next !== shownView) {
      graphRevealRef.current = null;
      shareRequestRef.current += 1;
      boardToastRef.current?.onLeave?.('left');
      if (boardToastRef.current) dismissToast();
      setBoardComposer(null);
    }
    if (next === 'board') {
      setBoardCrashed(false);
      setComposerOpen(false);
    }
    setView(next);
    viewPrefs.setLastView(treeId, next);
    track('roadmap_view_switch', { view: next === 'board' ? 'board' : 'graph' });
    stopEditing();
    collapse();
    switchFocusRef.current = true;
    const active = document.activeElement;
    switchOptionRef.current = active?.classList.contains('st-board-switch-option') ? active : null;
  }, [treeId, stopEditing, collapse, dismissToast, shownView]);

  // A switch keeps focus on the option it pressed; a key or a crash lands on the pressed option the row now shows.
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

  const retryLoad = useCallback(() => setReloadKey((key) => key + 1), []);

  const newStepFromBoard = useCallback((door = 'verbs') => {
    if (!owner) return;
    const view = boardActive ? 'board' : 'tree';
    setBoardComposer({ door, view, opener: document.activeElement });
    track('roadmap_board_create', { step: 'open', door, view: boardActive ? 'board' : 'graph' });
  }, [boardActive, owner]);

  const handleBoardCrash = useCallback((error) => {
    captureError('roadmap', 'roadmap-board', error?.stack ?? '', '#/app');
    setBoardCrashed(true);
    setBoardComposer(null);
    setView('tree');
  }, []);
  useEffect(() => {
    if (boardCrashed) identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus();
  }, [boardCrashed]);

  // A card opens its step: the modal from 744px, the pushed page below. The step rides the URL, so a link lands on it and
  // Back leaves it; selection follows the open step and, on close, returns to the card the visit began on.
  const detailId = tree?.treeId === treeId && stepAddress.id !== null && tree.nodesById.has(stepAddress.id) ? stepAddress.id : null;
  stepDetailOpenRef.current = detailId !== null || boardComposer !== null;
  // A step the loaded roadmap no longer holds (deleted here or elsewhere, or a stale link) leaves the URL, so restoring
  // it later never reopens it.
  const staleStep = stepIsStale({ loading, tree, treeId, stepId: stepAddress.id });
  useEffect(() => {
    if (staleStep) stepAddress.drop();
  }, [staleStep, stepAddress.drop]);
  useEffect(() => {
    if (detailId !== null) setSelectedId(detailId);
  }, [detailId, setSelectedId]);
  const openStepFromBoard = useCallback((id) => {
    setSelectedId(id);
    stepAddress.open(id, 'card');
  }, [setSelectedId, stepAddress.open]);
  const openStepFromGraph = useCallback((id) => {
    firstFrameRef.current = null;
    graphStepReturnRef.current = true;
    stepAddress.open(id, 'graph');
  }, [stepAddress.open]);
  useEffect(() => {
    if (detailId !== null || !graphStepReturnRef.current) return;
    graphStepReturnRef.current = false;
    const frame = requestAnimationFrame(focusGraph);
    return () => cancelAnimationFrame(frame);
  }, [detailId, focusGraph]);
  const closeStep = () => {
    const origin = stepAddress.trail[0];
    stepAddress.close();
    if (origin && nodesById.has(origin)) setSelectedId(origin);
  };
  const openStepInGraph = (id) => {
    stepAddress.close();
    setSelectedId(id);
    switchView('tree');
    sceneRef.current?.revealNode(id);
  };
  const viewBranchFromDetail = (id) => {
    stepAddress.close();
    viewBranch(id);
  };
  const focusBoard = () => requestAnimationFrame(() => {
    if (canvasView) {
      focusGraph();
      return;
    }
    const stops = boardLayerRef.current?.querySelectorAll('[data-column] [tabindex="0"], [data-column][tabindex="0"], .st-board-state button') ?? [];
    [...stops].find((element) => element.getClientRects().length > 0)?.focus();
  });
  const deleteStepFromDetail = (id) => {
    stepAddress.close();
    const held = boardActs.delete([id], 'menu');
    if (held && canvasView) setSelectedId(null);
  };
  const handleStepCrash = (error) => {
    captureError('roadmap', 'roadmap-board-step', error?.stack ?? '', '#/app');
    stepAddress.close();
    focusBoard();
  };
  // A step's link opens for anyone only where the roadmap itself does: public or unlisted, on the server.
  const stepShareUrl = !demo && (treeVisibility === 'public' || treeVisibility === 'unlisted') ? treeShareUrl(treeId) : null;

  useEffect(() => {
    if (!phone || !canvasView || !selectedId) return;
    sceneRef.current?.revealNode(selectedId);
  }, [phone, canvasView, selectedId]);

  // stop() only cancels the RAF; applyModel runs fine while stopped and renders on the first frame after start().
  useEffect(() => {
    if (!scene) return undefined;
    if (boardActive) scene.stop(); else scene.start();
    return undefined;
  }, [scene, boardActive]);

  const forkPresent = (reader || demo) && !demotion?.cardOpen;
  const phoneGraph = phone && canvasView;
  const singleGraphStep = phoneGraph && selectedNode && selectedIds.size === 1 && selectedEdges.size === 0;
  const graphStepVisible = singleGraphStep && detailId === null && boardComposer === null;
  const graphStep = graphStepVisible
    ? { id: selectedNode.id, title: titleOf(selectedNode), state: COLUMN_OF_STATE[selectedState] ?? 'locked' }
    : null;
  const forkPillPresent = forkPresent && phoneGraph && !graphStep;
  let phoneGraphBottom = 0;
  if (phoneGraph && forkPillPresent) phoneGraphBottom = FORK_PILL_FOOTPRINT;
  if (phoneGraph && graphStep) phoneGraphBottom = graphBarBottom;

  const openGraphFork = useCallback(() => {
    track('roadmap_verb', { verb: 'fork', door: graphStep ? 'bar' : 'pill', view: 'graph', band: 'phone' });
    setForkOpen(true);
  }, [graphStep?.id]);
  const graphBarRef = useRef(null);
  useLayoutEffect(() => {
    if (graphStep) {
      graphBarRef.current = rootRef.current?.querySelector('[data-graph-step-bar]');
      return;
    }
    const previous = graphBarRef.current;
    graphBarRef.current = null;
    if (detailId !== null || boardComposer !== null || forkOpen || !previous) return;
    if (graphBarFocusedRef.current) {
      graphBarFocusedRef.current = false;
      focusGraph();
    }
  }, [graphStep?.id, detailId, boardComposer, forkOpen, focusGraph]);

  const { syncSnapshot, deviceLine, refusal } = useRoomSyncNotices({
    treeId, syncSession, owner, status, lapsed: sessionLapsed || lapsed, phone, openSignInDoor, setBoardQuiet,
  });

  // Progress: every mark, whichever surface made it.
  function pushProgress(nodeId, wireStatus) {
    if (demoRef.current) return;
    collabRef.current?.markProgress(nodeId, wireStatus);
  }

  // Once ever per milestone: the ledger survives reloads and an undo/re-complete.
  function milestoneOffer(prevCompleted, nextCompleted) {
    if (!treeMine || shared || demo || demotion || !tree) return null;
    const fresh = detectMilestones(tree, prevCompleted, nextCompleted)
      .filter((milestone) => !milestoneLedger.has(treeId, milestone.id));
    const announcement = milestoneAnnouncement(fresh);
    if (!announcement) return null;
    for (const milestone of fresh) milestoneLedger.markOffered(treeId, milestone.id);
    return {
      summary: announcement.summary,
      action: { label: announcement.label, run: () => {
        track('roadmap_verb', { verb: 'share', door: 'ceremony', view: 'graph', band: breakpoint });
        setShareOpen(true);
      } },
    };
  }

  // The detail says its outcome in place; Board actions and Graph completions own their Undo toast.
  function completeStep(id, { quiet = false, door, at = Date.now() } = {}) {
    const node = nodesById.get(id);
    const next = advanceProgress({ completed, completedAt }, [id], 'complete', at);
    setCompleted(next.completed);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    pushProgress(id, 'complete');
    emit({ verb: 'completed', nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
    const changes = progressChanges(door === 'board' ? boardTree : tree, { completed }, next);
    for (const otherId of changes.unlocked) {
      const unlocked = nodesById.get(otherId);
      emit({ verb: 'unlocked', nodeId: otherId, label: unlocked?.label, kind: unlocked?.color }, { silent: true });
    }
    if (quiet || door === 'board') return next;
    noteCompletion(id);
    const offer = milestoneOffer(completed, next.completed);
    if (offer) {
      sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
      return next;
    }
    const label = node?.label?.trim() || 'Step';
    const stepSummary = demo && id === COACHED_NODE_ID
      ? DEMO_COPY.unlockToast
      : completedToast({ step: label, unlocked: changes.unlocked.map((otherId) => nodesById.get(otherId)?.label || 'Step') });
    const snapshot = { completed, completedAt };
    showToast(stepSummary, {
      surface: 'graph', act: 'complete', holdMs: 6000, focusTarget: document.activeElement,
      action: { label: LABELS.undo, run: () => {
        try {
          boardActs.collaborators.restoreStep(id, snapshot);
          track('roadmap_graph_toast', { act: 'complete', step: 'undo' });
        } catch (error) {
          reportBoardFailure('roadmap-step-restore', error);
        }
      } },
    });
    track('roadmap_graph_toast', { act: 'complete', step: 'shown' });
    return next;
  }

  // completeStep can't be looped: each call reads the same render-time `completed`, so only the last would stick.
  function bulkMarkDone() {
    const targets = markDoneTargets(selectedIdsRef.current, completed);
    if (!targets.length) return;
    const next = advanceProgress({ completed, completedAt }, targets, 'complete', Date.now());
    setCompleted(next.completed);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    pushProgress(targets, 'complete');
    track('roadmap_board_complete', { door: 'bulk', count: countBucket(targets.length) });
    for (const id of targets) {
      const node = nodesById.get(id);
      emit({ verb: 'completed', nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
    }
    const changes = progressChanges(tree, { completed }, next);
    for (const otherId of changes.unlocked) {
      const unlocked = nodesById.get(otherId);
      emit({ verb: 'unlocked', nodeId: otherId, label: unlocked?.label, kind: unlocked?.color }, { silent: true });
    }
    const offer = milestoneOffer(completed, next.completed);
    if (offer) sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
  }

  function handleMarkComplete() {
    if (!selectedId) return;
    track('roadmap_board_complete', { door: 'dock' });
    completeStep(selectedId);
  }

  function resetFromGraph(id, surface) {
    if (id) track('roadmap_board_step_action', { surface, action: 'reset' });
    resetStep(id);
  }

  function resetStep(id) {
    if (!id) return;
    const next = advanceProgress({ completed, completedAt }, [id], 'none', Date.now());
    setCompleted(next.completed);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    pushProgress(id, 'none');
  }

  // The step page and modal's Undo: the step's mark goes back as it was, with no ceremony and no activity. Its completion
  // time cannot: the progress lattice dates every mark it sends, so an Undo of Reset completes the step at the Undo's time.
  function restoreStep(id, snapshot) {
    const next = advanceProgress({ completed, completedAt }, [id], snapshot.completed.has(id) ? 'complete' : 'none', Date.now());
    setCompleted(next.completed);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    pushProgress(id, next.completed.has(id) ? 'complete' : 'none');
  }

  // The Board's acts and what a held delete projects.
  const { held: boardHeld, acts: boardActs } = useBoardActs({
    active: boardActive, graphActive: canvasView, owner, treeId, tree,
    progress: { completed, completedAt }, query: boardQuery, session: collabRef.current,
    completeStep, restoreStep, showToast, setQuery: setBoardQuery, now: Date.now,
    receiptVersion: syncSnapshot?.receiptVersion,
    syncReady: syncSession?.ready,
    dismissInvalidatedToast: () => {
      const current = boardToastRef.current;
      if (current?.action?.receipt) dismissToast();
    },
    clearBoardToast: () => {
      const toast = boardToastRef.current;
      if (toast?.surface === 'board' || (toast?.surface === 'graph' && toast.act === 'delete')) dismissToast();
    },
    onGraphReveal: handleSheetJump, graphFocusTarget: boardComposer?.opener,
    onReveal: (id) => setBoardReveal((current) => ({ id, key: (current?.key ?? 0) + 1 })),
    onQuiet: () => setBoardQuiet((current) => current + 1),
    track, emit, report: reportBoardFailure,
  });
  const boardTree = useMemo(() => boardHeld && tree ? boardHeld.projected(tree) : tree, [boardHeld, tree]);
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
  const boardStats = useMemo(() => boardTree ? ShareStats.from(boardTree, UnlockRules.derive(boardTree, { completed })) : null, [boardTree, completed]);
  const shownStats = boardActive ? { ...boardStats, ...(boardOverall ?? {}) } : shareStats;
  const shownDetailId = detailId !== null && boardTree?.nodesById.has(detailId) ? detailId : null;
  const composerDoor = new BoardComposer({ view: canvasView ? 'tree' : 'board', owner, detailId: shownDetailId,
    composer: boardComposer, acts: boardActs, onOpen: setBoardComposer });
  const shownComposer = composerDoor.shown;
  if (boardComposer !== null && shownComposer === null) setBoardComposer(null);
  const closeBoardComposer = () => setBoardComposer(null);
  const handleComposerCrash = (error) => {
    reportBoardFailure('roadmap-board-composer', error);
    setBoardComposer(null);
    focusBoard();
  };

  // A viewer keeps the owner's displayed progress; every owner surface adopts its private lane.
  applyRemoteProgressRef.current = (overlay) => {
    if (demoRef.current || shared || demotion || !seedRef.current?.mine) return;
    const currentTree = treeRef.current;
    if (!currentTree) return;
    const next = { completed: new Set(overlay.completed), completedAt: overlay.completedAt };
    const changes = progressChanges(currentTree, { completed: completedRef.current }, next);
    completedRef.current = next.completed;
    setCompleted(next.completed);
    setCompletedAt(next.completedAt);
    witnessProgress(next);

    for (const [verb, ids] of [['completed', changes.completed], ['unlocked', changes.unlocked]]) {
      for (const id of ids) {
        const node = currentTree.nodesById.get(id);
        emit({ verb, nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
      }
    }
    if (changes.completed.length === 0) return;
    const label = currentTree.nodesById.get(changes.completed[0])?.label?.trim() || 'Step';
    const ceremony = changes.completed.length === 1
      ? completedToast({ step: label, unlocked: changes.unlocked.map((id) => currentTree.nodesById.get(id)?.label || 'Step') })
      : completedStepsToast({ count: changes.completed.length, unlocked: changes.unlocked.length });
    if (boardActive) showToast(ceremony);
    else sceneRef.current?.announceCeremony(ceremony);
  };

  function handleZoomIn() {
    sceneRef.current?.zoomBy(1.2);
  }

  function handleZoomOut() {
    sceneRef.current?.zoomBy(1 / 1.2);
  }

  function handlePanTo(x, y) {
    sceneRef.current?.panTo(x, y);
  }

  // The chrome around both views.
  // bindOnly: an unmatched heading mints a fresh hue rather than renaming an existing kind.
  const composerParse = useMemo(
    () => (composerOpen ? parsePlan(draft, draftKinds, { bindOnly: true }) : null),
    [composerOpen, draft, draftKinds],
  );
  const composer = composerOpen && composerParse && (
    <PasteComposer
      append
      text={draft}
      onTextChange={setDraft}
      kinds={draftKinds}
      onKindsChange={setDraftKinds}
      parse={composerParse}
      planting={false}
      onClose={() => setComposerOpen(false)}
      onPlant={graftImported}
    />
  );

  const stepFacts = {
    node: selectedNode,
    state: selectedState,
    prerequisites,
    completedAt: completedAt[selectedId],
    history: selectedHistory,
    workspace: workspaceByNode[selectedId] ?? emptyWorkspace(),
    kinds: legend,
    onReveal: handleRevealNode,
    onClose: () => setSelectedId(null),
  };

  // While the Board stands in for a roadmap that has not loaded, the row names nothing and offers no Share; a failed
  // load offers no Graph either, whose load error would cover the row with no way back.
  const boardAwaitsRoadmap = boardActive && !boardFacts.loaded;
  const onSwitchView = boardCanShow({ ...boardFacts, crashed: false }) && !(boardActive && loadError) ? switchView : null;
  // G follows the switch from 744px, for either role.
  boardSwitchRef.current = !phone && onSwitchView
    ? () => switchView(boardActive ? 'tree' : 'board')
    : null;
  const tendPlaceholder = tree && tree.nodes.length === 0
    ? ASK_AI_PLACEHOLDER.empty
    : ASK_AI_PLACEHOLDER.wide;
  const tendExamples = tree && tree.nodes.length > 0 ? ['Is this realistic?', 'What am I missing?'] : [];
  // The docked panel: the desktop editor's dock also hosts the composer and the feed; below 744px a step opens from the bar.
  const readOnlyDock = !desktopEditor && !phone && !tabletEditor;
  const activityOpen = owner && feedVisible;
  const dockOpen = !phone && (composerOpen || (canvasView && (!!selectedNode || activityOpen)));

  const revealGraphToast = useCallback(() => {
    if (!toast?.reveal) return;
    track('roadmap_board_toast_reveal', { act: toast.act, view: 'graph' });
    handleSheetJump(toast.reveal);
  }, [toast?.reveal, toast?.act, handleSheetJump]);
  const undoGraphToast = useCallback(() => {
    const origin = toast?.focusTarget;
    toast?.action?.run();
    dismissToast();
    requestAnimationFrame(() => {
      if (origin !== document.body && origin?.isConnected && !origin.closest('[inert]')) {
        origin.focus({ preventScroll: true });
        if (document.activeElement === origin) return;
      }
      identityRef.current?.querySelector('.st-board-switch-option[aria-pressed="true"]')?.focus({ preventScroll: true });
    });
  }, [toast, dismissToast]);
  useEffect(() => {
    if (toast?.surface === 'graph' && !canvasView) dismissToast();
  }, [toast?.surface, canvasView, dismissToast]);

  const {
    openRowTend, openRowFork, openRowShortcuts, openRowSettings, openRowCreate, identityFind, graphNext,
    identityNext, shareFromRow, exportFromRow, newRoadmap, currentRoadmap, identitySheet,
    closeRowActivity, openRowActivity, openActivityStep,
  } = useRoadmapIdentityActs({
    owner, phone, treeId, tree, boardTree, shownStats, boardActive, completed, completedAt,
    boardQuery, boardQueryRef, setBoardQuery, switchView, switchFocusRef, setTendOpen, setForkOpen,
    setShortcutsOpen, setShareOpen, newStepFromBoard, handleSheetJump, editorRef, showToast, reportBoardFailure,
    shareRequestRef, currentTreeIdRef, graphViewRef, identityRef, graphStepReturnRef, activityActsRef,
    breakpoint, canvasView, feedVisible, activityGroups, nodesById, setSelectedId, openActivity, closeActivity, addressOpen: stepAddress.open,
  });

  const { insets, dockTop, graphRefusalShown, graphRefusalStyle, attachGraphRefusal, graphToastStyle, tendTopInset } = useGraphGeometry({
    breakpoint, phone, canvasView, boardActive, dockOpen, refusal, topbarBottom, graphChromeBottom, phoneGraphBottom,
    scene, selectedId, renderModel, toastKey: toast?.key ?? null, tendOpen, legendVisible,
    rootRef, identityRef, boardLayerRef, legendDockRef, insetsRef, firstFrameRef, graphRevealRef,
  });

  const roadmapSwitcher = <TreeSwitcher current={currentRoadmap} listTrees={listAllTrees} onNew={newRoadmap}
    onRename={handleRenameTree} onPreviewTitle={previewTreeTitle} onDelete={handleDeleteTree} />;
  const handleIdentityCrash = useCallback((error) => reportBoardFailure('roadmap-identity', error), []);

  return (
    <div className={`st-root ${panning ? 'panning' : ''}`} ref={rootRef} onFocusCapture={rememberGraphFocus}>
      <canvas
        ref={canvasRef}
        className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''} ${view !== null ? 'st-canvas--layer' : ''}`}
        style={boardActive ? { opacity: 0, pointerEvents: 'none' } : undefined}
      />

      {desktopEditor && (
        <PresenceLayer peersRef={peersRef} scene={scene} canvasRef={canvasRef} collabRef={collabRef} selection={selectedId} />
      )}

      {desktopEditor && tree && tree.nodes.length === 0 && !boardActive && <EmptyGraphCard onAddFirstStep={handleCreateRoot} />}

      <div className="st-roadmap-identity-host" ref={identityRef}>
        <ErrorBoundary
          fallback={<RoadmapIdentityFallback view={boardActive ? 'board' : 'tree'} phone={phone} onSwitchView={onSwitchView} onBottom={setTopbarBottom} />}
          onCrash={handleIdentityCrash}
        >
          <RoadmapIdentity
            band={breakpoint}
            view={boardActive ? 'board' : 'tree'}
            role={role}
            title={boardAwaitsRoadmap ? undefined : tree?.title}
            switcher={owner && !phone && !boardAwaitsRoadmap ? roadmapSwitcher : null}
            progress={boardAwaitsRoadmap || !shownStats ? null : { done: shownStats.done, total: shownStats.total }}
            onSwitchView={onSwitchView}
            find={!phone && boardFacts.loaded && !boardFacts.empty ? identityFind : null}
            next={canvasView && owner && !phone && graphNext?.count > 0 ? identityNext : null}
            onAskAI={canTend && owner ? openRowTend : null}
            onShare={!boardAwaitsRoadmap && tree ? shareFromRow : null}
            onNewStep={owner && boardFacts.loaded ? openRowCreate : null}
            onExport={owner && boardFacts.loaded ? exportFromRow : null}
            onSettings={owner ? openRowSettings : null}
            onShortcuts={owner ? openRowShortcuts : null}
            onActivity={owner && !phone ? openRowActivity : null}
            activityOpen={activityOpen}
            onFork={!owner && forkPresent ? openRowFork : null}
            sheet={phone && owner && boardFacts.loaded ? identitySheet : null}
            onBottom={setTopbarBottom}
          />
        </ErrorBoundary>
      </div>

      {boardMounted && (
        <div ref={boardLayerRef} className={`st-view-layer st-view-layer--board ${boardActive ? 'is-active' : ''}`}>
          <ErrorBoundary fallback={null} onCrash={handleBoardCrash}>
            <BoardView
              tree={boardTree}
              completed={completed}
              completedAt={completedAt}
              loading={loading}
              failed={loadError}
              selectedId={selectedId}
              onSelect={openStepFromBoard}
              onAnchor={setSelectedId}
              refusal={refusal}
              deviceLine={phone ? deviceLine : null}
              onFork={phone && forkPresent ? openRowFork : null}
              breakpoint={breakpoint}
              topInset={topbarBottom}
              active={boardActive}
              onRetry={retryLoad}
              onShare={owner ? () => setShareOpen(true) : undefined}
              onNewStep={owner ? newStepFromBoard : undefined}
              onComplete={owner ? (id, door) => boardActs.complete(id, door) : undefined}
              editable={boardActive && owner}
              onRecolor={owner ? (ids, hue) => boardActs.recolor(ids, hue) : undefined}
              onDelete={owner ? (ids, door) => boardActs.delete(ids, door) : undefined}
              quiet={boardQuiet}
              onDisplayedOverall={setBoardOverall}
              reveal={boardReveal}
              toast={toast?.surface === 'board' ? toast : null}
              onToastShown={boardToastShown}
              onToastReveal={() => boardActs.revealToast(toast)}
              onToastUndo={() => { toast?.action?.run(); dismissToast(); focusBoard(); }}
              query={boardQuery}
              onQuery={setBoardQuery}
              legend={legend}
            />
          </ErrorBoundary>
        </div>
      )}

      {shownDetailId !== null && (
        <ErrorBoundary fallback={null} onCrash={handleStepCrash}>
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
            stepLink={stepShareUrl && `${stepShareUrl}${hashWithStep('', detailId)}`}
            workspace={workspaceByNode[detailId] ?? emptyWorkspace()}
            workspaceActions={workspaceActions}
            history={selectedHistory}
            onOpenStep={(id) => stepAddress.open(id, 'step')}
            onBack={stepAddress.back}
            onClose={closeStep}
            onComplete={(id) => completeStep(id, { quiet: true })}
            onReset={resetStep}
            onRestore={(id, snapshot) => {
              setBoardQuiet((current) => current + 1);
              restoreStep(id, snapshot);
            }}
            onOpenInGraph={openStepInGraph}
            onViewBranch={viewBranchFromDetail}
            onDelete={deleteStepFromDetail}
            onDeletePrompt={(step) => boardActs.deletePrompt(step)}
            onNotify={showToast}
          />
        </ErrorBoundary>
      )}

      {shownComposer !== null && (
        <ErrorBoundary fallback={null} onCrash={handleComposerCrash}>
          <StepComposer key={shownComposer.editing ?? 'create'} tree={boardTree} completed={completed} legend={legend} band={breakpoint}
            editing={shownComposer.editing ?? null} savingBlocked={Boolean(syncSnapshot?.rebaselining)} onEdit={(request) => composerDoor.saveEdit(request)}
            onCreate={(request) => boardActs.create(request)} onClose={closeBoardComposer} />
        </ErrorBoundary>
      )}

      {graphRefusalShown && (
        <div ref={attachGraphRefusal} className={`st-graph-refusal${phone ? ' st-graph-refusal--phone' : ''}`}
          style={graphRefusalStyle}>
          <RefusedSync band={breakpoint} {...refusal} />
        </div>
      )}

      <GraphChrome band={breakpoint} view={canvasView ? 'tree' : 'board'} rowBottom={topbarBottom}
        onTopBottom={setGraphChromeBottom}
        step={graphStep}
        ctaEcho={demo && ctaEcho}
        onOpenStep={openStepFromGraph}
        onBarBottom={setGraphBarBottom}
        deviceLine={phone ? deviceLine : null}
        cameraRight={phone || !canvasView ? undefined : insets.blocks.at(-1)?.right}
        cameraBottom={phone || !canvasView ? undefined : insets.blocks.at(-1)?.bottom}
        onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} onFocus={handleFocus} onShowAll={handleShowAll}
        onFork={forkPresent && phone && canvasView ? openGraphFork : undefined} />

      {canTend && tendOpen && (
        <TendBar
          presentation={phone ? 'docked' : 'overlay'}
          topInset={tendTopInset}
          working={tendWorking}
          placeholder={phone && tree?.nodes.length > 0 ? ASK_AI_PLACEHOLDER.phone : tendPlaceholder}
          examples={tendExamples}
          onSubmit={submitTend}
          onDismiss={() => setTendOpen(false)}
          portalTarget={rootRef.current?.closest('.wm-shell') ?? document.body}
        />
      )}

      <Minimap
        nodes={heldGraphModel?.nodes ?? []}
        states={states}
        bounds={bounds}
        subscribeViewport={scene?.subscribeViewport ?? null}
        onPanTo={handlePanTo}
      />

      {legendVisible && (
        <div ref={legendDockRef} className="st-legend-dock" style={{ position: 'absolute', left: 'var(--space-6)', bottom: 'calc(var(--space-6) + 196px)', zIndex: 16 }}>
          <KindLegend
            kinds={legendWithCounts}
            defaultOpen={legendOpen}
            onOpenChange={onLegendOpenChange}
            selectedId={highlightedKindId}
            onHighlight={onHighlightKind}
            {...(desktopEditor ? {
              onRename: onRenameKind,
              onRecolor: onRecolorKind,
              onAdd: onAddKind,
              onRemove: onRemoveKind,
              onDescribe: onDescribeKind,
            } : {})}
          />
        </div>
      )}

      {desktopEditor && (
        <GraphDock open={dockOpen} top={dockTop} tenant={composerOpen ? 'composer' : selectedNode ? selectedNode.id : 'activity'}>
          {composerOpen ? composer : selectedNode ? (
            <StepPanel
              {...stepFacts}
              {...workspaceActions}
              autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
              onRename={handleRename}
              onPreviewKind={(id, kind) => sceneRef.current?.previewKind(id, kind)}
              onRestoreKind={(id) => sceneRef.current?.restoreKind(id)}
              onSetKind={handleSetKind}
              onOpenLegend={openLegendFromPicker}
              onMarkComplete={handleMarkComplete}
              onReset={(id) => resetFromGraph(id, 'dock')}
              onDelete={deleteNodeAt}
              onPreviewDeleteCost={(id) => sceneRef.current?.previewDeleteCost(id)}
              onClearDeleteCost={() => sceneRef.current?.clearDeleteCost()}
            />
          ) : feedVisible ? (
            <ActivityFeed
              groups={activityGroups}
              count={eventCount}
              nodesById={nodesById}
              now={Date.now()}
              hoveredId={hoveredId}
              newIds={newEventIds}
              onClose={closeRowActivity}
              onHoverNode={handleRowHover}
              onLeaveNode={handleRowLeave}
              onRevealNode={(id) => {
                track('roadmap_verb', { verb: 'activity', door: 'feed', view: 'graph', band: breakpoint });
                handleRevealNode(id);
              }}
            />
          ) : null}
        </GraphDock>
      )}

      {activityOpen && breakpoint === 'tablet' && (
        <aside className="st-roadmap-activity-panel" aria-label={ROADMAP_VERBS.activity}>
          <div className="st-roadmap-activity-header">
            <h2>{ROADMAP_VERBS.activity}</h2>
            <IconButton icon={<Icon name="x" size={20} />} label={LABELS.close} onClick={closeRowActivity} />
          </div>
          <ActivityRows groups={activityGroups} nodesById={nodesById} onOpenStep={openActivityStep} />
        </aside>
      )}

      {tabletEditor && (
        <TabletPanel
          tablet={tablet}
          open={tablet.surface !== 'empty' && !boardActive}
          top={dockTop}
          selectedNode={selectedNode}
          selectedState={selectedState}
          nodesById={nodesById}
          prerequisites={prerequisites}
          unlocks={unlocks}
          completedAt={completedAt[selectedId]}
          kinds={legend}
          autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
          isRoot={selectedId !== null && selectedId === singleRootId}
          onMarkDone={(id) => {
            track('roadmap_board_complete', { door: 'panel' });
            completeStep(id);
          }}
          onUnmarkDone={(id) => resetFromGraph(id, 'panel')}
          onDelete={deleteNodeAt}
          onJump={handleSheetJump}
          selectedCount={selectedIds.size}
          recolorKinds={recolorKinds}
          ringedKind={ringedKind}
          onBulkRecolor={bulkRecolor}
          onBulkDelete={bulkDelete}
          onBulkDone={leaveMulti}
        />
      )}

      {readOnlyDock && (
        <GraphDock open={dockOpen} top={dockTop} tablet={breakpoint === 'tablet'} tenant={selectedNode ? selectedNode.id : 'empty'}>
          {selectedNode && (
            <StepPanel
              {...stepFacts}
              readOnly
              unlocks={unlocks}
              onJump={handleSheetJump}
              onMarkComplete={demo ? handleMarkComplete : undefined}
            />
          )}
        </GraphDock>
      )}

      {demotion && !demotion.cardOpen && (
        <div style={{ position: 'absolute', top: 'calc(max(env(safe-area-inset-top, 0px), 44px) + 8px)', left: '50%', transform: 'translateX(-50%)', zIndex: 21 }}>
          <StatusChip>
            {demotion.edits > 0
              ? `Read-only · ${demotion.edits} change${demotion.edits === 1 ? '' : 's'} kept here`
              : 'Read-only'}
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
        <ForkDoor open={forkOpen} presentation={phone ? 'sheet' : 'dialog'} treeId={treeId} signedIn={status === 'signed-in'} demo={demo} stepCount={shareStats?.total} onClose={() => setForkOpen(false)} />
      )}

      {demo && coachAllowed && scene && canvasView && (
        <CoachChip
          scene={scene}
          nodeId={COACHED_NODE_ID}
          onMarkDone={() => {
            track('roadmap_board_complete', { door: 'coach' });
            completeStep(COACHED_NODE_ID);
          }}
          completionCount={demoCompletions}
        />
      )}

      {desktopEditor && selectedIds.size + selectedEdges.size > 1 && (
        <GraphSelectionBar
          stepCount={selectedIds.size}
          linkCount={selectedEdges.size}
          kinds={recolorKinds}
          ringedKind={ringedKind}
          onPreviewKind={(hue) => sceneRef.current?.previewKindSet([...selectedIdsRef.current], hue)}
          onRestoreKind={() => sceneRef.current?.restoreKindSet([...selectedIdsRef.current])}
          onRecolor={(hue) => bulkRecolor(hue, { silent: true })}
          onMarkDone={bulkMarkDone}
          onPreviewDelete={() => sceneRef.current?.previewDeleteCostSet([...selectedIdsRef.current])}
          onClearDelete={() => sceneRef.current?.clearDeleteCost()}
          onDelete={bulkDelete}
        />
      )}

      {canvasView && toast?.surface === 'graph' && (
        <div className={`st-graph-toast${phone ? ' st-graph-toast--phone' : ''}`} style={graphToastStyle}>
          <BoardToast toast={toast} phone={phone} blocked={phone && Boolean(refusal)} onToastShown={boardToastShown} onToastReveal={revealGraphToast}
            onToastUndo={undoGraphToast} />
        </div>
      )}

      {toast && !['board', 'graph'].includes(toast.surface) && (
        <div style={graphToastStyle} className={`st-toast${canvasView ? ' st-toast--graph' : ''} ${toast.leaving ? 'is-leaving' : ''} ${toast.detail && toastWhyOpen ? 'st-toast--expanded' : ''}`} role="status" key={toast.key}>
          <div className="st-toast-row">
            <span>{toast.message}</span>
            {toast.detail && (
              <button
                className="st-toast-why"
                onClick={() => {
                  toastTimersRef.current.forEach(clearTimeout);
                  toastTimersRef.current = [];
                  if (!toastWhyOpen) track('roadmap_verb', { verb: 'askAI', step: 'why' });
                  setToastWhyOpen((open) => !open);
                }}
              >
                {toastWhyOpen ? 'Hide' : 'Why?'}
              </button>
            )}
            {toast.action && (
              <button className="st-toast-undo" onClick={() => {
                track('roadmap_graph_toast', { act: 'edit', step: 'undo' });
                toast.action.run();
                dismissToast();
              }}>
                {toast.action.label}
              </button>
            )}
          </div>
          {toast.detail && toastWhyOpen && <p className="st-toast-detail">{toast.detail}</p>}
        </div>
      )}

      {ticker.length > 0 && (
        <div className="st-ticker" role="status" aria-live="polite">
          {ticker.map((event) => (
            <div className="st-ticker-item" key={event.id}>
              <ActorAvatar event={event} size={20} />
              <span><EventSentence event={event} node={nodesById.get(event.nodeId) ?? null} /></span>
            </div>
          ))}
        </div>
      )}

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} readOnly={!desktopEditor} owner={owner} view={boardActive ? 'board' : 'graph'} />

      <ShareDialog
        key={treeId}
        treeId={treeId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        visibility={treeVisibility}
        mine={treeMine}
        onStanceChange={setTreeVisibility}
      />

      {loading && !loadError && !boardActive && <div className="st-loading"><span className="st-loading-msg">Planting the tree…</span></div>}
      {loadError && !boardActive && (
        <div className="st-load-error">
          <p className="st-loading-msg">Couldn’t load this roadmap. It may have moved, or the server is unreachable.</p>
          <div className="st-load-error-actions">
            <Button onClick={retryLoad}>Try again</Button>
            <a href="#/app" className="st-load-error-link">Your trees</a>
          </div>
        </div>
      )}
    </div>
  );
}

