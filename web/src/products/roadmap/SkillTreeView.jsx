// Skill-tree view: repository -> domain -> layout -> scene, plus the overlay UI around the GPU canvas.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ControlBar } from './ui/ControlBar.jsx';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog.jsx';
import { TreeSwitcher } from './ui/TreeSwitcher.jsx';
import { StepPanel } from './ui/StepPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { useViewMode } from './ui/useViewMode.js';
import { StatusChip, VisitorNotice } from './ui/HonestyChrome.jsx';
import { MobileChrome } from './ui/mobile/MobileChrome.jsx';
import { TendBar } from './tending/TendBar.jsx';
import { useTend } from './tending/useTend.js';
import { fetchTending } from './tending/tendingClient.js';
import { BottomSheet } from './ui/mobile/BottomSheet.jsx';
import { MobileEditorSheet } from './ui/mobile/MobileEditorSheet.jsx';
import { AimBar, RemoveLinkBar } from './ui/mobile/AimBar.jsx';
import { BulkBar } from './ui/mobile/BulkBar.jsx';
import { ActionLane, LaneButton } from './ui/mobile/ActionLane.jsx';
import ListView from './list/ListView.jsx';
import ViewPill from './list/ViewPill.jsx';
import { SwitcherSheet } from './list/SwitcherSheet.jsx';
import { activeSurface } from './ui/mobile/editorSheet.js';
import { illegalTargets, edgeFor } from './ui/mobile/aim.js';
import { sharedKind } from './ui/mobile/bulk.js';
import { markDoneTargets } from './selection/bulkSelection.js';
import { ForkDoor } from './ui/mobile/ForkDoor.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useSignInDoor } from '../../shell/auth/SignInDoor.jsx';
import { ShareDialog } from './share/ShareDialog.jsx';
import { ShareStats } from './share/ShareStats.js';
import { useWeekOffer } from './share/useWeekOffer.js';
import { ActivityFeed } from './activity/ActivityFeed.jsx';
import { NextUp, considerAutoOpen } from './ui/NextUp.jsx';
import { planNextUp } from './ui/nextUpPlan.js';
import { useActivity } from './activity/useActivity.js';
import { ActorAvatar, EventSentence } from './activity/grammar.jsx';
import { SkillTree } from './model/SkillTree.js';
import { cmpOrder } from './model/TrunkTree.js';
import { makeRenderable } from './model/renderableGraph.js';
import { UnlockRules } from './model/UnlockRules.js';
import { RadialLayoutEngine } from './layout/RadialLayoutEngine.js';
import { HttpTreeRepository } from './persistence/HttpTreeRepository.js';
import { listAllTrees, renameTree, deleteTree } from './persistence/TreeRegistry.js';
import { SyncSession } from './sync/SyncSession.js';
import { isOwnershipRefusal, isSessionRefusal, isCapacityRefusal, strandsTheBank } from './sync/refusals.js';
import { claimLocalTrees } from './sync/claimLocalTrees.js';
import { renameLocalTree, deleteLocalTree, loadDeviceTree } from './sync/localTrees.js';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { LocalTreeRegistry, resolveDeviceOwner, confirmDeviceOwner } from './persistence/LocalTreeRegistry.js';
import { PlaceStore } from './persistence/PlaceStore.js';
import { ViewPrefs, initialView, peekBorn, clearBorn } from './persistence/ViewPrefs.js';
import { ReturnLedger } from './persistence/ReturnLedger.js';
import { MilestoneLedger } from './persistence/MilestoneLedger.js';
import { detectMilestones } from './model/milestones.js';
import { advanceProgress, milestoneAnnouncement } from './model/progress.js';
import { emptyWorkspace } from './model/NodeWorkspace.js';
import { withCounts, inUseCount } from './model/Legend.js';
import { KindLegend } from './ui/tree/KindLegend.jsx';
import { useLegend } from './ui/tree/useLegend.js';
import { useWorkspace } from './ui/tree/useWorkspace.js';
import { Button } from '../../design-system';
import { PasteComposer } from './paste/PasteComposer.jsx';
import { parsePlan } from './paste/planGrammar.js';
import { graftPlan } from './paste/graftPlan.js';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { edgeKey, parseEdgeKey } from './scene/edgeKey.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { NODE_COLORS, NODE_COLOR_NAMES, DEFAULT_NODE_COLOR } from './theme.js';
import { track } from '../../telemetry/beacon.js';
import { CoachChip } from './demo/CoachChip.jsx';
import { DEMO_TREE_ID, DEMO_STAGED_COMPLETED, COACHED_NODE_ID, COACH_DONE_KEY, FORKED_FROM_DEMO_KEY, DEMO_COPY, coachEligible } from './demo/demoStage.js';

const layoutEngine = new RadialLayoutEngine();
const deviceTrees = new LocalTreeRegistry();
const placeStore = new PlaceStore();
const viewPrefs = new ViewPrefs();
const returnLedger = new ReturnLedger();
const milestoneLedger = new MilestoneLedger();
const NEXT_UP_SELECT_MS = 540;
const NEXT_UP_ENTER_MS = 600;
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const NEW_NODE_ICON = 'sparkles';
const PLANTED_QUEST_KEY = 'windmill:planted-quest';
const CTA_ECHO_DELAY = 1500;

function consumeSessionFlag(key) {
  try {
    if (sessionStorage.getItem(key) !== '1') return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function SkillTreeView({ treeId, demo = false }) {
  const openSignInDoor = useSignInDoor();
  const { breakpoint, readOnly: viewReadOnly, shared } = useViewMode();
  const { status, refresh, account } = useAuth();

  // `account` must be the shell's server-confirmed account; the “nobody” answer comes from resolveDeviceOwner.
  useEffect(() => { if (account) confirmDeviceOwner(account.id); }, [account]);

  const [lapsed, setLapsed] = useState(false);
  const [demotion, setDemotion] = useState(null); // { edits, cardOpen } | null
  const [stranded, setStranded] = useState(null);
  const readOnly = viewReadOnly || !!demotion;

  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const readOnlyRef = useRef(readOnly);
  const editorRef = useRef(null);
  const treeRef = useRef(null);
  const layoutCacheRef = useRef({ signature: '', raw: new Map() });
  const completedRef = useRef(new Set());
  const inProgressRef = useRef(new Set());
  const seedRef = useRef(null);
  const repoRef = useRef(null);
  const collabRef = useRef(null);
  const peersRef = useRef(new Map()); // actor -> { name, color, cursor, selection }
  const onTreeChangedRef = useRef(null);
  const maskedShownRef = useRef('');
  const applyRemoteProgressRef = useRef(null);
  const prevAuthRef = useRef(status);
  const suspectRef = useRef(false);
  const demotedRef = useRef(false);
  const claimRunRef = useRef(false);

  const kickClaim = useCallback(() => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    claimLocalTrees({ openTreeId: treeId, openSession: () => collabRef.current })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim();
  }, [kickClaim]);

  // A sign-in or sign-out must reconnect: the socket’s principal is fixed at connect.
  useEffect(() => {
    const prev = prevAuthRef.current;
    prevAuthRef.current = status;
    if (prev === status) return;
    if (status === 'signed-in') {
      if (demotedRef.current) { window.location.reload(); return; }
      setLapsed(false);
    }
    if (prev === 'loading' && status === 'signed-in') {
      kickClaim();
      return;
    }
    if (prev === 'ghost' && status === 'signed-in') {
      collabRef.current?.forceReconnect();
      kickClaim();
      return;
    }
    if (prev === 'signed-in') {
      if (suspectRef.current) { suspectRef.current = false; setLapsed(true); }
      collabRef.current?.forceReconnect();
    }
  }, [status, kickClaim]);

  useEffect(() => {
    let idleTimer = null;
    let waiting = false;
    let lastActivityAt = 0;
    const noteActivity = () => { lastActivityAt = Date.now(); };
    const stopWaiting = () => {
      window.removeEventListener('keydown', noteActivity, true);
      window.removeEventListener('pointerdown', noteActivity, true);
    };
    const demote = () => {
      waiting = false;
      if (demotedRef.current) { stopWaiting(); return; }
      const el = document.activeElement;
      const handsBusy = (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))
        || (sceneRef.current?.isPointerActive?.() ?? false);
      const idle = Date.now() - lastActivityAt >= 400;
      if (handsBusy && !idle) {
        waiting = true;
        window.addEventListener('keydown', noteActivity, true);
        window.addEventListener('pointerdown', noteActivity, true);
        idleTimer = setTimeout(demote, 400);
        return;
      }
      stopWaiting();
      demotedRef.current = true;
      sceneRef.current?.setReadOnly?.();
      setDemotion({ edits: collabRef.current?.pendingEditCount?.() ?? 0, cardOpen: true });
    };
    const onForbidden = (event) => {
      if (isOwnershipRefusal(event.detail)) {
        if (demotedRef.current || waiting) return;
        lastActivityAt = Date.now();
        demote();
        return;
      }
      if (!isSessionRefusal(event.detail)) {
        if (strandsTheBank(event.detail)) {
          setStranded(isCapacityRefusal(event.detail)
            ? 'Not saving — this roadmap is at its limit'
            : 'Not saving — the server refused the last change');
        }
        return;
      }
      if (suspectRef.current) return;
      suspectRef.current = true;
      refresh().then((me) => {
        const stillSignedIn = me !== undefined ? !!me : prevAuthRef.current === 'signed-in';
        if (stillSignedIn) suspectRef.current = false;
      });
    };
    window.addEventListener('wm-edit-forbidden', onForbidden);
    return () => {
      window.removeEventListener('wm-edit-forbidden', onForbidden);
      stopWaiting();
      clearTimeout(idleTimer);
    };
  }, [refresh]);
  const invalidRef = useRef(false);
  const plantedQuestRef = useRef(null); // null until consumed; survives StrictMode’s double effect
  const forkedFromDemoRef = useRef(null);
  const demoRef = useRef(demo);
  useEffect(() => { demoRef.current = demo; }, [demo]);
  const selectedIdRef = useRef(null);
  const selectedIdsRef = useRef(new Set());
  const selectedEdgesRef = useRef(new Set());
  const toastTimersRef = useRef([]);
  const toastKeyRef = useRef(0);
  const completeStepRef = useRef(null);
  const composerOpenRef = useRef(false);

  const {
    legend, legendRef, legendOpen, legendForceOpen, highlightedKindId, highlightedKindIdRef,
    hydrateLegend, syncLegendFromTree, clearLegendStore, clearHighlightedKind,
    onRenameKind, onDescribeKind, onAddKind, onRemoveKind, onRecolorKind,
    onHighlightKind, onLegendOpenChange, openLegendFromPicker,
  } = useLegend({ seedRef, collabRef, editorRef, sceneRef });

  const {
    workspaceByNode, hydrateWorkspaces, clearWorkspaceStore, cancelAllAutoCompletes, pushArcs,
    onAddSubtask, onToggleSubtask, onEditSubtask, onDeleteSubtask, onSetNote, onAddLink, onDeleteLink,
  } = useWorkspace({ seedRef, sceneRef, completedRef, completeStepRef });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [inProgress, setInProgress] = useState(() => new Set());
  const [startedAt, setStartedAt] = useState(() => ({})); // { nodeId: ms }
  const [completedAt, setCompletedAt] = useState(() => ({})); // { nodeId: ms }
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  const [selectedId, commitSelectedId] = useState(null);
  // Two sets: nodes and edge keys. selectedId / scene.selectedEdge are their size<=1 projections, null once the total exceeds one.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedEdges, setSelectedEdges] = useState(() => new Set());
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);
  const [autoFocusNameId, setAutoFocusNameId] = useState(null);
  const [toast, setToast] = useState(null); // { message, action, detail, key, leaving }
  const [toastWhyOpen, setToastWhyOpen] = useState(false);

  // Ordinary paths call setSelectedId; only the Next-up glide’s timeout reaches commitSelectedId, after re-checking its epoch.
  const nextUpSelectRef = useRef({ epoch: 0, timer: null });
  const cancelNextUpSelect = useCallback(() => {
    const pending = nextUpSelectRef.current;
    pending.epoch += 1;
    window.clearTimeout(pending.timer);
    pending.timer = null;
  }, []);
  // Must use projectEdge, not selectEdge: selectEdge's node-clear cascade reads lagging scene.selectedIds and would wipe a still-selected edge.
  const reconcileProjections = useCallback((nodeSet, edgeSet) => {
    const total = nodeSet.size + edgeSet.size;
    commitSelectedId(total === 1 && nodeSet.size === 1 ? [...nodeSet][0] : null);
    sceneRef.current?.projectEdge(total === 1 && edgeSet.size === 1 ? parseEdgeKey([...edgeSet][0]) : null);
  }, []);

  const setSelectedId = useCallback((id) => {
    cancelNextUpSelect();
    const nodes = id ? new Set([id]) : new Set();
    setSelectedIds(nodes);
    setSelectedEdges(new Set());
    reconcileProjections(nodes, new Set());
  }, [cancelNextUpSelect, reconcileProjections]);

  const onSelectionToggle = useCallback((id) => {
    cancelNextUpSelect();
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    reconcileProjections(next, selectedEdgesRef.current);
  }, [cancelNextUpSelect, reconcileProjections]);
  const onMarqueeSelect = useCallback((ids, additive) => {
    cancelNextUpSelect();
    const next = additive ? new Set(selectedIdsRef.current) : new Set();
    for (const id of ids) next.add(id);
    const nextEdges = additive ? selectedEdgesRef.current : new Set();
    setSelectedIds(next);
    if (!additive) setSelectedEdges(new Set());
    reconcileProjections(next, nextEdges);
  }, [cancelNextUpSelect, reconcileProjections]);

  const onEdgeToggle = useCallback((edge) => {
    cancelNextUpSelect();
    const key = edgeKey(edge.from, edge.to);
    const next = new Set(selectedEdgesRef.current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelectedEdges(next);
    reconcileProjections(selectedIdsRef.current, next);
  }, [cancelNextUpSelect, reconcileProjections]);

  const onEdgePick = useCallback(() => {
    cancelNextUpSelect();
    setSelectedIds(new Set());
    setSelectedEdges(new Set());
    commitSelectedId(null);
  }, [cancelNextUpSelect]);

  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [laneInset, setLaneInset] = useState(0); // px
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [treeVisibility, setTreeVisibility] = useState(null); // 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [panning, setPanning] = useState(false);
  const [recenterAvailable, setRecenterAvailable] = useState(false);
  const [aim, setAim] = useState(null); // { sourceId, direction: 'unlocks'|'needs' } | null
  const [removing, setRemoving] = useState(null); // { from, to } | null
  const [multiMode, setMultiMode] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherTrees, setSwitcherTrees] = useState(null); // null = not yet loaded
  const [view, setView] = useState(null); // 'tree' | 'list' | null when undecided
  const [sheetHeld, setSheetHeld] = useState(false);
  const [coachAllowed, setCoachAllowed] = useState(false);
  const [demoCompletions, setDemoCompletions] = useState(0);
  const [ctaEcho, setCtaEcho] = useState(false);

  const layoutPositions = useCallback((nextTree) => {
    const signature = nextTree.allNodes
      .map((node) => `${node.id}<${[...node.prerequisites].sort().join(',')}<${node.order ?? ''}`)
      .sort()
      .join('|');
    if (layoutCacheRef.current.signature !== signature) {
      layoutCacheRef.current = { signature, raw: layoutEngine.layout(nextTree) };
    }
    return new Map(layoutCacheRef.current.raw);
  }, []);

  const states = useMemo(() => {
    if (!tree) return new Map();
    return UnlockRules.derive(tree, { completed, inProgress });
  }, [tree, completed, inProgress]);

  const shareStats = useMemo(() => (tree ? ShareStats.from(tree, states) : null), [tree, states]);

  // Structure durability lives in the lattice; nothing is written here.
  const persistEdits = useCallback(() => {}, []);

  // Records only that THIS DEVICE witnessed these completions; callers pass freshly computed values, since state setters are async.
  const witnessProgress = useCallback((next) => {
    if (demoRef.current) return;
    if (!seedRef.current || readOnlyRef.current) return;
    returnLedger.save(seedRef.current.id, { completed: [...next.completed], at: Date.now() });
  }, []);

  const showToast = useCallback((message, options = {}) => {
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    const action = options.action ?? null;
    const hold = options.duration ?? (action ? 6000 : 4000);
    const key = (toastKeyRef.current += 1);
    setToastWhyOpen(false);
    setToast({ message, action, detail: options.detail || null, key, leaving: false });
    const leave = setTimeout(() => {
      setToast((current) => (current && current.key === key ? { ...current, leaving: true } : current));
      const drop = setTimeout(() => setToast((current) => (current && current.key === key ? null : current)), 280); // matches the CSS exit
      toastTimersRef.current.push(drop);
    }, hold);
    toastTimersRef.current.push(leave);
  }, []);

  const dismissToast = useCallback(() => {
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    setToast(null);
  }, []);

  const {
    publishOgImage, publishOgImageRef, weekSegment,
    forgetPeriod, openPeriod, considerWeekOffer, followCeremony, dropWeekOffer, clearShareLedger,
  } = useWeekOffer({
    treeId, tree, states, shareStats, layoutPositions, viewPrefs,
    completed, completedAt, completedRef,
    treeMine, shared, demo, demotion, demotedRef,
    showToast, setShareOpen,
    ceremonyBusy: () => sceneRef.current?.ceremonyBusy() ?? false,
  });

  const speakCeremony = useCallback((message, options) => {
    showToast(message, options);
    followCeremony();
  }, [showToast, followCeremony]);

  const [tendingEnabled, setTendingEnabled] = useState(false);
  const [tendOpen, setTendOpen] = useState(false);
  useEffect(() => {
    if (!treeMine || status !== 'signed-in' || demo) { setTendingEnabled(false); return undefined; }
    let alive = true;
    fetchTending().then((summary) => { if (alive) setTendingEnabled(!!summary?.enabled); });
    return () => { alive = false; };
  }, [treeMine, status, demo, treeId]);

  const canTend = tendingEnabled && treeMine && !shared && !demo && !demotion;

  const undoTend = useCallback((planted) => {
    if (!planted.length) return;
    collabRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: planted, edges: [] });
    showToast('Tending reverted');
  }, [showToast]);

  const onTendFace = useCallback((face) => {
    setTendOpen(false);
    if (face.kind === 'empty') return;
    const isReceipt = face.kind === 'receipt';
    const hasUndo = isReceipt && face.created && face.created.length > 0;
    if (hasUndo) window.setTimeout(() => sceneRef.current?.frameNodes(face.created), 600);
    showToast(face.line, {
      duration: isReceipt ? 6000 : 5000,
      detail: isReceipt ? face.detail : undefined,
      action: hasUndo ? { label: 'Undo', run: () => undoTend(face.created) } : undefined,
    });
  }, [showToast, undoTend]);

  const { working: tendWorking, submit: submitTend } = useTend({ treeId, onFace: onTendFace });

  useEffect(() => {
    if (!canTend || breakpoint !== 'desktop') return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && tendOpen) { event.preventDefault(); setTendOpen(false); return; }
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((event.key.toLowerCase() === 'k' && meta) || (event.key === '/' && !meta && !typing)) {
        event.preventDefault();
        setTendOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canTend, breakpoint, tendOpen]);

  const handlePanStateChange = useCallback((isPanning) => {
    setPanning(isPanning);
    if (isPanning) setRecenterAvailable(true);
  }, []);

  const {
    emit, seedActivity, ticker, newEventIds, pinned, unreadCount, activityPing,
    feedVisible, feedSummonedRef, activityGroups, selectedHistory, eventCount,
    toggleActivity, openActivity, closeActivity, togglePin,
  } = useActivity({ sceneRef, selectedIdRef, selectedId, cancelNextUpSelect, setSelectedId });

  const handleResetEdits = useCallback(() => {
    if (seedRef.current) {
      collabRef.current?.clearDurable?.();
      clearWorkspaceStore(seedRef.current.id);
      clearLegendStore(seedRef.current.id);
      returnLedger.clear(seedRef.current.id);
      milestoneLedger.clear(seedRef.current.id);
      clearShareLedger(seedRef.current.id);
    }
    cancelAllAutoCompletes();
    setReloadKey((key) => key + 1);
  }, [clearLegendStore, clearWorkspaceStore, cancelAllAutoCompletes, clearShareLedger]);

  // Every structural edit and undo/redo funnels through here; new SkillTree re-validates the DAG.
  const syncStructure = useCallback(() => {
    const editor = editorRef.current;
    const sceneNow = sceneRef.current;
    if (!editor || !sceneNow) return;

    // A concurrent edit can leave a cycle: render without those edges and surface it.
    let nextTree;
    let cycles = null;
    try {
      nextTree = new SkillTree(editor.treeData);
    } catch {
      const renderable = makeRenderable(editor.treeData);
      nextTree = new SkillTree(renderable.tree);
      cycles = renderable.cycles;
    }

    const positions = layoutPositions(nextTree);
    const nextStates = UnlockRules.derive(nextTree, { completed: completedRef.current, inProgress: inProgressRef.current });
    const model = nextTree.toRenderModel(positions, nextStates);
    sceneNow.applyModel(model);
    treeRef.current = nextTree;
    setTree(nextTree);
    setRenderModel(model);
    setBounds(sceneNow.getBounds());
    persistEdits();

    const invalid = !!(cycles && cycles.length > 0);
    if (invalid && !invalidRef.current) {
      const labelOf = (id) => editor.treeData.nodes.find((n) => n.id === id)?.label || id;
      const ring = cycles[0];
      console.log('[loose] rendering invalid graph, cycles:', cycles);
      showToast(`Cycle: ${[...ring, ring[0]].map(labelOf).join(' → ')} — remove a link to fix it`);
    }
    invalidRef.current = invalid;
  }, [layoutPositions, persistEdits, showToast]);

  const onTreeChanged = useCallback((treeData) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.present = treeData;
    syncStructure();
    syncLegendFromTree(treeData);

    const masked = collabRef.current?.maskedWork?.() ?? [];
    const key = masked.map((m) => m.id).sort().join(',');
    if (masked.length && key !== maskedShownRef.current) {
      maskedShownRef.current = key;
      const count = masked.reduce((sum, m) => sum + m.children.length, 0);
      showToast(`${count} step${count === 1 ? '' : 's'} kept under a deleted node`, {
        action: { label: 'Restore', run: () => masked.forEach((m) => collabRef.current?.dispatch({ kind: 'ResurrectNode', id: m.id })) },
      });
    } else if (!masked.length) {
      maskedShownRef.current = '';
    }

    if (collabRef.current?.pendingEditCount?.() === 0) setStranded(null);
  }, [syncStructure, showToast, syncLegendFromTree]);
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

  const undo = useCallback(() => collabRef.current?.undo(), []);
  const redo = useCallback(() => collabRef.current?.redo(), []);

  const handleRename = useCallback((id, label) => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return;
    const wasNamed = node.label.trim() !== '';
    collabRef.current?.dispatch({ kind: 'RenameNode', id, label });
    if (wasNamed) emit({ verb: 'renamed', nodeId: id, label, kind: node.color });
  }, [emit]);

  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const editor = editorRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !editor) return;

    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId });
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
    return id;
  }, [syncStructure, emit]);

  const handleCreateRoot = useCallback(() => {
    if (readOnlyRef.current) return;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    const color = legendRef.current[0]?.hue ?? 'terracotta';
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color });
    sceneRef.current?.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: color });
  }, [emit, setSelectedId]);

  const handleConnect = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'AddEdge', from: sourceId, to: targetId });
  }, []);

  const handleDeleteEdge = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'RemoveEdge', from: sourceId, to: targetId });
  }, []);

  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    collabRef.current?.dispatch({ kind: 'ReconnectEdge', oldFrom, oldTo, newFrom, newTo });
  }, []);

  const deleteNodeAt = useCallback((id) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    collabRef.current?.dispatch({ kind: 'DeleteNode', id });
    if (selectedIdRef.current === id) setSelectedId(null);
    showToast('Step deleted', { action: { label: 'Undo', run: undo } });
    emit({ verb: 'removed', nodeId: id, label: node?.label, kind: node?.color });
  }, [emit, showToast, undo]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  // Labels must be snapshotted BEFORE dispatch: the projection drops the doomed nodes synchronously.
  const bulkDelete = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    const edges = [...selectedEdgesRef.current].map(parseEdgeKey); // {from,to}
    if (!ids.length && !edges.length) return;
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const doomed = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    collabRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: ids, edges });
    for (const node of doomed) emit({ verb: 'removed', nodeId: node.id, label: node.label, kind: node.color });
    setMultiMode(false);
    setSelectedId(null);
    const parts = [];
    if (ids.length) parts.push(`${ids.length} step${ids.length === 1 ? '' : 's'}`);
    if (edges.length) parts.push(`${edges.length} link${edges.length === 1 ? '' : 's'}`);
    showToast(`${parts.join(' and ')} deleted`, { action: { label: 'Undo', run: undo } });
  }, [emit, showToast, undo, setSelectedId]);

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeColor', id, color: kind });
  }, []);

  // Same-parent siblings in sort order with their order keys; null off-tree.
  const reorderContext = useCallback((nodeId) => {
    const tree = treeRef.current;
    if (!tree || !tree.nodesById.has(nodeId)) return null;
    const parentId = tree.trunk.primaryParentOf(nodeId);
    const siblingIds = parentId === null
      ? [...tree.roots()].sort(cmpOrder).map((root) => root.id)
      : tree.trunk.trunkChildrenOf(parentId);
    return { siblings: siblingIds.map((id) => ({ id, order: tree.nodesById.get(id)?.order ?? '' })) };
  }, []);

  const handleSetNodeOrder = useCallback((id, order) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeOrder', id, order });
  }, []);

  const mobileRename = useCallback((id, label) => {
    const node = editorRef.current?.treeData.nodes.find((n) => n.id === id);
    const wasNamed = node && node.label.trim() !== '' && node.label !== label;
    handleRename(id, label);
    if (wasNamed) showToast('Renamed', { action: { label: 'Undo', run: undo }, duration: 4000 });
  }, [handleRename, showToast, undo]);

  const mobileRecolor = useCallback((id, kind) => {
    handleSetKind(id, kind);
    showToast('Recolored', { action: { label: 'Undo', run: undo }, duration: 4000 });
  }, [handleSetKind, showToast, undo]);

  // The undo must delete THIS bud, not pop the stack: naming it dispatches a RenameNode on top.
  const mobileAddStep = useCallback((parentId) => {
    const newId = handleCreateChild(parentId);
    if (!newId) return;
    showToast('Step added', {
      action: { label: 'Undo', run: () => {
        collabRef.current?.dispatch({ kind: 'DeleteNode', id: newId });
        if (selectedIdRef.current === newId) setSelectedId(null);
      } },
      duration: 4000,
    });
  }, [handleCreateChild, showToast]);

  const mobileDescribe = useCallback((id, text) => {
    const node = editorRef.current?.treeData.nodes.find((n) => n.id === id);
    if (!node) return;
    const before = node.description ?? '';
    if (before === text) return;
    collabRef.current?.dispatch({ kind: 'DescribeNode', id, description: text });
    showToast('Description updated', {
      action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'DescribeNode', id, description: before }) },
      duration: 4000,
    });
  }, [showToast]);

  const mobileListAddStep = useCallback((parentId, label) => {
    const parent = editorRef.current?.treeData.nodes.find((n) => n.id === parentId);
    if (!parent) return null;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label, icon: NEW_NODE_ICON, color: parent.color, parentId });
    emit({ verb: 'added', nodeId: id, label, kind: parent.color });
    showToast(`“${label}” planted`, {
      action: { label: 'Undo', run: () => {
        collabRef.current?.dispatch({ kind: 'DeleteNode', id });
        if (selectedIdRef.current === id) setSelectedId(null);
      } },
      duration: 4000,
    });
    return id;
  }, [emit, showToast, setSelectedId]);

  const mobileAddNeed = useCallback((id, parentId) => {
    const parent = editorRef.current?.treeData.nodes.find((n) => n.id === parentId);
    if (!parent) return;
    collabRef.current?.dispatch({ kind: 'AddEdge', from: parentId, to: id });
    showToast(`Linked — needs “${parent.label || 'Untitled step'}”`, {
      action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'RemoveEdge', from: parentId, to: id }) },
      duration: 4000,
    });
  }, [showToast]);

  const enterAim = useCallback((sourceId) => {
    setRemoving(null);
    setAim({ sourceId, direction: 'unlocks' });
  }, []);

  const flipAimDirection = useCallback(() => {
    setAim((current) => (current ? { ...current, direction: current.direction === 'unlocks' ? 'needs' : 'unlocks' } : current));
  }, []);

  const bulkRecolor = useCallback((color, { silent = false } = {}) => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    collabRef.current?.dispatch({ kind: 'BulkRecolor', nodeIds: ids, color });
    if (!silent) showToast(`${ids.length} step${ids.length === 1 ? '' : 's'} recolored`, { action: { label: 'Undo', run: undo } });
  }, [showToast, undo]);

  // onTreeChanged re-lays out synchronously, so grafted nodes are seated before they are pulsed.
  const graftImported = useCallback((parse) => {
    const editor = editorRef.current;
    const collab = collabRef.current;
    if (!editor || !collab) return;
    const nodes = editor.treeData.nodes;
    const selected = selectedIdRef.current;
    const anchored = selected && nodes.some((node) => node.id === selected);
    const targetId = (anchored ? selected : nodes.find((node) => node.prerequisites.length === 0)?.id) ?? null;

    const graft = graftPlan({
      parse,
      targetId,
      reservedNodeIds: collab.knownNodeIds(), // present AND tombstoned: never resurrect a deleted node
      liveKinds: legendRef.current,
    });
    if (graft.nodes.length === 0) { setComposerOpen(false); return; }

    collab.dispatch({ kind: 'ImportSubgraph', nodes: graft.nodes, edges: graft.edges, kinds: graft.kinds });

    for (const grafted of graft.nodes) {
      emit({ verb: 'added', nodeId: grafted.id, label: grafted.label, kind: grafted.color }, { silent: true });
      sceneRef.current?.pulseNode(grafted.id);
    }
    const count = graft.nodes.length;
    const targetLabel = targetId ? (nodes.find((node) => node.id === targetId)?.label || 'the tree') : null;
    const where = targetLabel ? ` under “${targetLabel}”` : '';
    showToast(`Added ${count} step${count === 1 ? '' : 's'}${where}`, { action: { label: 'Undo', run: undo } });
    setComposerOpen(false);
  }, [emit, showToast, undo]);

  // The scene is constructed once; React drives it through the methods below.
  useEffect(() => {
    const editing = readOnlyRef.current ? {} : {
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
      readOnly: readOnlyRef.current,
      onPanStateChange: handlePanStateChange,
      onNodePick: (id) => {
        setSheetHeld(false);
        if (id) { setSelectedId(id); return; }
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) setSelectedId(null);
        else closeActivity();
      },
      onNodeHover: (id) => setHoveredId(id),
      onCeremonyToast: speakCeremony,
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
  }, [handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, speakCeremony, handlePanStateChange, onSelectionToggle, onMarqueeSelect, onEdgeToggle, onEdgePick]);

  useEffect(() => {
    const onKey = (event) => {
      if (!readOnlyRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (!readOnlyRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        event.preventDefault();
        cancelNextUpSelect();
        const ids = editorRef.current?.treeData.nodes.map((n) => n.id) ?? [];
        const set = new Set(ids);
        setSelectedIds(set);
        setSelectedEdges(new Set());
        reconcileProjections(set, new Set());
        return;
      }
      if (event.key === 'Escape') {
        if (highlightedKindIdRef.current) { clearHighlightedKind(); return; }
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) { setSelectedId(null); return; }
        if (sceneRef.current?.selectedEdge) { sceneRef.current.selectEdge(null); return; }
        if (feedSummonedRef.current) closeActivity();
        return;
      }
      const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      if (event.key === 'a' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
        event.preventDefault();
        toggleActivity();
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        event.preventDefault();
        setShortcutsOpen((visible) => !visible);
        return;
      }
      if (!readOnlyRef.current && (event.key === 'Backspace' || event.key === 'Delete')) {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (selectedIdsRef.current.size + selectedEdgesRef.current.size > 1) { event.preventDefault(); bulkDelete(); return; }
        if (selectedIdRef.current) { event.preventDefault(); deleteSelected(); return; }
        const edge = sceneRef.current?.selectedEdge;
        if (edge) {
          event.preventDefault();
          handleDeleteEdge(edge.from, edge.to);
          setSelectedEdges(new Set());
          sceneRef.current?.projectEdge(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected, bulkDelete, handleDeleteEdge, toggleActivity, closeActivity, cancelNextUpSelect, setSelectedId, reconcileProjections, setShortcutsOpen, clearHighlightedKind]);

  useEffect(() => {
    const onPaste = (event) => {
      if (readOnlyRef.current) return;
      if (composerOpenRef.current) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const pasted = event.clipboardData?.getData('text/plain') ?? '';
      if (pasted.trim() === '') return;
      event.preventDefault();
      setDraftKinds(legendRef.current);
      setDraft(pasted);
      setComposerOpen(true);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, []);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { selectedEdgesRef.current = selectedEdges; }, [selectedEdges]);

  // setSelectedSet sweeps the whole array: it is the authority for the GPU highlight.
  useEffect(() => {
    sceneRef.current?.setSelection(selectedId);
    sceneRef.current?.setSelectedSet(selectedIds);
    sceneRef.current?.setSelectedEdges(selectedEdges);
  }, [selectedId, selectedIds, selectedEdges]);

  useEffect(() => {
    if (!scene || viewReadOnly) return undefined;
    let timer = null;
    const unsubscribe = scene.subscribeViewport(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!seedRef.current) return;
        placeStore.save({ treeId, camera: scene.getViewpoint(), selectedId: selectedIdRef.current });
      }, 400);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [scene, treeId, viewReadOnly]);

  useEffect(() => {
    if (viewReadOnly || loading || !seedRef.current) return;
    placeStore.save({ treeId, camera: sceneRef.current?.getViewpoint?.() ?? null, selectedId });
  }, [selectedId, loading, treeId, viewReadOnly]);

  useEffect(() => {
    if (autoFocusNameId && selectedId !== autoFocusNameId) setAutoFocusNameId(null);
  }, [selectedId, autoFocusNameId]);

  useEffect(() => () => toastTimersRef.current.forEach(clearTimeout), []);

  useEffect(() => {
    let cancelled = false;
    let autoOpenTimer = null;
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);
    setTreeVisibility(null);
    setTreeMine(false);
    forgetPeriod();
    repoRef.current = null;

    async function loadTree() {
      const repo = new HttpTreeRepository({ treeId });
      // Confirm who holds this device before anything is read from it or written to it.
      await resolveDeviceOwner();
      let seed = null;
      try { seed = await repo.loadTree(); } catch { /* fall through to the blob */ }
      if (!seed) {
        seed = await loadDeviceTree(treeId);
        if (!seed) throw new Error(`tree ${treeId}: unknown to the server, and not this device's to open`);
      }
      const treeData = seed;
      if (!cancelled) setHasLocalEdits(false);
      const nextTree = new SkillTree(treeData);
      const progress = demo
        ? { completed: new Set(DEMO_STAGED_COMPLETED), inProgress: new Set(), startedAt: {}, completedAt: {}, server: false }
        : await repo.loadProgress(treeData);
      const serverActivity = await repo.loadActivity({ limit: 200 });
      const overlay = progress;
      const states = UnlockRules.derive(nextTree, overlay);
      const positions = layoutPositions(nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
      const priorLedger = demo || readOnlyRef.current ? null : returnLedger.load(seed.id);
      const sinceIds = ReturnLedger.since(overlay.completed, priorLedger, states);
      if (sinceIds.length) {
        scene.armReturnRecap(sinceIds, `Welcome back · ${sinceIds.length} step${sinceIds.length > 1 ? 's' : ''} done since your last visit`);
      }
      scene.setModel(model);
      if (demo) scene.suppressArrivalToast();
      const place = viewReadOnly ? null : placeStore.load();
      const returning = place?.treeId === seed.id ? place : null;
      const savedCamera = returning?.camera
        && [returning.camera.x, returning.camera.y, returning.camera.zoom].every(Number.isFinite)
        ? returning.camera : null;
      if (savedCamera) scene.restoreViewpoint(savedCamera);
      else scene.fitToView();
      const restoredSelection = returning?.selectedId && treeData.nodes.some((n) => n.id === returning.selectedId)
        ? returning.selectedId : null;

      editorRef.current = new TreeEditor(treeData);
      seedRef.current = seed;
      repoRef.current = repo;
      openPeriod(seed.createdAt ?? 0);
      completedRef.current = new Set(overlay.completed);
      inProgressRef.current = new Set(overlay.inProgress);
      seedActivity({ tree: nextTree, states, completedAt: overlay.completedAt, serverActivity });
      setTree(nextTree);
      setRenderModel(model);
      setTreeVisibility(seed.visibility ?? null);
      setTreeMine(seed.mine ?? false);
      setCompleted(new Set(overlay.completed));
      setInProgress(new Set(overlay.inProgress));
      setStartedAt(overlay.startedAt);
      setCompletedAt(overlay.completedAt);
      hydrateWorkspaces(seed.id);
      hydrateLegend(seed.id, nextTree.nodes, seed.kinds ?? null);
      pushArcs();
      setBounds(scene.getBounds());
      if (restoredSelection) setSelectedId(restoredSelection);
      if (!viewReadOnly) placeStore.save({ treeId: seed.id, camera: scene.getViewpoint(), selectedId: restoredSelection });
      if (!demo && !readOnlyRef.current) returnLedger.save(seed.id, { completed: [...overlay.completed], at: Date.now() });
      setLoading(false);
      if (shared && seed.id === DEMO_TREE_ID) track('demo_open', { treeId: seed.id });

      // The daily budget burns via commit() only when the open actually fires.
      if (!readOnlyRef.current) {
        let readyNow = 0;
        for (const state of states.values()) if (state === 'available') readyNow += 1;
        const autoOpen = considerAutoOpen({ treeId: seed.id, readyCount: readyNow, stepCount: nextTree.nodes.length });
        if (autoOpen.open) {
          autoOpenTimer = setTimeout(() => {
            if (readOnlyRef.current || selectedIdRef.current || feedSummonedRef.current) return;
            autoOpen.commit();
            openActivity();
          }, NEXT_UP_ENTER_MS);
        }
      }

      considerWeekOffer(seed, { completed: overlay.completed, states, completedAt: overlay.completedAt });

      // Read-only views never enter the device index, so the claim path can't adopt a visited tree.
      collabRef.current?.close();
      peersRef.current.clear();
      const session = new SyncSession({ treeId: seed.id, title: seed.title, registry: viewReadOnly ? null : deviceTrees })
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
      session.start();
    }

    loadTree().catch((err) => {
      if (cancelled) return;
      console.warn('[tree] load failed', treeId, err);
      setLoadError(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      clearTimeout(autoOpenTimer);
      dropWeekOffer();
      cancelNextUpSelect();
      collabRef.current?.close();
      collabRef.current = null;
    };
  }, [reloadKey, treeId, demo]);

  const legendWithCounts = useMemo(() => (tree ? withCounts(legend, tree.nodes) : []), [legend, tree, states]);
  const inUse = useMemo(() => (tree ? inUseCount(legend, tree.nodes) : 0), [legend, tree, states]);
  const recolorKinds = legend.length > 0 ? legend : NODE_COLOR_NAMES.map((hue) => ({ id: hue, hue }));

  useEffect(() => {
    sceneRef.current?.applyStates(states);
  }, [states]);

  useEffect(() => { completedRef.current = completed; }, [completed]);
  useEffect(() => { inProgressRef.current = inProgress; }, [inProgress]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { composerOpenRef.current = composerOpen; }, [composerOpen]);

  useEffect(() => {
    if (!demo || status === 'loading') return undefined;
    let coachDone = false;
    try { coachDone = !!localStorage.getItem(COACH_DONE_KEY); } catch { /* private mode */ }
    if (status !== 'signed-in') { setCoachAllowed(coachEligible({ coachDone, signedIn: false, ownsTrees: false })); return undefined; }
    let cancelled = false;
    listAllTrees()
      .then((trees) => { if (!cancelled) setCoachAllowed(coachEligible({ coachDone, signedIn: true, ownsTrees: trees.length > 0 })); })
      .catch(() => { if (!cancelled) setCoachAllowed(false); });
    return () => { cancelled = true; };
  }, [demo, status]);

  const nextUpPlanRef = useRef(null);
  if (!feedVisible || !tree) nextUpPlanRef.current = null;
  else if (nextUpPlanRef.current === null) nextUpPlanRef.current = planNextUp(tree, states);
  const nextUpPlan = nextUpPlanRef.current;

  const readyCount = useMemo(() => {
    if (!tree || tree.nodes.length <= 1) return 0;
    let count = 0;
    for (const state of states.values()) if (state === 'available') count += 1;
    return count;
  }, [tree, states]);

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

  const handleNextUpOpen = useCallback((id) => {
    cancelNextUpSelect();
    const pending = nextUpSelectRef.current;
    const epoch = pending.epoch;
    sceneRef.current?.spotlightNode(null);
    sceneRef.current?.revealNode(id);
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      if (pending.epoch !== epoch) return;
      sceneRef.current?.spotlightNode(null);
      commitSelectedId(id);
      setSelectedIds(new Set([id]));
      setSelectedEdges(new Set());
      sceneRef.current?.selectEdge(null);
    }, NEXT_UP_SELECT_MS);
  }, [cancelNextUpSelect]);

  const handleNextUpAddStep = useCallback(() => {
    const nodes = editorRef.current?.treeData.nodes ?? [];
    if (nodes.length === 0) return;
    const parents = new Set(nodes.flatMap((node) => node.prerequisites));
    const anchor = [...nodes].reverse().find((node) => !parents.has(node.id)) ?? nodes[nodes.length - 1];
    handleCreateChild(anchor.id);
  }, [handleCreateChild]);

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
    sceneRef.current?.revealNode(id);
    setSelectedId(id);
  }, [setSelectedId]);

  const mobileEditable = treeMine && !shared && !demo && breakpoint !== 'desktop';

  // Phone only: the initial view is decided ONCE, the moment the tree is ready; tablet and desktop keep `view` null.
  const phone = breakpoint === 'phone';
  if (view === null && phone && tree) {
    const owner = treeMine && !shared && !demo && !demotion;
    setView(initialView({ saved: viewPrefs.lastView(treeId), owner, empty: tree.nodes.length === 0, born: peekBorn(treeId) }));
  }
  useEffect(() => {
    if (view !== null) clearBorn(treeId);
  }, [view, treeId]);
  const listReady = phone && !loading && !!tree && tree.nodes.length > 0;
  const listActive = listReady && view === 'list';

  // Mounted on first use and kept mounted; the ref updates during render, so the layer is present on that paint.
  const listShownRef = useRef(false);
  if (listActive) listShownRef.current = true;
  const listMounted = listReady && listShownRef.current;

  const switchView = useCallback((next) => {
    setView(next);
    viewPrefs.setLastView(treeId, next);
    setAim(null);
    setRemoving(null);
    if (multiMode) {
      setMultiMode(false);
      setSelectedIds(new Set());
      reconcileProjections(new Set(), new Set());
    }
    setSheetHeld(next === 'tree' && !multiMode && !!selectedId);
  }, [treeId, multiMode, selectedId, reconcileProjections]);

  useEffect(() => {
    if (!switcherOpen) return undefined;
    let cancelled = false;
    listAllTrees().then((rows) => { if (!cancelled) setSwitcherTrees(rows); });
    return () => { cancelled = true; };
  }, [switcherOpen]);

  const switcherRows = useMemo(() => {
    const list = Array.isArray(switcherTrees) ? switcherTrees : [];
    const current = { id: treeId, title: tree?.title, done: shareStats?.done, total: shareStats?.total, dominantKind: shareStats?.dominantKind };
    const row = list.find((candidate) => candidate.id === treeId);
    if (!row) return [current, ...list];
    return list.map((candidate) => (candidate.id === treeId ? { ...candidate, ...current } : candidate));
  }, [switcherTrees, treeId, tree, shareStats]);

  const enterMultiFromList = useCallback((id) => {
    if (!id) return;
    setAim(null);
    setRemoving(null);
    setMultiMode(true);
    const next = new Set([id]);
    setSelectedIds(next);
    setSelectedEdges(new Set());
    reconcileProjections(next, new Set());
  }, [reconcileProjections]);

  const toggleMultiMember = useCallback((id) => {
    const next = new Set(selectedIdsRef.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size === 0) setMultiMode(false);
    setSelectedIds(next);
    reconcileProjections(next, selectedEdgesRef.current);
  }, [reconcileProjections]);

  useEffect(() => {
    if (!phone || view === 'list' || !selectedId || multiMode || aim || removing) return;
    sceneRef.current?.revealNode(selectedId);
  }, [phone, view, selectedId, multiMode, aim, removing]);

  // stop() only cancels the RAF; applyModel runs fine while stopped and renders on the first frame after start().
  useEffect(() => {
    if (!scene) return undefined;
    if (listActive) scene.stop(); else scene.start();
    return undefined;
  }, [scene, listActive]);

  const sheetOpenNow = readOnly && phone && !!selectedNode && !aim && !removing && !multiMode && !sheetHeld && view !== 'list';
  const forkPresent = readOnly && (shared || !!demotion) && !demotion?.cardOpen;
  const laneLift = Math.max(
    0,
    sheetOpenNow ? (mobileEditable ? 300 : 216) + 12 - 16 : 0,
    forkPresent ? (18 + 50 + 12) - 16 : 0,
  );

  const listNotice = status === 'ghost' && treeMine && !demo ? (
    <button type="button" className="st-list-notice" onClick={openSignInDoor}>
      <span className="st-list-notice-text">Saved on this device — sign in to keep it</span>
      <span className="st-list-notice-chevron" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </span>
    </button>
  ) : null;

  useEffect(() => {
    if (!scene) return undefined;
    if (!mobileEditable || breakpoint === 'desktop') { scene.setEditTap(null); return undefined; }
    scene.setEditTap((x, y) => {
      setSheetHeld(false);
      const nodeId = scene.pick(x, y);
      if (multiMode) {
        if (nodeId === null) { setSelectedIds(new Set()); reconcileProjections(new Set(), new Set()); return; }
        const next = new Set(selectedIdsRef.current);
        if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
        if (next.size === 0) setMultiMode(false);
        setSelectedIds(next);
        reconcileProjections(next, selectedEdgesRef.current);
        return;
      }
      if (aim && tree && nodesById.has(aim.sourceId)) {
        if (nodeId === null) { setAim(null); return; }
        if (illegalTargets(tree, aim.sourceId, aim.direction).has(nodeId)) return;
        const { from, to } = edgeFor(aim.sourceId, nodeId, aim.direction);
        handleConnect(from, to);
        setAim(null);
        setSelectedId(aim.sourceId);
        showToast('Linked', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'RemoveEdge', from, to }) }, duration: 4000 });
        return;
      }
      if (nodeId) { setRemoving(null); setSelectedId(nodeId); return; }
      const edge = scene.pickEdge(x, y);
      if (edge) { setAim(null); setSelectedId(null); setRemoving({ from: edge.from, to: edge.to }); return; }
      setSelectedId(null);
    });
    return () => scene.setEditTap(null);
  }, [scene, mobileEditable, breakpoint, multiMode, aim, tree, nodesById, handleConnect, showToast, setSelectedId, reconcileProjections]);

  useEffect(() => {
    if (!scene) return undefined;
    if (!mobileEditable || breakpoint === 'desktop') { scene.setLongPress(null); return undefined; }
    scene.setLongPress((id) => {
      if (!id) return;
      setAim(null);
      setRemoving(null);
      setMultiMode(true);
      const next = new Set([id]);
      setSelectedIds(next);
      setSelectedEdges(new Set());
      reconcileProjections(next, new Set());
    });
    return () => scene.setLongPress(null);
  }, [scene, mobileEditable, breakpoint, reconcileProjections]);

  useEffect(() => {
    if (aim && tree && !nodesById.has(aim.sourceId)) setAim(null);
  }, [aim, tree, nodesById]);

  useEffect(() => {
    if (!scene || !aim || !tree || !nodesById.has(aim.sourceId)) return undefined;
    const illegal = illegalTargets(tree, aim.sourceId, aim.direction);
    illegal.delete(aim.sourceId); // never dim the anchor
    scene.setFaded(illegal);
    return () => scene.clearFaded();
  }, [scene, aim, tree, nodesById]);

  function pushProgress(nodeId, wireStatus) {
    if (demoRef.current) return;
    collabRef.current?.markProgress(nodeId, wireStatus);
  }

  function handleStart() {
    if (!selectedId) return;
    const node = nodesById.get(selectedId);
    const nextInProgress = new Set(inProgress).add(selectedId);
    const nextStartedAt = startedAt[selectedId] ? startedAt : { ...startedAt, [selectedId]: Date.now() };
    setInProgress(nextInProgress);
    setStartedAt(nextStartedAt);
    witnessProgress({ completed, inProgress: nextInProgress, startedAt: nextStartedAt, completedAt });
    pushProgress(selectedId, 'active');
    emit({ verb: 'started', nodeId: selectedId, label: node?.label, kind: node?.color }, { silent: true });
  }

  // Once ever per milestone: the ledger survives reloads and an undo/re-complete.
  function milestoneOffer(prevCompleted, nextCompleted) {
    // Gate on the genuine read-only signals, NOT the width-derived readOnly.
    if (!treeMine || shared || demo || demotion || !tree) return null;
    const fresh = detectMilestones(tree, prevCompleted, nextCompleted)
      .filter((milestone) => !milestoneLedger.has(treeId, milestone.id));
    const announcement = milestoneAnnouncement(fresh);
    if (!announcement) return null;
    for (const milestone of fresh) milestoneLedger.markOffered(treeId, milestone.id);
    dropWeekOffer();
    return {
      summary: announcement.summary,
      action: { label: announcement.label, run: () => { publishOgImageRef.current?.(); setShareOpen(true); } },
    };
  }

  function completeStep(id, { fromRemote = false } = {}) {
    const node = nodesById.get(id);
    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, [id], 'complete', Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    if (!fromRemote) pushProgress(id, 'complete');
    emit({ verb: 'completed', nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
    const after = UnlockRules.derive(tree, { completed: next.completed, inProgress: next.inProgress });
    let opened = 0;
    for (const [otherId, nodeState] of after) {
      if (nodeState === 'available' && states.get(otherId) !== 'available') {
        const unlocked = nodesById.get(otherId);
        emit({ verb: 'unlocked', nodeId: otherId, label: unlocked?.label, kind: unlocked?.color }, { silent: true });
        opened += 1;
      }
    }
    const label = node?.label?.trim() || 'Step';
    const stepSummary = demo && id === COACHED_NODE_ID
      ? DEMO_COPY.unlockToast
      : (opened > 0 ? `Step completed: ${label} · ${opened} more opened` : `Step completed: ${label}`);
    const offer = fromRemote ? null : milestoneOffer(completed, next.completed);
    const ceremony = offer ? offer.summary : stepSummary;
    const ceremonyOptions = offer ? { action: offer.action } : {};
    if (listActive) showToast(ceremony, ceremonyOptions);
    else sceneRef.current?.announceCeremony(ceremony, ceremonyOptions);

    if (demo) {
      setDemoCompletions((count) => count + 1);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (id === COACHED_NODE_ID && !reduced) {
        setTimeout(() => { setCtaEcho(true); setTimeout(() => setCtaEcho(false), 2600); }, CTA_ECHO_DELAY);
      }
    }
  }

  completeStepRef.current = completeStep;

  // completeStep can't be looped: each call reads the same render-time `completed`, so only the last would stick.
  function bulkMarkDone() {
    const targets = markDoneTargets(selectedIdsRef.current, completed);
    if (!targets.length) return;
    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, targets, 'complete', Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    for (const id of targets) {
      pushProgress(id, 'complete');
      const node = nodesById.get(id);
      emit({ verb: 'completed', nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
    }
    const after = UnlockRules.derive(tree, { completed: next.completed, inProgress: next.inProgress });
    for (const [otherId, nodeState] of after) {
      if (nodeState === 'available' && states.get(otherId) !== 'available') {
        const unlocked = nodesById.get(otherId);
        emit({ verb: 'unlocked', nodeId: otherId, label: unlocked?.label, kind: unlocked?.color }, { silent: true });
      }
    }
    const offer = milestoneOffer(completed, next.completed);
    if (offer) sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
  }

  function handleMarkComplete() {
    if (selectedId) completeStep(selectedId);
  }

  function handleSetState(id, target, { fromRemote = false } = {}) {
    if (!id) return;
    if (target === 'complete') { completeStep(id, { fromRemote }); return; }

    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, [id], target, Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setStartedAt(next.startedAt);
    setCompletedAt(next.completedAt);
    witnessProgress(next);
    if (!fromRemote) pushProgress(id, target === 'notstarted' ? 'none' : 'active');
  }

  // Read-only views never adopt the remote overlay, or a reader's empty overlay would overwrite the owner's progress.
  applyRemoteProgressRef.current = (overlay) => {
    if (demoRef.current) return;
    if (readOnlyRef.current) return;
    for (const id of overlay.completed) {
      if (!nodesById.has(id) || completedRef.current.has(id)) continue;
      handleSetState(id, 'complete', { fromRemote: true });
    }
    for (const id of overlay.inProgress) {
      if (!nodesById.has(id) || inProgressRef.current.has(id)) continue;
      handleSetState(id, 'inprogress', { fromRemote: true });
    }
    for (const id of [...completedRef.current, ...inProgressRef.current]) {
      if (!nodesById.has(id) || overlay.completed.has(id) || overlay.inProgress.has(id)) continue;
      handleSetState(id, 'notstarted', { fromRemote: true });
    }
    setStartedAt(overlay.startedAt);
    setCompletedAt(overlay.completedAt);
  };

  function handleZoomIn() {
    sceneRef.current?.zoomBy(1.2);
  }

  function handleZoomOut() {
    sceneRef.current?.zoomBy(1 / 1.2);
  }

  function handleFitToView() {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.fitToView();
    setBounds(scene.getBounds());
  }

  function handleRecenter() {
    handleFitToView();
    setRecenterAvailable(false);
  }

  function handlePanTo(x, y) {
    sceneRef.current?.panTo(x, y);
  }

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

  const readOnlyDetail = selectedNode && (
    <StepPanel
      readOnly
      node={selectedNode}
      state={selectedState}
      prerequisites={prerequisites}
      unlocks={unlocks}
      startedAt={startedAt[selectedId]}
      completedAt={completedAt[selectedId]}
      history={selectedHistory}
      workspace={workspaceByNode[selectedId] ?? emptyWorkspace()}
      kinds={legend}
      onReveal={handleRevealNode}
      onJump={handleSheetJump}
      onMarkComplete={demo ? handleMarkComplete : undefined}
      onClose={() => setSelectedId(null)}
    />
  );

  const mobileSurface = activeSurface({ multiMode, aim, removing, selectedNode });

  const lanePill = listReady ? <ViewPill view={view} onSwitch={switchView} /> : null;
  const laneTend = canTend && breakpoint !== 'desktop' && mobileSurface === 'empty' ? (
    <TendBar
      variant="phone"
      working={tendWorking}
      placeholder={tree && tree.nodes.length === 0 ? 'What do you want to learn or build?' : 'Tell the tree what to change…'}
      examples={tree && tree.nodes.length > 0 ? ['Is this realistic?', 'What am I missing?'] : []}
      onSubmit={submitTend}
    />
  ) : null;
  const laneShare = mobileEditable && tree && tree.nodes.length > 0 ? (
    <LaneButton icon="share" label="Share" onClick={() => setShareOpen(true)} />
  ) : null;

  return (
    <div className={`st-root ${panning ? 'panning' : ''}`} ref={rootRef}>
      <canvas
        ref={canvasRef}
        className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''} ${phone && view !== null ? 'st-canvas--layer' : ''}`}
        style={listActive ? { opacity: 0, pointerEvents: 'none' } : undefined}
      />

      {!readOnly && (
        <PresenceLayer peersRef={peersRef} scene={scene} canvasRef={canvasRef} collabRef={collabRef} selection={selectedId} />
      )}

      {!readOnly && tree && tree.nodes.length === 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 15, pointerEvents: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-4)', padding: 'var(--space-6) var(--space-7)', background: 'var(--surface-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)', pointerEvents: 'auto', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>This tree is empty</div>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Add a first step to start growing it.</p>
            <Button onClick={handleCreateRoot}>Add your first step</Button>
            {breakpoint === 'desktop' && (
              <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>or paste a plan — ⌘V</p>
            )}
          </div>
        </div>
      )}

      {listMounted && (
        <div className={`st-view-layer st-view-layer--list ${listActive ? 'is-active' : ''}`}>
          <ListView
            tree={tree}
            nodesById={nodesById}
            states={states}
            completedAt={completedAt}
            legend={legend}
            header={{ name: tree.title, dominantHue: shareStats?.dominantKind }}
            notice={listNotice}
            selectedId={selectedId}
            onSelect={setSelectedId}
            active={listActive}
            prefs={viewPrefs}
            treeId={treeId}
            laneInset={laneInset}
            portalTarget={rootRef.current}
            editable={mobileEditable}
            switcher={mobileEditable ? () => setSwitcherOpen(true) : undefined}
            multiMode={multiMode}
            selectedIds={selectedIds}
            onEnterMulti={mobileEditable ? enterMultiFromList : undefined}
            onToggleMember={mobileEditable ? toggleMultiMember : undefined}
            handlers={mobileEditable ? {
              rename: mobileRename,
              describe: mobileDescribe,
              addStep: mobileListAddStep,
              markDone: (id) => completeStep(id),
              markUndone: (id) => handleSetState(id, 'notstarted'),
              recolor: mobileRecolor,
              remove: deleteNodeAt,
              addNeed: mobileAddNeed,
            } : undefined}
          />
        </div>
      )}

      {readOnly ? (
        <MobileChrome
          view={phone && view === 'list' ? 'list' : 'tree'}
          title={tree?.title}
          progress={{ done: shareStats?.done ?? 0, total: shareStats?.total ?? 0 }}
          author={tree?.author}
          byline={demo ? `${DEMO_COPY.plaqueByline} · ${shareStats?.done ?? 0}/${shareStats?.total ?? 0} done` : undefined}
          ctaEcho={ctaEcho}
          dominantKind={shareStats?.dominantKind}
          onFork={(shared || !!demotion) && !demotion?.cardOpen ? () => setForkOpen(true) : undefined}
          onSignInToKeep={status === 'ghost' && treeMine && !demo ? openSignInDoor : undefined}
          onRecenter={handleRecenter}
          showRecenter={recenterAvailable}
          tablet={breakpoint === 'tablet'}
          panelOpen={!!selectedNode}
        />
      ) : (
        <ControlBar
          title={tree?.title}
          onTend={canTend ? () => setTendOpen(true) : undefined}
          titleSlot={
            <TreeSwitcher
              current={{ id: treeId, title: tree?.title, done: shareStats?.done, total: shareStats?.total, dominantKind: shareStats?.dominantKind }}
              listTrees={listAllTrees}
              onNew={() => { window.location.hash = '#/app/new'; }}
              onRename={handleRenameTree}
              onPreviewTitle={previewTreeTitle}
              onDelete={handleDeleteTree}
            />
          }
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onFitToView={handleFitToView}
          canReset={hasLocalEdits}
          onResetEdits={handleResetEdits}
          onShare={() => setShareOpen(true)}
          onShowShortcuts={() => setShortcutsOpen(true)}
          activityOpen={feedVisible}
          activityUnread={unreadCount}
          activityPing={activityPing}
          readyCount={readyCount}
          onToggleActivity={toggleActivity}
        />
      )}

      {(lanePill || laneTend || laneShare) && (
        <ActionLane lift={laneLift} onHeight={setLaneInset} left={lanePill} center={laneTend} right={laneShare} />
      )}

      {listReady && mobileEditable && (
        <SwitcherSheet
          portalTarget={rootRef.current}
          open={switcherOpen}
          trees={switcherRows}
          currentId={treeId}
          onPick={(id) => { setSwitcherOpen(false); if (id && id !== treeId) window.location.hash = `#/app/${id}`; }}
          onPlant={() => { setSwitcherOpen(false); window.location.hash = '#/app/new'; }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}

      {canTend && breakpoint === 'desktop' && tendOpen && (
        <TendBar
          variant="desktop"
          working={tendWorking}
          placeholder={tree && tree.nodes.length === 0 ? 'What do you want to learn or build?' : 'Tell the tree what to change…'}
          examples={tree && tree.nodes.length > 0 ? ['Is this realistic?', 'What am I missing?'] : []}
          onSubmit={submitTend}
          onDismiss={() => setTendOpen(false)}
        />
      )}

      {stranded && !demo && (
        <div style={{ position: 'absolute', top: 'calc(max(env(safe-area-inset-top, 0px), 44px) + 8px)', left: '50%', transform: 'translateX(-50%)', zIndex: 24 }}>
          <StatusChip>{stranded}</StatusChip>
        </div>
      )}

      {!readOnly && status !== 'signed-in' && treeMine && !demo && (
        <div style={{ position: 'absolute', top: 'calc(var(--space-6) + 52px)', right: 'var(--space-6)', zIndex: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusChip>{lapsed ? 'Signed out — saved on this device' : 'Saved on this device — sign in to keep it'}</StatusChip>
        </div>
      )}

      <Minimap
        nodes={renderModel?.nodes ?? []}
        states={states}
        bounds={bounds}
        subscribeViewport={scene?.subscribeViewport ?? null}
        onPanTo={handlePanTo}
      />

      {(inUse >= 2 || legendForceOpen) && (
        <div className="st-legend-dock" style={{ position: 'absolute', left: 'var(--space-6)', bottom: 'calc(var(--space-6) + 196px)', zIndex: 16 }}>
          <KindLegend
            kinds={legendWithCounts}
            defaultOpen={legendOpen}
            onOpenChange={onLegendOpenChange}
            selectedId={highlightedKindId}
            onHighlight={onHighlightKind}
            {...(readOnly ? {} : {
              onRename: onRenameKind,
              onRecolor: onRecolorKind,
              onAdd: onAddKind,
              onRemove: onRemoveKind,
              onDescribe: onDescribeKind,
            })}
          />
        </div>
      )}

      {!readOnly && (
        <aside className={`st-detail-panel ${composerOpen || selectedNode || feedVisible ? 'st-detail-panel--open' : ''}`}>
          <div className="st-dock-tenant" key={composerOpen ? 'composer' : selectedNode ? selectedNode.id : 'activity'}>
            {composerOpen ? composer : selectedNode ? (
              <StepPanel
                node={selectedNode}
                state={selectedState}
                prerequisites={prerequisites}
                startedAt={startedAt[selectedId]}
                completedAt={completedAt[selectedId]}
                history={selectedHistory}
                workspace={workspaceByNode[selectedId] ?? emptyWorkspace()}
                autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
                onRename={handleRename}
                onAddSubtask={onAddSubtask}
                onToggleSubtask={onToggleSubtask}
                onEditSubtask={onEditSubtask}
                onDeleteSubtask={onDeleteSubtask}
                onSetNote={onSetNote}
                onAddLink={onAddLink}
                onDeleteLink={onDeleteLink}
                onPreviewKind={(id, kind) => sceneRef.current?.previewKind(id, kind)}
                onRestoreKind={(id) => sceneRef.current?.restoreKind(id)}
                onSetKind={handleSetKind}
                kinds={legend}
                onOpenLegend={openLegendFromPicker}
                onStart={handleStart}
                onMarkComplete={handleMarkComplete}
                onSetState={handleSetState}
                onReveal={handleRevealNode}
                onDelete={deleteNodeAt}
                onPreviewDeleteCost={(id) => sceneRef.current?.previewDeleteCost(id)}
                onClearDeleteCost={() => sceneRef.current?.clearDeleteCost()}
                onClose={() => setSelectedId(null)}
              />
            ) : feedVisible ? (
              <ActivityFeed
                groups={activityGroups}
                count={eventCount}
                nodesById={nodesById}
                now={Date.now()}
                hoveredId={hoveredId}
                newIds={newEventIds}
                pinned={pinned}
                onTogglePin={togglePin}
                onClose={closeActivity}
                onHoverNode={handleRowHover}
                onLeaveNode={handleRowLeave}
                onRevealNode={handleRevealNode}
                readyPill={nextUpPlan?.mount ? (nextUpPlan.mode === 'allDone' ? nextUpPlan.pill : `${readyCount} ready`) : null}
                nextUp={nextUpPlan?.mount ? (
                  <NextUp
                    plan={nextUpPlan}
                    nodesById={nodesById}
                    states={states}
                    onHoverNode={handleRowHover}
                    onLeaveNode={handleRowLeave}
                    onOpenStep={handleNextUpOpen}
                    onAddStep={handleNextUpAddStep}
                  />
                ) : null}
              />
            ) : null}
          </div>
        </aside>
      )}

      {readOnly && breakpoint === 'phone' && (
        <BottomSheet
          open={!!selectedNode && !aim && !removing && !multiMode && view !== 'list' && !sheetHeld}
          onDismiss={() => setSelectedId(null)}
          peekHeight={mobileEditable ? 300 : undefined}
          maxVh={mobileEditable ? 66 : undefined}
        >
          {mobileEditable
            ? (selectedNode && (
                <MobileEditorSheet
                  key={selectedNode.id}
                  node={selectedNode}
                  state={selectedState}
                  prerequisites={prerequisites}
                  unlocks={unlocks}
                  completedAt={completedAt[selectedId]}
                  kinds={legend}
                  autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
                  onRename={mobileRename}
                  onAddStep={mobileAddStep}
                  onConnect={enterAim}
                  onSetKind={mobileRecolor}
                  onMarkDone={(id) => completeStep(id)}
                  onUnmarkDone={(id) => handleSetState(id, 'notstarted')}
                  onDelete={deleteNodeAt}
                  onJump={handleSheetJump}
                  isRoot={selectedId !== null && selectedId === singleRootId}
                />
              ))
            : (readOnlyDetail && React.cloneElement(readOnlyDetail, { fill: true }))}
        </BottomSheet>
      )}

      {mobileEditable && breakpoint === 'phone' && aim && !multiMode && view !== 'list' && (
        <AimBar
          sourceLabel={nodesById.get(aim.sourceId)?.label}
          direction={aim.direction}
          onToggleDirection={flipAimDirection}
          onCancel={() => setAim(null)}
        />
      )}

      {mobileEditable && breakpoint === 'phone' && removing && !multiMode && view !== 'list' && (
        <RemoveLinkBar
          onRemove={() => {
            const { from, to } = removing;
            handleDeleteEdge(from, to);
            setRemoving(null);
            showToast('Link removed', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'AddEdge', from, to }) }, duration: 4000 });
          }}
          onCancel={() => setRemoving(null)}
        />
      )}

      {mobileEditable && breakpoint === 'phone' && multiMode && (
        <BulkBar
          count={selectedIds.size}
          kinds={recolorKinds}
          ringedKind={ringedKind}
          onRecolor={bulkRecolor}
          onDelete={bulkDelete}
          onDone={() => { setMultiMode(false); setSelectedId(null); }}
        />
      )}

      {mobileEditable && breakpoint === 'tablet' && (
        <aside className={`st-detail-panel st-detail-panel--tablet ${mobileSurface !== 'empty' ? 'st-detail-panel--open' : ''}`}>
          <div className="st-dock-tenant" key={mobileSurface === 'editor' ? selectedNode.id : mobileSurface}>
            {mobileSurface === 'bulk' ? (
              <BulkBar
                inPanel
                count={selectedIds.size}
                kinds={recolorKinds}
                ringedKind={ringedKind}
                onRecolor={bulkRecolor}
                onDelete={bulkDelete}
                onDone={() => { setMultiMode(false); setSelectedId(null); }}
              />
            ) : mobileSurface === 'aim' ? (
              <AimBar
                inPanel
                sourceLabel={nodesById.get(aim.sourceId)?.label}
                direction={aim.direction}
                onToggleDirection={flipAimDirection}
                onCancel={() => setAim(null)}
              />
            ) : mobileSurface === 'remove' ? (
              <RemoveLinkBar
                inPanel
                onRemove={() => {
                  const { from, to } = removing;
                  handleDeleteEdge(from, to);
                  setRemoving(null);
                  showToast('Link removed', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'AddEdge', from, to }) }, duration: 4000 });
                }}
                onCancel={() => setRemoving(null)}
              />
            ) : mobileSurface === 'editor' ? (
              <MobileEditorSheet
                panel
                key={selectedNode.id}
                node={selectedNode}
                state={selectedState}
                prerequisites={prerequisites}
                unlocks={unlocks}
                completedAt={completedAt[selectedId]}
                kinds={legend}
                autoFocusName={selectedId !== null && selectedId === autoFocusNameId}
                onRename={mobileRename}
                onAddStep={mobileAddStep}
                onConnect={enterAim}
                onSetKind={mobileRecolor}
                onMarkDone={(id) => completeStep(id)}
                onUnmarkDone={(id) => handleSetState(id, 'notstarted')}
                onDelete={deleteNodeAt}
                onJump={handleSheetJump}
                isRoot={selectedId !== null && selectedId === singleRootId}
              />
            ) : null}
          </div>
        </aside>
      )}

      {readOnly && breakpoint !== 'phone' && !(mobileEditable && breakpoint === 'tablet') && (
        <aside className={`st-detail-panel ${breakpoint === 'tablet' ? 'st-detail-panel--tablet' : ''} ${selectedNode ? 'st-detail-panel--open' : ''}`}>
          <div className="st-dock-tenant" key={selectedNode ? selectedNode.id : 'empty'}>
            {readOnlyDetail}
          </div>
        </aside>
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
          onFork={() => { setDemotion((d) => d && { ...d, cardOpen: false }); setForkOpen(true); }}
          onDismiss={() => setDemotion((d) => d && { ...d, cardOpen: false })}
          onSignIn={openSignInDoor}
        />
      )}

      {(shared || !!demotion) && (
        <ForkDoor open={forkOpen} tablet={breakpoint === 'tablet'} treeId={treeId} signedIn={status === 'signed-in'} demo={demo} stepCount={shareStats?.total} onClose={() => setForkOpen(false)} />
      )}

      {demo && coachAllowed && scene && view !== 'list' && (
        <CoachChip
          scene={scene}
          nodeId={COACHED_NODE_ID}
          onMarkDone={() => completeStep(COACHED_NODE_ID)}
          completionCount={demoCompletions}
        />
      )}

      {!readOnly && selectedIds.size + selectedEdges.size > 1 && (
        <div className="st-selection-bar" role="status">
          <span className="st-selection-count">{selectedIds.size + selectedEdges.size} selected</span>
          {selectedIds.size > 0 && (
            <div className="st-step-kinds" role="group" aria-label="Recolour selected steps">
              {recolorKinds.map((kind) => {
                const name = kind.label || kind.hue.charAt(0).toUpperCase() + kind.hue.slice(1);
                return (
                  <button
                    key={kind.id}
                    type="button"
                    className={`st-step-swatch ${kind.hue === ringedKind ? 'st-step-swatch--current' : ''}`}
                    style={{ background: NODE_COLORS[kind.hue].base }}
                    title={name}
                    aria-label={`Recolour selection to ${name}`}
                    onPointerEnter={() => sceneRef.current?.previewKindSet([...selectedIdsRef.current], kind.hue)}
                    onPointerLeave={() => sceneRef.current?.restoreKindSet([...selectedIdsRef.current])}
                    onClick={() => bulkRecolor(kind.hue, { silent: true })}
                  />
                );
              })}
            </div>
          )}
          {selectedIds.size > 0 && (
            <button type="button" className="st-selection-done" onClick={bulkMarkDone}>Mark all done</button>
          )}
          <span
            className="st-selection-delete"
            onPointerEnter={() => sceneRef.current?.previewDeleteCostSet([...selectedIdsRef.current])}
            onPointerLeave={() => sceneRef.current?.clearDeleteCost()}
          >
            <Button variant="danger" size="sm" onClick={bulkDelete}>Delete</Button>
          </span>
        </div>
      )}

      {toast && (
        <div className={`st-toast ${toast.leaving ? 'is-leaving' : ''} ${toast.detail && toastWhyOpen ? 'st-toast--expanded' : ''}`} role="status" key={toast.key}>
          <div className="st-toast-row">
            <span>{toast.message}</span>
            {toast.detail && (
              <button
                className="st-toast-why"
                onClick={() => {
                  toastTimersRef.current.forEach(clearTimeout);
                  toastTimersRef.current = [];
                  setToastWhyOpen((open) => !open);
                }}
              >
                {toastWhyOpen ? 'Hide' : 'Why?'}
              </button>
            )}
            {toast.action && (
              <button className="st-toast-undo" onClick={() => { toast.action.run(); dismissToast(); }}>
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

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} readOnly={readOnly} />

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        visibility={treeVisibility}
        mine={treeMine}
        onShareLink={publishOgImage}
        onStanceChange={setTreeVisibility}
        weekSegment={weekSegment}
      />

      {loading && !loadError && <div className="st-loading"><span className="st-loading-msg">Planting the tree…</span></div>}
      {loadError && (
        <div className="st-load-error">
          <p className="st-loading-msg">Couldn’t load this roadmap. It may have moved, or the server is unreachable.</p>
          <div className="st-load-error-actions">
            <Button onClick={() => setReloadKey((k) => k + 1)}>Try again</Button>
            <a href="#/app" className="st-load-error-link">Your trees</a>
          </div>
        </div>
      )}
    </div>
  );
}
