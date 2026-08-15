// Skill-tree view — runs the pipeline (repository → domain → layout → scene)
// and hosts the overlay UI around the GPU canvas: top controls, the docked
// step panel, and a minimap. Node state comes from UnlockRules.derive.
//
// This used to claim "no business logic lives here — this file only wires data through", which
// was false in three places and was the sentence that let the file reach three thousand lines.
// One of the three has moved out: advancing progress and choosing which milestone to announce are
// pure functions in model/progress.js now, with their own tests. Two are still here — the
// remote-frame idempotency and anti-clobber reconciliation around the progress push, and the
// startedAt/completedAt stamping that rides with them. They are named rather than denied. They
// also stay on purpose: their failure mode is silent data loss (a stale local mark overwriting a
// server row, a remote frame applied twice), and no seam has yet been found that carries them out
// without splitting that guarantee in two.
//
// Four of the editors this file used to be have moved to their own hooks, each sitting over the
// pure model or feature package it drives: ui/tree/useLegend.js (the colour key's kinds, open
// flag, spotlight and every kind gesture), ui/tree/useWorkspace.js (a step's sub-tasks, note and
// links, the arc feed and the auto-complete breath), share/useWeekOffer.js (the unfurl card, the
// period's progress card, the share ledger and the one ask that offers it) and
// activity/useActivity.js (the log, `emit`, the unread badge, the arrival flash and the ticker).
// What stays here of theirs is only what joins them to the live tree: the legend's per-kind
// counts, the triggers the load and the ceremony pull on the offer, the `emit` call at every edit
// site, and the panels that render all of it.

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
import { isOwnershipRefusal } from './sync/refusals.js';
import { SyncStore } from './sync/SyncStore.js';
import { TreeLattice } from './sync/lattice.js';
import { claimLocalTrees } from './sync/claimLocalTrees.js';
import { renameLocalTree, deleteLocalTree } from './sync/localTrees.js';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { ProgressStore } from './persistence/ProgressStore.js';
import { LocalTreeRegistry } from './persistence/LocalTreeRegistry.js';
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
const progressStore = new ProgressStore();
const syncStore = new SyncStore();
const deviceTrees = new LocalTreeRegistry();
const placeStore = new PlaceStore();
const viewPrefs = new ViewPrefs();
const returnLedger = new ReturnLedger();
const milestoneLedger = new MilestoneLedger();
const NEXT_UP_SELECT_MS = 540; // ~90% of the camera's default 600ms glide — the dock swaps as the fly settles
const NEXT_UP_ENTER_MS = 600; // auto-open waits for the fit-to-view camera to still (whats-next-panel §04)
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const NEW_NODE_ICON = 'sparkles';
const PLANTED_QUEST_KEY = 'windmill:planted-quest'; // the shelf's one-shot note (F5 §04): this arrival is a quest
const CTA_ECHO_DELAY = 1500; // §04: ~when the unlock toast has settled + 120ms — the Fork CTA takes the pulse once

// The one-shot session notes both consume the same way: read, clear, answer.
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
  const openSignInDoor = useSignInDoor(); // the one door (shell/auth/SignInDoor.jsx) — the seat, the list notice and an expired landing all ask it
  const { breakpoint, readOnly: viewReadOnly, shared } = useViewMode();
  const { status, refresh } = useAuth(); // this canvas reads the session; the seat that shows it lives in the shell's head

  // The honesty split (share-hardening): an owner's lapsed sign-in never downgrades —
  // saves stay on this device and only the chrome tells the truth (lapsed). A visitor
  // on a tree that isn't theirs gets the true downgrade (demotion) into read-only.
  const [lapsed, setLapsed] = useState(false); // owner lapse: chip persists until re-auth
  const [demotion, setDemotion] = useState(null); // visitor downgrade: { edits, cardOpen } | null
  const readOnly = viewReadOnly || !!demotion;

  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const readOnlyRef = useRef(readOnly); // the scene is built once; it reads the fresh mode without a rebuild
  const progressRef = useRef({ completed: new Set(), inProgress: new Set() });
  const editorRef = useRef(null);
  const treeRef = useRef(null); // the current projected SkillTree — the angular-reorder gesture reads its trunk for a node's siblings
  const layoutCacheRef = useRef({ signature: '', raw: new Map() });
  const completedRef = useRef(new Set());
  const inProgressRef = useRef(new Set());
  const seedRef = useRef(null); // the authored seed for the current tree (persistence baseline)
  const repoRef = useRef(null); // the TreeRepository for the current tree — the one door to its server reads
  const collabRef = useRef(null); // live socket to windmill-backend (dogfood roadmap only)
  const peersRef = useRef(new Map()); // actor -> { name, color, cursor, selection } for the presence overlay
  const onTreeChangedRef = useRef(null); // always points at the latest onTreeChanged
  const maskedShownRef = useRef(''); // the masked-work set last surfaced, so we prompt once per change
  const applyRemoteProgressRef = useRef(null); // latest applyRemoteProgress (this account's own overlay)
  const reconcileProgressRef = useRef(null); // latest reconcileProgress — runs after each subscribe graft
  const prevAuthRef = useRef(status);
  const suspectRef = useRef(false); // a rejected write cast doubt on the session; refresh() is verifying
  const demotedRef = useRef(false); // the demotion fires once per session, ever
  const claimRunRef = useRef(false); // at most one claim pass in flight; the registry is the durable state

  // The claim (anon-first-tree F4): adopt this device's unclaimed local trees. All the
  // durable state lives in the LocalTreeRegistry, so a run is fire-and-forget — a reload
  // mid-claim loses nothing, the next trigger re-runs the sequence.
  //
  // `narrated` used to hold the seat's gold "Syncing…" chip open until this run reported back
  // (F5). The seat this canvas drew is gone — the shell's head carries the only one — and the
  // shell's seat still plays the claim beat on a live ghost→signed-in flip, on its own clock
  // rather than on the run's. Nothing here has anything left to tell, so the flag is only the
  // silence rule now: a boot resume narrates nothing, which is what it always meant.
  const kickClaim = useCallback(() => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    claimLocalTrees({ openTreeId: treeId, openSession: () => collabRef.current })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  // A tab born signed-in — the magic-link landing's fresh tab, or a reload that lost a
  // mid-flight claim — still resumes whatever the device index holds unclaimed.
  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim();
  }, [kickClaim]);

  // Auth transitions re-anchor the wire. The socket's principal is fixed at the upgrade,
  // so a mid-session sign-in or sign-out must reconnect to match the seat; a boot-time
  // sign-in resolution only needs the reconcile the still-loading guard skipped.
  useEffect(() => {
    const prev = prevAuthRef.current;
    prevAuthRef.current = status;
    if (prev === status) return;
    if (status === 'signed-in') {
      // A demoted visitor signing in is the owner coming home — cross the read-only →
      // editor boundary on a clean page load (ForkDoor's proven escape): the scene is
      // reborn in editor mode and the outbox flushes the banked edits on subscribe.
      if (demotedRef.current) { window.location.reload(); return; }
      setLapsed(false); // re-auth: the chip clears; the reconnect flushes the bank
    }
    if (prev === 'loading' && status === 'signed-in') {
      reconcileProgressRef.current?.();
      kickClaim(); // silent resume of unfinished claims (anon-first-tree F4 boot trigger)
      return;
    }
    if (prev === 'ghost' && status === 'signed-in') {
      collabRef.current?.forceReconnect();
      kickClaim(); // the live claim; the shell seat's own beat narrates the flip
      return;
    }
    if (prev === 'signed-in') {
      // The chip speaks only when a rejected write's suspicion is confirmed by the
      // sign-out; a voluntary sign-out carries no suspicion and shows no chip.
      if (suspectRef.current) { suspectRef.current = false; setLapsed(true); }
      collabRef.current?.forceReconnect();
    }
  }, [status, kickClaim]);

  // A rejected write is the truth arriving (honesty moments). Owner lapse: editing never
  // stops — re-check the session so the seat honestly goes ghost, and let the chip speak.
  // Visitor: the true downgrade — the scene retires its edit chrome in place (waiting out
  // a mid-keystroke moment), and the notice card counts the edits banked on this device.
  useEffect(() => {
    let idleTimer = null;
    let waiting = false;
    let lastActivityAt = 0;
    const noteActivity = () => { lastActivityAt = Date.now(); };
    const stopWaiting = () => {
      window.removeEventListener('keydown', noteActivity, true);
      window.removeEventListener('pointerdown', noteActivity, true);
    };
    // The wave waits for your hands — a focused field or an active canvas drag defers
    // the downgrade — but only while the hands are moving: 400ms of stillness means a
    // parked cursor, and the truth lands anyway (the lie-window stays bounded).
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
      // event.detail is the reject frame itself; its `code` decides, never its sentence.
      if (isOwnershipRefusal(event.detail)) {
        if (demotedRef.current || waiting) return;
        lastActivityAt = Date.now(); // the rejected gesture itself counts as activity
        demote();
        return;
      }
      // sign-in-required — suspicion, not verdict: re-check
      // the session and let the auth transition (or its absence) decide whether the chip speaks.
      if (suspectRef.current) return;
      suspectRef.current = true;
      refresh().then((me) => {
        const stillSignedIn = me !== undefined ? !!me : prevAuthRef.current === 'signed-in';
        if (stillSignedIn) suspectRef.current = false; // false alarm — future rejects re-check
      });
    };
    window.addEventListener('wm-edit-forbidden', onForbidden);
    return () => {
      window.removeEventListener('wm-edit-forbidden', onForbidden);
      stopWaiting();
      clearTimeout(idleTimer);
    };
  }, [refresh]);
  const invalidRef = useRef(false); // whether the last render fell back to the loose-graph path
  const plantedQuestRef = useRef(null); // consumed once on mount; survives StrictMode's double effect
  const forkedFromDemoRef = useRef(null); // the fork-from-demo note, consumed once (F4 §05)
  const demoRef = useRef(demo); // the scene is built once; the write seams read the fresh demo mode without a rebuild
  useEffect(() => { demoRef.current = demo; }, [demo]);
  const selectedIdRef = useRef(null);
  const selectedIdsRef = useRef(new Set()); // the live multi-selection for the synchronous key/gesture checks
  const selectedEdgesRef = useRef(new Set()); // the live edge multi-selection (keys), for the same synchronous checks
  const toastTimersRef = useRef([]); // pending hold→leave→unmount timers for the active toast
  const toastKeyRef = useRef(0); // monotonic key so a replacing toast remounts and re-enters
  const completeStepRef = useRef(null); // always points at the latest completeStep (for the deferred beat)
  const composerOpenRef = useRef(false); // mirrors composerOpen for the capture-phase ⌘V guard

  // The color key (F6) — its kinds, its open flag, its spotlight and every kind gesture, over
  // the pure model/Legend.js. The counts it renders stay below, where the live tree is.
  const {
    legend, legendRef, legendOpen, legendForceOpen, highlightedKindId, highlightedKindIdRef,
    hydrateLegend, syncLegendFromTree, clearLegendStore, clearHighlightedKind,
    onRenameKind, onDescribeKind, onAddKind, onRemoveKind, onRecolorKind,
    onHighlightKind, onLegendOpenChange, openLegendFromPicker,
  } = useLegend({ seedRef, collabRef, editorRef, sceneRef });

  // Each step's own workspace (F13) — sub-tasks, note, links — over the pure
  // model/NodeWorkspace.js, plus the arc feed and the auto-complete breath a full checklist earns.
  const {
    workspaceByNode, hydrateWorkspaces, clearWorkspaceStore, cancelAllAutoCompletes, pushArcs,
    onAddSubtask, onToggleSubtask, onEditSubtask, onDeleteSubtask, onSetNote, onAddLink, onDeleteLink,
  } = useWorkspace({ seedRef, sceneRef, completedRef, completeStepRef });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false); // the routed tree couldn't load (offline / gone)
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [inProgress, setInProgress] = useState(() => new Set());
  const [startedAt, setStartedAt] = useState(() => ({})); // { nodeId: ms } — when work began
  const [completedAt, setCompletedAt] = useState(() => ({})); // { nodeId: ms } — when it finished
  // paste append-mode (F3 §01): ⌘V on the editor opens the same composer to graft a plan
  // under the current selection. The draft text survives Esc; the draft legend seeds from
  // the live legend on open so headings reuse the tree's own kinds.
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  const [selectedId, commitSelectedId] = useState(null);
  // The selection is TWO sets — nodes (selectedIds) and edges (selectedEdges, keyed by endpoints).
  // selectedId / scene.selectedEdge are their size≤1 projections (null once the TOTAL exceeds one),
  // so single-node and single-edge selection stay byte-identical and only >1 total diverges: the
  // floating bar shows and both single chromes hide.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedEdges, setSelectedEdges] = useState(() => new Set());
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);
  const [autoFocusNameId, setAutoFocusNameId] = useState(null); // freshly created bud → StepPanel focuses its name field
  const [toast, setToast] = useState(null); // single status beat: { message, action, detail, key, leaving }
  const [toastWhyOpen, setToastWhyOpen] = useState(false); // a tend receipt's reasoning, revealed on tap

  // A Next-up tap selects on a delay (the 540ms glide). Anything that changes the
  // picture before it lands — a newer tap, a selection by other means, dismissing the
  // feed, a reload — bumps the epoch and strands the pending timer (X1). setSelectedId
  // is the cancelling wrapper every ordinary path calls; only the glide's own timeout
  // reaches commitSelectedId, after proving its captured epoch is still current.
  const nextUpSelectRef = useRef({ epoch: 0, timer: null });
  const cancelNextUpSelect = useCallback(() => {
    const pending = nextUpSelectRef.current;
    pending.epoch += 1;
    window.clearTimeout(pending.timer);
    pending.timer = null;
  }, []);
  // The two size≤1 projections are a pure function of the two selection sets: a lone node keeps its
  // StepPanel + affordances (selectedId), a lone edge keeps its EdgeChrome (scene.selectedEdge), and
  // any total above one hides both — only the floating bar and the GPU highlights remain. Every
  // selection entrance reconciles through here after computing the next sets, so the projections can
  // never drift from them. It drives the scene's edge projection through projectEdge (a pure setter),
  // NOT selectEdge — selectEdge's node-clear cascade reads lagging scene.selectedIds and would wipe a
  // still-selected edge when a node drops out of a mixed selection. projectEdge takes a plain {from,to}.
  const reconcileProjections = useCallback((nodeSet, edgeSet) => {
    const total = nodeSet.size + edgeSet.size;
    commitSelectedId(total === 1 && nodeSet.size === 1 ? [...nodeSet][0] : null);
    sceneRef.current?.projectEdge(total === 1 && edgeSet.size === 1 ? parseEdgeKey([...edgeSet][0]) : null);
  }, []);

  const setSelectedId = useCallback((id) => {
    cancelNextUpSelect();
    const nodes = id ? new Set([id]) : new Set();
    setSelectedIds(nodes);
    setSelectedEdges(new Set()); // a single node / empty select drops any edge selection (mutually exclusive)
    reconcileProjections(nodes, new Set());
  }, [cancelNextUpSelect, reconcileProjections]);

  // The multi-select entrances, each reconciling both projections off the sets they just computed.
  // Node gestures leave the edge set alone (so a node can join an edge selection); a non-additive
  // marquee replaces, clearing edges too. They read the live refs, since a gesture is never batched.
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

  // Shift-click a branch → toggle its key into the edge set (mirrors onSelectionToggle for nodes).
  const onEdgeToggle = useCallback((edge) => {
    cancelNextUpSelect();
    const key = edgeKey(edge.from, edge.to);
    const next = new Set(selectedEdgesRef.current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelectedEdges(next);
    reconcileProjections(selectedIdsRef.current, next);
  }, [cancelNextUpSelect, reconcileProjections]);

  // A plain (non-shift) branch click is a fresh single-edge selection: the scene already set its
  // selectedEdge (EdgeChrome) synchronously, so here we only drop any lingering node/edge multi-
  // selection — the lone edge lives in the scene, not these sets, exactly as it did before.
  const onEdgePick = useCallback(() => {
    cancelNextUpSelect();
    setSelectedIds(new Set());
    setSelectedEdges(new Set());
    commitSelectedId(null);
  }, [cancelNextUpSelect]);

  const [hasLocalEdits, setHasLocalEdits] = useState(false); // local edits overlaid on the authored seed
  const [reloadKey, setReloadKey] = useState(0); // bump to re-run the load pipeline (e.g. after reset)
  const [shareOpen, setShareOpen] = useState(false); // the Share dialog (link + the week's card)
  const [laneInset, setLaneInset] = useState(0); // px of the screen bottom the action lane occupies (it measures itself)
  const [shortcutsOpen, setShortcutsOpen] = useState(false); // the keyboard-shortcuts help overlay (editor only)
  const [treeVisibility, setTreeVisibility] = useState(null); // server stance on this tree: 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false); // is the signed-in caller this tree's owner
  const [forkOpen, setForkOpen] = useState(false); // the fork "door" (read-only — the page's one verb)
  const [panning, setPanning] = useState(false); // the scene is being panned; mobile chrome yields (§chrome)
  const [recenterAvailable, setRecenterAvailable] = useState(false); // the tree left the safe frame — offer Recenter
  const [aim, setAim] = useState(null); // connect aim mode (M3): { sourceId, direction: 'unlocks'|'needs' } | null
  const [removing, setRemoving] = useState(null); // the branch the remove-link bar targets (M3): { from, to } | null
  const [multiMode, setMultiMode] = useState(false); // phone multi-select (M5): the bulk bar replaces the sheet
  const [switcherOpen, setSwitcherOpen] = useState(false); // X8 L6: the list header's tree-switcher half-sheet
  const [switcherTrees, setSwitcherTrees] = useState(null); // trees fetched for that sheet (null = not yet loaded)
  const [view, setView] = useState(null); // X8 phone view: 'tree' | 'list' | null (undecided → today's tree view)
  const [sheetHeld, setSheetHeld] = useState(false); // list→tree flip carried a selection: hold the sheet down (ring only) until the next tap (F13)
  const [coachAllowed, setCoachAllowed] = useState(false); // the demo coach may mount — a stranger who hasn't seen it (F4 §03)
  const [demoCompletions, setDemoCompletions] = useState(0); // marks made this demo session — any one retires the coach
  const [ctaEcho, setCtaEcho] = useState(false); // the Fork CTA takes the pulse once, after the unlock toast (§04)

  // The three derivations every seam below reads — where the tree sits, what each step's state is,
  // and the score. They sit beside the state they derive from, and above the first hook that wants
  // them.
  //
  // Position is purely a projection of structure now (angular-reorder retired the free-pixel move,
  // §07): whenever the node/edge/order signature changes — a create, connect, delete, or reorder,
  // local or remote alike — the engine lays the whole tree out afresh, exactly as a page load
  // would. Content-only updates (rename, progress) reuse the cached layout so nothing else moves.
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

  // Single source of truth for node state — every completion ripples through here.
  const states = useMemo(() => {
    if (!tree) return new Map();
    return UnlockRules.derive(tree, { completed, inProgress });
  }, [tree, completed, inProgress]);

  // The share "score" — done/total + the dominant kind that tints the exported frame.
  const shareStats = useMemo(() => (tree ? ShareStats.from(tree, states) : null), [tree, states]);

  // Save the edited tree over its seed. Only the dogfood roadmap persists — the
  // huge perf tree is a throwaway. Every structural edit, undo/redo, and move
  // funnels here, so the browser always reloads the latest edit.
  // Structure durability now lives in the lattice (SyncSession persists it to IndexedDB), so
  // this no longer writes to TreeStore; kept as the seam syncStructure calls after a re-render.
  const persistEdits = useCallback(() => {}, []);

  // Durable progress: save the user's completions, in-progress steps, and the
  // timestamps of those actions so they survive a reload. Same dataset guard as
  // persistEdits — callers pass the freshly-computed next values, since state setters are async.
  const persistProgress = useCallback((next) => {
    if (demoRef.current) return; // the demo plays against an in-memory overlay — never localStorage (F4 invariant)
    if (!seedRef.current) return;
    progressStore.save(seedRef.current.id, next);
    // Advance the return-recap baseline as work lands: this device has now witnessed these
    // completions, so a same-session reload replays nothing — only steps finished elsewhere while
    // the tab was closed (a collaborator, or this account's MCP agent) are "new" on the next open.
    if (!readOnlyRef.current) returnLedger.save(seedRef.current.id, { completed: [...next.completed], at: Date.now() });
  }, []);

  // The single status beat (canonical §2): a toast enters fade+rise, holds, then
  // fades out. A newer call REPLACES the current one (never stacks); toasts that
  // carry an action (Undo) hold longer so there's time to act.
  const showToast = useCallback((message, options = {}) => {
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    const action = options.action ?? null;
    const hold = options.duration ?? (action ? 6000 : 4000);
    const key = (toastKeyRef.current += 1);
    setToastWhyOpen(false);  // a fresh toast starts with its reasoning collapsed
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

  // Everything that leaves this app — the unfurl card, the period's progress card, and the one
  // ask that offers it. The director owns the ledger, the pixels and the offer's timing; the view
  // owns the triggers, because they are the load's, the ceremony's and the milestone's to pull.
  const {
    publishOgImage, publishOgImageRef, weekSegment,
    forgetPeriod, openPeriod, considerWeekOffer, followCeremony, dropWeekOffer, clearShareLedger,
  } = useWeekOffer({
    treeId, tree, states, shareStats, layoutPositions, viewPrefs,
    completed, completedAt, completedRef,
    treeMine, shared, demo, demotion, demotedRef,
    showToast, setShareOpen,
  });

  // The scene's one toast sink — every ceremony's closing beat comes through here, which is what
  // makes it the seam the week's offer waits on.
  const speakCeremony = useCallback((message, options) => {
    showToast(message, options);
    followCeremony();
  }, [showToast, followCeremony]);

  // Tending (guidelines/tending.md): the agent lives in the tree. The bar appears only for a
  // signed-in owner of an editable tree on an ARMED server — a dark server never shows an input
  // that would only refuse (the summary's `enabled` is that gate). Its edits arrive live over the
  // same collab socket a person's do; each run finishes as a quiet face in the toast lane.
  const [tendingEnabled, setTendingEnabled] = useState(false);
  const [tendOpen, setTendOpen] = useState(false);  // desktop only: the ⌘K/`/`-summoned command bar
  useEffect(() => {
    if (!treeMine || status !== 'signed-in' || demo) { setTendingEnabled(false); return undefined; }
    let alive = true;
    fetchTending().then((summary) => { if (alive) setTendingEnabled(!!summary?.enabled); });
    return () => { alive = false; };
  }, [treeMine, status, demo, treeId]);

  const canTend = tendingEnabled && treeMine && !shared && !demo && !demotion;

  // One sentence = one undo (tending §4): revert a tend by tombstoning the steps it planted, in a
  // single BulkDelete down the ordinary command path — so it lands in history and is itself redoable.
  // Only the nodes the tend ADDED, never a pre-existing step; a modify-only tend has nothing to revert
  // here and simply carries no Undo (hand editing remains the way back for those).
  const undoTend = useCallback((planted) => {
    if (!planted.length) return;
    collabRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: planted, edges: [] });
    showToast('Tending reverted');
  }, [showToast]);

  const onTendFace = useCallback((face) => {
    setTendOpen(false);  // the desktop bar closes as its work lands; the receipt speaks in the toast lane
    if (face.kind === 'empty') return;  // a blank submit says nothing
    const isReceipt = face.kind === 'receipt';
    const hasUndo = isReceipt && face.created && face.created.length > 0;
    // The settle beat: once the last frames land + the layout eases, glide to frame the new work.
    if (hasUndo) window.setTimeout(() => sceneRef.current?.frameNodes(face.created), 600);
    showToast(face.line, {
      duration: isReceipt ? 6000 : 5000,
      detail: isReceipt ? face.detail : undefined,  // the "why", revealed on tap
      action: hasUndo ? { label: 'Undo', run: () => undoTend(face.created) } : undefined,
    });
  }, [showToast, undoTend]);

  const { working: tendWorking, submit: submitTend } = useTend({ treeId, onFace: onTendFace });

  // Desktop summons the bar deliberately — ⌘K anywhere, or `/` when the caret isn't already in a
  // field. Phone shows it ambiently instead, so this only arms on desktop.
  useEffect(() => {
    if (!canTend || breakpoint !== 'desktop') return undefined;
    const onKey = (event) => {
      // Escape closes the summoned bar even mid-run, when its input is unmounted and the form can't
      // catch the key itself. Only when it's actually open, so other Escape handlers keep theirs.
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

  // The scene reports pan start/stop (§chrome yields): mobile chrome fades while
  // panning, and the first pan means the tree has left the safe frame — offer Recenter.
  const handlePanStateChange = useCallback((isPanning) => {
    setPanning(isPanning);
    if (isPanning) setRecenterAvailable(true);
  }, []);

  // What has happened to this tree, and whether the dock is showing it — the log, `emit`, the
  // unread badge, the arrival flash and the ticker (activity/useActivity.js). The one seam the
  // rest of this file touches is `emit`: every edit that is worth remembering calls it.
  const {
    emit, seedActivity, ticker, newEventIds, pinned, unreadCount, activityPing,
    feedVisible, feedSummonedRef, activityGroups, selectedHistory, eventCount,
    toggleActivity, openActivity, closeActivity, togglePin,
  } = useActivity({ sceneRef, selectedIdRef, selectedId, cancelNextUpSelect, setSelectedId });

  // Discard local edits and reload the authored seed fresh (clears history too),
  // including the user's durable progress and its timestamps for this tree.
  const handleResetEdits = useCallback(() => {
    if (seedRef.current) {
      collabRef.current?.clearDurable?.();  // drop the durable lattice for this tree
      progressStore.clear(seedRef.current.id);
      clearWorkspaceStore(seedRef.current.id);
      clearLegendStore(seedRef.current.id);
      returnLedger.clear(seedRef.current.id); // the reset reload re-baselines the recap from the cleared progress
      milestoneLedger.clear(seedRef.current.id); // a reset tree can earn its milestones' share offers again
      clearShareLedger(seedRef.current.id); // and starts its share series over — no "since" against work that's gone
    }
    cancelAllAutoCompletes();
    setReloadKey((key) => key + 1);
  }, [clearLegendStore, clearWorkspaceStore, cancelAllAutoCompletes, clearShareLedger]);

  // Re-derive the whole render model from the editor's current TreeData and apply
  // it to the scene preserving the view. The seam every structural edit + undo/redo
  // funnels through; constructing a SkillTree here also re-validates the DAG.
  const syncStructure = useCallback(() => {
    const editor = editorRef.current;
    const sceneNow = sceneRef.current;
    if (!editor || !sceneNow) return;

    // A concurrent edit can leave the graph invalid (a cycle). Rather than freeze,
    // render the best-effort projection with the cycle edges dropped, and surface it.
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

  // The lattice changed — from a dispatched local gesture or a joined remote frame; both
  // land here. The projection becomes the editor's present, the scene re-renders through the
  // same seam, and the legend is re-derived from the lattice's kinds. One path for every
  // edit. If a concurrent edit left a cycle, syncStructure surfaces the loose projection.
  const onTreeChanged = useCallback((treeData) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.present = treeData;
    syncStructure();
    syncLegendFromTree(treeData);

    // "Keep more, lose less": when a concurrent delete raced a build, the work is kept but
    // masked under the tombstoned parent. Surface it once, with one-click resurrection.
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
  }, [syncStructure, showToast, syncLegendFromTree]);
  onTreeChangedRef.current = onTreeChanged;

  // The browser tab follows the tree's name; the switcher previews each keystroke of an
  // in-flight rename through the same format, so the tab is live while the field is.
  const pageTitle = tree?.title?.trim();
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} — Windmill` : 'Windmill';
    return () => { document.title = 'Windmill'; };
  }, [pageTitle]);
  const previewTreeTitle = useCallback((id, title) => {
    if (id !== treeId) return;
    document.title = `${title.trim() || 'Untitled roadmap'} — Windmill`;
  }, [treeId]);

  // A switcher rename committed. The open tree's title lives in its lattice — one stamped
  // register write that flushes, broadcasts, and persists like any field change (the device
  // index follows via the session's touch). Other rows route by their tag (anon-first-tree
  // F3): a local row renames the blob + device index and never PATCHes the server; a server
  // row goes through the registry, its promise escaping so the switcher can restore truth
  // when the server refuses.
  const handleRenameTree = useCallback((id, title, { local = false } = {}) => {
    if (id === treeId && collabRef.current?.renameTree(title)) return undefined;
    if (local) return renameLocalTree(id, title);
    return renameTree(id, title);
  }, [treeId]);

  // A switcher delete confirmed. Local rows never see the server — blob, per-tree stores,
  // and device index all clear here; server rows soft-delete server-side. When it was the
  // open tree, the session closes first — its pagehide flush would otherwise resurrect the
  // blob (the switcher navigates off it next).
  const handleDeleteTree = useCallback(async (id, { local = false } = {}) => {
    if (id === treeId) collabRef.current?.close();
    if (!local) await deleteTree(id);
    // Server rows hold device residue too — a touch()-born index entry, the blob, the
    // last-place slot. Clearing it all here is what keeps a deleted tree from zombieing
    // the switcher union or dead-ending the next magic-link landing.
    await deleteLocalTree(id);
  }, [treeId]);

  // Undo/redo is client-owned: the session replays a gesture's inverse as a fresh gesture,
  // which joins and broadcasts like any edit, so it stays in sync across collaborators.
  const undo = useCallback(() => collabRef.current?.undo(), []);
  const redo = useCallback(() => collabRef.current?.redo(), []);

  // The panel's name field committed (Enter/blur): one history step, and only
  // if the label actually changed.
  const handleRename = useCallback((id, label) => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return;
    const wasNamed = node.label.trim() !== ''; // naming a fresh bud is part of the add, not a rename
    collabRef.current?.dispatch({ kind: 'RenameNode', id, label });
    if (wasNamed) emit({ verb: 'renamed', nodeId: id, label, kind: node.color });
  }, [emit]);

  // Plus clicked: create + commit an unnamed bud (saved even unnamed), select it,
  // and flag the step panel to focus its name field so typing flows straight in.
  const handleCreateChild = useCallback((parentId) => {
    const scene = sceneRef.current;
    const editor = editorRef.current;
    const parent = scene?.nodesById.get(parentId);
    if (!parent || !editor) return;

    // Born in the parent's kind (same branch); the radial layout owns where it lands — a fresh
    // child appends after its last sibling (CreateNode seeds its order key) and the wedge re-splits.
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    collabRef.current?.dispatch({ kind: 'CreateNode', id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId });
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
    return id; // so a caller (the phone undo snackbar) can target this exact node
  }, [syncStructure, emit]);

  // The emptied tree's way back in (empty-state): plant a first root with no parent —
  // the same parent-less CreateNode localTrees seeds a birth with — then select it and
  // focus its name so typing names the step at once. Mirrors handleCreateChild, minus
  // the parent (no anchor to spread from, so the bud lands at the world origin).
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

  // Drag from a port to a node → add a dependency (one history step). The gesture
  // already blocked cycles before the drop.
  const handleConnect = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'AddEdge', from: sourceId, to: targetId });
  }, []);

  // Midpoint × on a branch → drop the edge (silent, one step; ⌘Z restores).
  const handleDeleteEdge = useCallback((sourceId, targetId) => {
    collabRef.current?.dispatch({ kind: 'RemoveEdge', from: sourceId, to: targetId });
  }, []);

  // Drag an edge endpoint to a new node → re-aim it in one undoable step. The
  // gesture already blocked cycles and dropping back on the original end.
  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    collabRef.current?.dispatch({ kind: 'ReconnectEdge', oldFrom, oldTo, newFrom, newTo });
  }, []);

  // Delete a node; its children splice up to the deleted node's parents (one
  // history step). The one destructive edit that earns a toast.
  const deleteNodeAt = useCallback((id) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    const node = editor.treeData.nodes.find((n) => n.id === id); // snapshot before it's gone
    // The DeleteNode gesture is atomic: the tombstone AND the children's splice-up to the
    // deleted node's parents ride one frame, so every peer converges on the same spliced tree.
    collabRef.current?.dispatch({ kind: 'DeleteNode', id });
    if (selectedIdRef.current === id) setSelectedId(null);
    showToast('Step deleted', { action: { label: 'Undo', run: undo } });
    emit({ verb: 'removed', nodeId: id, label: node?.label, kind: node?.color });
  }, [emit, showToast, undo]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  // Bulk delete the whole multi-selection in ONE undoable gesture (mirrors ImportSubgraph):
  // a single BulkDelete stamp tombstones every node and transitively splices orphaned children
  // up to live ground. Labels are snapshotted BEFORE dispatch — the projection drops the doomed
  // nodes synchronously — so the feed can name each removal; one summary toast carries the Undo.
  const bulkDelete = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    const edges = [...selectedEdgesRef.current].map(parseEdgeKey); // {from,to} — the shape BulkDelete's materialize case expects
    if (!ids.length && !edges.length) return;
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const doomed = ids.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    // One atomic gesture tombstones every node AND drops every explicitly-selected edge whose
    // endpoints both survive (materialize removeEdges those) — nodes + edges land in one undo.
    collabRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: ids, edges });
    for (const node of doomed) emit({ verb: 'removed', nodeId: node.id, label: node.label, kind: node.color });
    setMultiMode(false); // the deleted set is gone — leave the phone bulk bar (no-op on desktop)
    setSelectedId(null); // clears both sets and reconciles both projections (incl. scene.selectedEdge)
    const parts = [];
    if (ids.length) parts.push(`${ids.length} step${ids.length === 1 ? '' : 's'}`);
    if (edges.length) parts.push(`${edges.length} link${edges.length === 1 ? '' : 's'}`);
    showToast(`${parts.join(' and ')} deleted`, { action: { label: 'Undo', run: undo } });
  }, [emit, showToast, undo, setSelectedId]);

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeColor', id, color: kind });
  }, []);

  // The angular-reorder gesture (§07) asks, at drag start, for a node's same-parent siblings in
  // sort order with their order keys — the scene turns those into insertion angles and a new key.
  // A node's siblings are its trunk parent's trunk children (already sorted); a root's are the
  // other roots (sorted here to match the layout's root sweep). The dragged node stays in the list;
  // the scene filters it out. Returns null off-tree so a stale pick can't crash the gesture.
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

  // The finger's ⌘Z (M6): every phone edit drops a 4s undo snackbar, since a touch
  // surface has no keyboard undo. Each wrapper runs the same handle* the desktop editor
  // calls, then toasts with Undo → undo(). Delete keeps its own 6s toast (deleteNodeAt),
  // and Mark done carries its own completion ceremony — neither routes through here. A
  // fresh bud's first naming is part of the add, not a rename, so it stays silent.
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

  // The add's undo must remove THIS bud, not pop the stack: the bud auto-focuses its name
  // field, so naming it dispatches a RenameNode on top — a plain undo() would pop that rename
  // and leave the step. Target the created id directly (a fresh bud has no children to resplice).
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

  // The list's edit verbs (X8 L4). Each dispatches one gesture and drops the 4s undo snackbar,
  // the way the phone's tree-view edits do — but the list names the step BEFORE it exists and
  // connects through a picker, so these don't route through the sheet's autofocus-rename or aim.
  // Describe restores the prior text with a targeted DescribeNode (a stack pop could catch a
  // later edit); add tombstones exactly its new node; need removes exactly its new edge.
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

  // Connect aim mode (M3): the sheet's Connect verb folds the sheet into the aim bar and
  // turns the canvas into a target chooser. The source stays selected (its ring), and the
  // sheet returns when aim ends. One surface at a time — entering aim clears any remove bar.
  const enterAim = useCallback((sourceId) => {
    setRemoving(null);
    setAim({ sourceId, direction: 'unlocks' });
  }, []);

  const flipAimDirection = useCallback(() => {
    setAim((current) => (current ? { ...current, direction: current.direction === 'unlocks' ? 'needs' : 'unlocks' } : current));
  }, []);

  // Recolor the whole node selection to one legend kind's hue in ONE undoable gesture (mirrors
  // bulkDelete): a single BulkRecolor stamp repaints every selected node, and captureInverse
  // banks each node's prior color so one undo restores them all. The selection is KEPT so the
  // user can recolor again. Only nodes are touched (selectedIds); edges carry no color and
  // follow their source node's hue, repainting for free — a pure-edge selection never reaches here.
  // `silent` is the desktop power surface (brief #10): a recolor swatch commits with no toast — one
  // gesture, ⌘Z undoes it (the BulkRecolor stamp is on the history stack). The phone bulk bar keeps
  // its snackbar (touch has no keyboard undo), so it calls with silent left false.
  const bulkRecolor = useCallback((color, { silent = false } = {}) => {
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    collabRef.current?.dispatch({ kind: 'BulkRecolor', nodeIds: ids, color });
    if (!silent) showToast(`${ids.length} step${ids.length === 1 ? '' : 's'} recolored`, { action: { label: 'Undo', run: undo } });
  }, [showToast, undo]);

  // The composer's "Add to tree" (paste append-mode, F3 §01): the raw parse becomes a
  // graft under the current selection — the tree's root when nothing is selected, or when
  // the selection was deleted mid-compose. graftPlan shapes it (id-collision remap,
  // attach/dissolve, adds-only legend) and the whole subgraph rides ONE ImportSubgraph
  // gesture — one wire frame, one undo entry. onTreeChanged re-lays-out synchronously, so
  // the grafted nodes are already seated when we pulse them. Silent 'added' events let
  // history record the graft without N tickers; one summary toast speaks with an Undo.
  const graftImported = useCallback((parse) => {
    const editor = editorRef.current;
    const collab = collabRef.current;
    if (!editor || !collab) return;
    const nodes = editor.treeData.nodes;
    const selected = selectedIdRef.current;
    const anchored = selected && nodes.some((node) => node.id === selected);
    // Target: the selection, else a root (a prereq-less node). An empty or rootless tree has
    // neither — the graft then lands at root level (null target), so a paste into nothing
    // plants the tree rather than vanishing and stranding the composer.
    const targetId = (anchored ? selected : nodes.find((node) => node.prerequisites.length === 0)?.id) ?? null;

    const graft = graftPlan({
      parse,
      targetId,
      reservedNodeIds: collab.knownNodeIds(),  // present AND tombstoned — never resurrect a deleted node
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

  // Construct the scene once; React only ever drives it through the methods below.
  // Read-only omits every edit callback so no gesture can mutate the tree, and passes
  // `readOnly` so the scene suppresses its own affordances (X5 shared contract).
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
        setSheetHeld(false); // any canvas tap releases the F13 sheet hold
        if (id) { setSelectedId(id); return; }
        // Empty-canvas click: drop any selection — nodes or edges, single or multi — (the feed
        // returns iff it was open), or dismiss the feed itself when nothing was selected (design A″).
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) setSelectedId(null);
        else closeActivity();
      },
      onNodeHover: (id) => setHoveredId(id),
      onCeremonyToast: speakCeremony,
      ...editing,
    });
    // A quest plant left its one-shot note: this arrival announces a Quest, not a Roadmap.
    if (plantedQuestRef.current === null) plantedQuestRef.current = consumeSessionFlag(PLANTED_QUEST_KEY);
    if (plantedQuestRef.current) nextScene.setArrivalNoun('Quest');
    // A fork from the demo left its note (F4 §05): the fresh copy's re-plant toasts
    // "Forked — 17 steps planted" — now you're the actor (the demo suppress rides loadTree).
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

  // Keyboard: ⌘Z / ⇧⌘Z history, ⌫ / Delete removes the selection, Esc deselects.
  useEffect(() => {
    const onKey = (event) => {
      if (!readOnlyRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      // ⌘/Ctrl+A selects every node — but only over the canvas: a focused field keeps the
      // browser's select-all so text editing is untouched.
      if (!readOnlyRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        event.preventDefault();
        cancelNextUpSelect();
        const ids = editorRef.current?.treeData.nodes.map((n) => n.id) ?? [];
        const set = new Set(ids);
        setSelectedIds(set);
        setSelectedEdges(new Set()); // "select all steps" is nodes-only — drop any edge selection
        reconcileProjections(set, new Set());
        return;
      }
      if (event.key === 'Escape') {
        if (highlightedKindIdRef.current) { clearHighlightedKind(); return; }
        // Clear any multi-selection — nodes and/or edges — through one branch. setSelectedId(null)
        // empties both sets and reconciles both projections (incl. the scene's selectedEdge).
        if (selectedIdsRef.current.size > 0 || selectedEdgesRef.current.size > 0) { setSelectedId(null); return; }
        // A plain-clicked single edge lives only in the scene (empty React sets) — clear it here.
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
      // "?" (Shift+/) toggles the keyboard-shortcuts reference — a View affordance like "A",
      // so it works read-only too (the panel just shows less); guarded like ⌘A so it never
      // fires while typing in a field. Pressing "?" again closes it (the fourth close path
      // alongside the Dialog's own Esc / × / backdrop).
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
        // Above one selected item (nodes and/or edges) deletes as one BulkDelete gesture; a lone
        // node or lone edge keeps its byte-identical single path (its own toast + one history step).
        if (selectedIdsRef.current.size + selectedEdgesRef.current.size > 1) { event.preventDefault(); bulkDelete(); return; }
        if (selectedIdRef.current) { event.preventDefault(); deleteSelected(); return; }
        const edge = sceneRef.current?.selectedEdge; // a lone edge — the size-1 set's projection, or a plain-clicked one
        if (edge) {
          event.preventDefault();
          handleDeleteEdge(edge.from, edge.to);
          setSelectedEdges(new Set());         // clear the edge set (mirrors the lone-node setSelectedId(null) clear)
          sceneRef.current?.projectEdge(null); // …and the scene projection / EdgeChrome
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected, bulkDelete, handleDeleteEdge, toggleActivity, closeActivity, cancelNextUpSelect, setSelectedId, reconcileProjections, setShortcutsOpen, clearHighlightedKind]);

  // paste append-mode (F3 §01): raw ⌘V on the editor opens the composer already filled and
  // parsed, grafting under the current selection. Capture-phase, with three guards so it
  // never steals a legitimate paste — read-only/shared/demo trees don't graft, the
  // composer's own textarea pastes stay ordinary, and a paste while typing in any field
  // (a label, note, legend or switcher input) pastes normally. Canvas focus = activeElement
  // is the body/canvas, so a genuine canvas ⌘V falls through to the graft.
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

  // Mirror React's selection back to the scene so the canvas chrome (affordances,
  // highlight) tracks it however it cleared — Esc, the panel's close button, or a
  // canvas click. The scene guards a same-id call, so canvas-driven picks no-op here.
  // setSelectedSet runs last and does a full-array sweep, so it's the authority for the
  // GPU highlight; the affordance chrome follows selectedId (null above one, so it hides).
  useEffect(() => {
    sceneRef.current?.setSelection(selectedId);
    sceneRef.current?.setSelectedSet(selectedIds);
    sceneRef.current?.setSelectedEdges(selectedEdges); // the edge GPU highlight follows the whole set (one or many)
  }, [selectedId, selectedIds, selectedEdges]);

  // The last-place ledger (anon-first-tree F6): as the camera settles, remember where
  // this tree was left — the magic-link landing's fresh tab and bare #/app both re-open
  // it here. Editor views only.
  useEffect(() => {
    if (!scene || viewReadOnly) return undefined;
    let timer = null;
    const unsubscribe = scene.subscribeViewport(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!seedRef.current) return; // a tree that never loaded must not become the last place
        placeStore.save({ treeId, camera: scene.getViewpoint(), selectedId: selectedIdRef.current });
      }, 400);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [scene, treeId, viewReadOnly]);

  // Selection changes stamp the ledger too, so a new tab restores the open step.
  useEffect(() => {
    if (viewReadOnly || loading || !seedRef.current) return;
    placeStore.save({ treeId, camera: sceneRef.current?.getViewpoint?.() ?? null, selectedId });
  }, [selectedId, loading, treeId, viewReadOnly]);

  // The autofocus flag is for the bud's first appearance only — once the
  // selection moves elsewhere, re-selecting it later must not steal focus.
  useEffect(() => {
    if (autoFocusNameId && selectedId !== autoFocusNameId) setAutoFocusNameId(null);
  }, [selectedId, autoFocusNameId]);

  useEffect(() => () => toastTimersRef.current.forEach(clearTimeout), []);

  // The pipeline itself: repository loads → domain computes → scene renders.
  // Re-runs whenever the dataset toggle swaps demo ↔ huge.
  useEffect(() => {
    let cancelled = false;
    let autoOpenTimer = null;
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);
    setTreeVisibility(null); // the stance is unknown until the server answers — never claim a stale one
    setTreeMine(false);
    forgetPeriod();           // …and neither is the planting time: never count a new tree's weeks from an old one's
    repoRef.current = null;   // the outgoing tree's repository is not this one's; the reconcile waits for the new seed

    async function loadTree() {
      // The routed tree comes from the backend, per treeId — but the server is only the
      // first answer. A tree it doesn't know (local-born, or the server is unreachable)
      // projects from the durable lattice blob instead (anon-first-tree F2); loadError
      // means BOTH had nothing. The title baseline comes from the device index; a stamped
      // rename inside the blob dominates it on join.
      const repo = new HttpTreeRepository({ treeId });
      let seed = null;
      try { seed = await repo.loadTree(); } catch { /* fall through to the blob */ }
      if (!seed) {
        const saved = await syncStore.load(treeId).catch(() => null);
        if (!saved?.frame) throw new Error(`tree ${treeId}: unknown to the server and absent locally`);
        const lattice = new TreeLattice(treeId, deviceTrees.get(treeId)?.title ?? '');
        lattice.join(saved.frame);
        seed = lattice.toTreeData();
        // A device-born tree the server never saw is still THIS device's own — the blob path has no
        // server `mine` bit to carry, so stamp ownership from the device index. Without it an anon's
        // own planted quest loads treeMine=false and, on a phone, mobileEditable is false: the tree
        // is a read-only dead end with no verb rail and no fork (it's yours, so there's nothing to
        // fork). Ownership gates editing, not width (M0) — an anon owns this, so it must be editable.
        seed.mine = !!deviceTrees.get(treeId);
      }
      // The seed is only the first paint; the durable structure is the lattice — loaded
      // from IndexedDB (offline) and reconciled with the server on subscribe by the SyncSession.
      const treeData = seed;
      if (!cancelled) setHasLocalEdits(false);
      const nextTree = new SkillTree(treeData);
      // The demo plays against an in-memory overlay seeded to the staged 6/17 (F4 §01):
      // it never reads the server's progress nor the seed's authored statuses (which mark
      // rigging complete + tacking active — both wrong for the beat), and never merges
      // saved localStorage progress. Every visitor gets the same staged state; a reload
      // resets it, so the coached step is always ready.
      const progress = demo
        ? { completed: new Set(DEMO_STAGED_COMPLETED), inProgress: new Set(), server: false }
        : await repo.loadProgress(treeData);
      // The authoritative structural history from the op log — merged into the resting
      // feed below so a collaborator's edits show up, not just this browser's.
      const serverActivity = await repo.loadActivity({ limit: 200 });
      // Durable progress overlays the repo/seed baseline. When the server sent a real
      // account overlay, IT is the base truth: local marks it has no row for ride on top
      // (they're the reconcile's pending pushes), but server rows — including cleared
      // tombstones — win, so a mark cleared on another device dies here instead of being
      // resurrected. Without a server overlay (ghosts, fresh accounts), saved local
      // progress wins wholesale, exactly as before. The demo reads no saved progress.
      const savedProgress = demo ? null : progressStore.load(seed.id);
      if (savedProgress && progress.server) {
        const known = new Set([...progress.completed, ...progress.inProgress, ...(progress.cleared ?? [])]);
        for (const id of savedProgress.completed) if (!known.has(id)) progress.completed.add(id);
        for (const id of savedProgress.inProgress) if (!known.has(id)) progress.inProgress.add(id);
      } else if (savedProgress) {
        progress.completed = new Set(savedProgress.completed);
        progress.inProgress = new Set(savedProgress.inProgress);
      }
      const startedAtMap = savedProgress?.startedAt ?? {};
      const completedAtMap = savedProgress?.completedAt ?? {};
      const states = UnlockRules.derive(nextTree, progress);
      const positions = layoutPositions(nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
      // return-recap (P3): before the model installs, diff the steps completed since the
      // last visit (a pure set-diff — robust to completions made on other devices) and arm
      // the scene to replay them instead of the generic arrival. The demo and any view the
      // user can't edit (shared, mobile, or a non-owner demotion — readOnlyRef, not just
      // viewReadOnly) get neither a recap nor a ledger write: only the owner's editable tree.
      const priorLedger = demo || readOnlyRef.current ? null : returnLedger.load(seed.id);
      const sinceIds = ReturnLedger.since(progress.completed, priorLedger, states);
      if (sinceIds.length) {
        scene.armReturnRecap(sinceIds, `Welcome back · ${sinceIds.length} step${sinceIds.length > 1 ? 's' : ''} done since your last visit`);
      }
      scene.setModel(model);
      // The demo load replays the arrival with NO toast (F4 §01): visitors watch the tree
      // grow; toasts speak to actors. The bloom still plays — only its summary is muted.
      if (demo) scene.suppressArrivalToast();
      // The returning tab becomes the old place (anon-first-tree F6): when the last-place
      // ledger names this tree, its saved camera replaces the fit and its selection is
      // restored below. Editor views only — a share view never reads or writes the ledger.
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
      // Published beside the seed it loaded, so the reconcile can never read one tree's
      // server rows against another tree's local marks.
      repoRef.current = repo;
      openPeriod(seed.createdAt ?? 0); // the period clock: week N counts from here, never the calendar
      progressRef.current = progress;
      completedRef.current = new Set(progress.completed);
      inProgressRef.current = new Set(progress.inProgress);
      seedActivity({ tree: nextTree, states, serverActivity }); // this tree's own history, and a feed closed on it
      setTree(nextTree);
      setRenderModel(model);
      setTreeVisibility(seed.visibility ?? null); // the server's stance rides the seed; the blob fallback carries none
      setTreeMine(seed.mine ?? false);
      setCompleted(new Set(progress.completed));
      setInProgress(new Set(progress.inProgress));
      setStartedAt(startedAtMap);
      setCompletedAt(completedAtMap);
      hydrateWorkspaces(seed.id); // saved sub-tasks/notes/links for THIS tree; the arc feed reads them below
      hydrateLegend(seed.id, nextTree.nodes, seed.kinds ?? null); // the key for THIS tree, spotlight cleared
      pushArcs(); // seed the gauges from the hydrated workspaces (model is already applied)
      setBounds(scene.getBounds());
      if (restoredSelection) setSelectedId(restoredSelection);
      if (!viewReadOnly) placeStore.save({ treeId: seed.id, camera: scene.getViewpoint(), selectedId: restoredSelection });
      // Stamp this visit's completed set as the baseline the NEXT open diffs against (return-recap),
      // so the away-work just replayed is shown once, not on every later open. Demo and any
      // non-editable view never write — a visited tree isn't a returned-to one.
      if (!demo && !readOnlyRef.current) returnLedger.save(seed.id, { completed: [...progress.completed], at: Date.now() });
      setLoading(false);
      if (shared && seed.id === DEMO_TREE_ID) track('demo_open', { treeId: seed.id });

      // The return visit (whats-next-panel §04): stamp this open, and — first open in
      // ≥12h, ≥1 step ready, ≥12 steps, at most once a day, owner views only — summon
      // the dock after the fit-to-view camera stills. Focus never moves on auto-open;
      // closing it keeps it closed for the session (this fires once per load at most).
      // The daily budget burns via commit() only when the open actually fires (X6) —
      // a fire-time decline (selection, open feed, a mid-glide demotion) costs nothing.
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

      // The week's offer rides this open, if the period earned one: armed here, fired by whatever
      // ceremony closes the open, dropped outright if a milestone takes the lane (share/useWeekOffer.js).
      considerWeekOffer(seed, { completed: progress.completed, states, completedAt: completedAtMap });

      // Every edit runs through a SyncSession: the lattice is truth, TreeData its projection.
      // The roadmap goes live over the socket (a joined frame reaches every peer). Read-only
      // views (shares, small screens) never enter the device index — a visited tree is not a
      // borne one, and the claim path must never adopt it.
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
        .onProgress((frame) => applyRemoteProgressRef.current?.(frame))
        .onLive(() => reconcileProgressRef.current?.());
      collabRef.current = session;
      session.start();  // load durable lattice from IndexedDB, then connect
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
      dropWeekOffer();      // an offer armed for the tree we are leaving never speaks over the next one
      cancelNextUpSelect(); // unmount / reload strands any pending Next-up select (X1)
      collabRef.current?.close();
      collabRef.current = null;
    };
  }, [reloadKey, treeId, demo]);

  // The legend against the live nodes: each kind's count, and how many are worn (the
  // key appears at two). Recomputes as structure changes — a recolor/set-kind lands a
  // new tree, an add/rename a new legend — so counts and the mount gate stay honest.
  const legendWithCounts = useMemo(() => (tree ? withCounts(legend, tree.nodes) : []), [legend, tree, states]);
  const inUse = useMemo(() => (tree ? inUseCount(legend, tree.nodes) : 0), [legend, tree, states]);
  // The kinds the selection bar's recolor swatches offer — the tree's ordered legend, or the
  // raw palette before a legend is derived (same fallback the single-node picker uses).
  const recolorKinds = legend.length > 0 ? legend : NODE_COLOR_NAMES.map((hue) => ({ id: hue, hue }));

  // Push re-derived states to the scene whenever completion changes; the
  // scene owns the growth animation for newly-unlocked branches.
  useEffect(() => {
    sceneRef.current?.applyStates(states);
  }, [states]);

  useEffect(() => { completedRef.current = completed; }, [completed]);
  useEffect(() => { inProgressRef.current = inProgress; }, [inProgress]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { composerOpenRef.current = composerOpen; }, [composerOpen]);

  // The coach's eligibility (F4 §03): a stranger who hasn't seen it. The once-ever note
  // and the signed-out case resolve synchronously; a signed-in visitor is a stranger only
  // with no trees of their own — a tree-owner is never coached, so we wait on that check.
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

  // NEXT UP is ranked once per open and frozen in the ref — stable in-session,
  // re-ranked on the next summon, never reshuffled underfoot (whats-next-panel §03.2).
  // Computed synchronously on the opening render so the section never pops in late.
  // Rows whose live state drifts off their tier retire in place (X5), and the count
  // pill reads the live readyCount below — only the ranking itself stays frozen.
  const nextUpPlanRef = useRef(null);
  if (!feedVisible || !tree) nextUpPlanRef.current = null;
  else if (nextUpPlanRef.current === null) nextUpPlanRef.current = planNextUp(tree, states);
  const nextUpPlan = nextUpPlanRef.current;

  // The chip's standing offer: how many steps are ready right now, always live —
  // gated exactly like the section's mount rule (X3): a lone bud offers nothing.
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

  // The kind the whole multi-selection shares (M5), or null for a mixed set — the bulk bar's
  // recolor row rings it so a same-kind set reads its category, a mixed set rings nothing.
  const ringedKind = useMemo(
    () => sharedKind([...selectedIds].map((id) => nodesById.get(id)?.color ?? DEFAULT_NODE_COLOR)),
    [selectedIds, nodesById],
  );

  const handleRowHover = useCallback((id) => sceneRef.current?.spotlightNode(id), []);
  const handleRowLeave = useCallback(() => sceneRef.current?.spotlightNode(null), []);
  const handleRevealNode = useCallback((id) => sceneRef.current?.revealNode(id), []);

  // A Next-up tap commits (whats-next-panel §01): the camera flies, and near settle
  // the dock swaps to that step's workspace by selecting it. The delayed select proves
  // its tap epoch is still current before landing (X1), and the spotlight is cleared at
  // both ends — on the tap (the row unmounts, its mouseleave never fires) and again at
  // the swap, in case hover drifted across rows during the glide (X2).
  const handleNextUpOpen = useCallback((id) => {
    cancelNextUpSelect(); // a newer tap supersedes any pending one
    const pending = nextUpSelectRef.current;
    const epoch = pending.epoch;
    sceneRef.current?.spotlightNode(null);
    sceneRef.current?.revealNode(id);
    pending.timer = window.setTimeout(() => {
      pending.timer = null;
      if (pending.epoch !== epoch) return;
      sceneRef.current?.spotlightNode(null);
      commitSelectedId(id);
      setSelectedIds(new Set([id])); // the delayed single-select keeps the set projection in step
      setSelectedEdges(new Set());   // …and drops any edge selection (this is a node open)
      sceneRef.current?.selectEdge(null);
    }, NEXT_UP_SELECT_MS);
  }, [cancelNextUpSelect]);

  // "Add a step" (the all-done empty state) reuses the existing create affordance:
  // grow a bud from the tree's newest frontier leaf, selected with its name focused.
  const handleNextUpAddStep = useCallback(() => {
    const nodes = editorRef.current?.treeData.nodes ?? [];
    if (nodes.length === 0) return;
    const parents = new Set(nodes.flatMap((node) => node.prerequisites));
    const anchor = [...nodes].reverse().find((node) => !parents.has(node.id)) ?? nodes[nodes.length - 1];
    handleCreateChild(anchor.id);
  }, [handleCreateChild]);

  const selectedNode = selectedId ? nodesById.get(selectedId) ?? null : null;
  const selectedState = selectedId ? states.get(selectedId) ?? 'locked' : null;
  // The one node that gives up Delete and Mark done is the SINGLE root — a multi-root head or a
  // detached step keeps its verbs (the list ruled this in G8; the sheet must agree, not re-derive
  // rootness from parentlessness).
  const singleRootId = useMemo(() => {
    const roots = tree?.roots() ?? [];
    return roots.length === 1 ? roots[0].id : null;
  }, [tree]);

  // Each relation carries its kind + live state so the sheet's jump chips can wear the same
  // fruit treatment the list rows do — color and state alongside the label the panels read.
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

  // What completing this step opens up — the node's children, mirroring the
  // prerequisites shape. The read-only StepPanel shows these in place of editing.
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

  // A sheet jump chip (X8 L5.4): retarget the sheet to a related node in place and ease the
  // camera to it. The sheet stays open (it's keyed by node id, so the content swaps); the
  // reveal is the same glide the feed rows and the phone select-makes-room effect use.
  const handleSheetJump = useCallback((id) => {
    sceneRef.current?.revealNode(id);
    setSelectedId(id);
  }, [setSelectedId]);

  // Ownership gates editing, not a mode (M0): the owner's own tree stays editable on a
  // phone/tablet even though the view is read-only (the calm read-only scene never flips —
  // edits persist through the same live collabRef dispatch). A stranger's share, the demo,
  // and desktop (which has its full editor) are excluded. Wave B wires the phone's aim +
  // remove-link taps below; the sheet verbs are Wave A.
  const mobileEditable = treeMine && !shared && !demo && breakpoint !== 'desktop';

  // The phone's second view (X8): the list and the canvas render one model — the pill
  // flips between them, per tree, on this device only. The initial view is decided ONCE,
  // the moment the tree is ready (an owner comes back to work → list; a visitor lands on
  // the portrait → tree; an empty tree is always the bud canvas; a tree planted just now
  // opens on the canvas once, for its birth/arrival ceremony). Until then `view` is
  // null and we render today's tree view, so there's no flash and no double flip. The
  // whole surface is phone-only; tablet and desktop keep `view` null and stay untouched.
  const phone = breakpoint === 'phone';
  if (view === null && phone && tree) {
    const owner = treeMine && !shared && !demo && !demotion;
    setView(initialView({ saved: viewPrefs.lastView(treeId), owner, empty: tree.nodes.length === 0, born: peekBorn(treeId) }));
  }
  useEffect(() => {
    if (view !== null) clearBorn(treeId); // the stamp served its one open — a peek stays pure for StrictMode's double render
  }, [view, treeId]);
  const listReady = phone && !loading && !!tree && tree.nodes.length > 0; // the pill shows and the list can flip in
  const listActive = listReady && view === 'list';

  // Mount the list layer only once it's actually been shown (owner default counts), then keep it
  // mounted forever so its scroll survives every flip. A tree-first visitor never pays for it
  // until they tap the pill. The ref updates during render (synchronous, like `view` above), so
  // the layer is present on the same paint the list first activates — no blank frame.
  const listShownRef = useRef(false);
  if (listActive) listShownRef.current = true;
  const listMounted = listReady && listShownRef.current;

  // Flipping views is view state, never navigation: persist the choice, drop the tree view's
  // transient editing surfaces (aim / remove-link), and exit multi-select the way Done does —
  // mode AND sets — so the canvas grouped glow can't linger under the list (F7). A lone carried
  // selection is left alone: it rides across views. Flipping to the tree with a live selection
  // holds the sheet down until the next canvas tap, so the node wears its ring, not a popped
  // sheet (F13, X8 L1).
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

  // The tree-switcher door (X8 L6): the owner's list-header caret opens a half-sheet of their
  // trees. Load the registry each time it opens — cheap, and it keeps "updated 2h ago" honest.
  // The current tree is always merged in (mergeCurrent) so it shows and highlights even before
  // (or without) a fetch; onPick navigates via the hash, onPlant lands on the birth canvas.
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
    // The registry's row can trail the live tree (a device row carries no counts at all) — the
    // sheet is looking AT this tree, so its own line speaks from the live stats, not the index.
    return list.map((candidate) => (candidate.id === treeId ? { ...candidate, ...current } : candidate));
  }, [switcherTrees, treeId, tree, shareStats]);

  // Multi-select entered from the LIST (X8 L4): a long-press on a row arms the same multiMode
  // a canvas long-press does — first member held, sheet/aim/remove cleared, edges dropped — and
  // a tap on a check seat toggles membership, exiting when the last member leaves. These mirror
  // the canvas long-press/editTap branches so both doors reach one bulk surface.
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

  // Select makes room (X8 L0/L5): on the phone, opening a node's sheet in the tree view eases
  // the node up so it's never buried under the sheet — the same glide the jump chips use, one
  // seam whether the selection came from a canvas tap, a deep link, or a chip retarget. Skipped
  // while a bulk / aim / remove surface owns the screen, and off the list (which has no sheet).
  useEffect(() => {
    if (!phone || view === 'list' || !selectedId || multiMode || aim || removing) return;
    sceneRef.current?.revealNode(selectedId);
  }, [phone, view, selectedId, multiMode, aim, removing]);

  // Pause the WebGL scene while the list owns the screen (F6): stop() only cancels the RAF —
  // the camera and every GPU buffer survive, so start() resumes the exact frame. applyModel runs
  // fine while stopped (it mutates the batches synchronously and flags overlaysDirty), so a remote
  // edit arriving under the list applies and simply renders on the first frame after resume.
  useEffect(() => {
    if (!scene) return undefined;
    if (listActive) scene.stop(); else scene.start();
    return undefined;
  }, [scene, listActive]);

  // The lane lifts over whatever else owns the bottom edge (F2), mirroring the Recenter-above-Fork
  // rhythm: a peeking sheet in the tree view, or the Fork CTA on a shared/demotion page (either
  // view). Resting state only — dragging the sheet past its peek may cover it, which is fine.
  const sheetOpenNow = readOnly && phone && !!selectedNode && !aim && !removing && !multiMode && !sheetHeld && view !== 'list';
  const forkPresent = readOnly && (shared || !!demotion) && !demotion?.cardOpen;
  const laneLift = Math.max(
    0,
    sheetOpenNow ? (mobileEditable ? 300 : 216) + 12 - 16 : 0,
    forkPresent ? (18 + 50 + 12) - 16 : 0,
  );

  // The anon owner's honest "sign in to keep it" line is the list header's own notice row (F3) —
  // the plaque nudge's list-view home. Same door the tree-view plaque nudge opens.
  const listNotice = status === 'ghost' && treeMine && !demo ? (
    <button type="button" className="st-list-notice" onClick={openSignInDoor}>
      <span className="st-list-notice-text">Saved on this device — sign in to keep it</span>
      <span className="st-list-notice-chevron" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </span>
    </button>
  ) : null;

  // Route canvas taps by mode (M3): the scene stays read-only, but an owner editing on a
  // phone gets a ref-backed tap override so React owns the mode logic. Aiming turns the
  // canvas into a connect chooser (tap an eligible step to link, empty canvas cancels);
  // otherwise a node opens its sheet, a branch opens the remove-link bar, and empty clears.
  // A stranger's read-only share leaves editTap null, so the tool's default select is unchanged.
  useEffect(() => {
    if (!scene) return undefined;
    // Owner editing routes taps on phone AND tablet (Wave D stood the surfaces up in the tablet
    // panel, so a branch tap can no longer strand an invisible bar); the desktop keeps its own editor.
    if (!mobileEditable || breakpoint === 'desktop') { scene.setEditTap(null); return undefined; }
    scene.setEditTap((x, y) => {
      setSheetHeld(false); // any canvas tap releases the F13 sheet hold
      const nodeId = scene.pick(x, y);
      // Multi-select owns every tap while it's the surface (M5): a node toggles membership, and an
      // empty tap clears the set but keeps the mode (only Done / deselecting the last member exits).
      // Aim / remove never coexist with it, so those branches are skipped here.
      if (multiMode) {
        if (nodeId === null) { setSelectedIds(new Set()); reconcileProjections(new Set(), new Set()); return; }
        const next = new Set(selectedIdsRef.current);
        if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
        if (next.size === 0) setMultiMode(false); // toggled off the last member → leave multi-select
        setSelectedIds(next);
        reconcileProjections(next, selectedEdgesRef.current);
        return;
      }
      if (aim && tree && nodesById.has(aim.sourceId)) {
        if (nodeId === null) { setAim(null); return; } // empty canvas cancels the aim
        if (illegalTargets(tree, aim.sourceId, aim.direction).has(nodeId)) return; // illegal target: the tap is inert
        const { from, to } = edgeFor(aim.sourceId, nodeId, aim.direction);
        handleConnect(from, to);
        setAim(null);
        setSelectedId(aim.sourceId); // the source's sheet returns
        showToast('Linked', { action: { label: 'Undo', run: () => collabRef.current?.dispatch({ kind: 'RemoveEdge', from, to }) }, duration: 4000 });
        return;
      }
      if (nodeId) { setRemoving(null); setSelectedId(nodeId); return; } // open / retarget the editor sheet
      const edge = scene.pickEdge(x, y);
      if (edge) { setAim(null); setSelectedId(null); setRemoving({ from: edge.from, to: edge.to }); return; } // a branch → remove-link bar (never alongside aim)
      setSelectedId(null); // empty canvas clears the selection
    });
    return () => scene.setEditTap(null);
  }, [scene, mobileEditable, breakpoint, multiMode, aim, tree, nodesById, handleConnect, showToast, setSelectedId, reconcileProjections]);

  // Long-press → multi-select (M5): mirrors the editTap effect. Phone-owner only — a stranger's
  // read-only tree leaves setLongPress null, so a hold is inert. The held node is the first
  // member; entering clears any sheet (via the render gate), aim, and remove bar (one surface at
  // a time). The set drives the read-only highlight through the setSelectedSet sync effect.
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
      setSelectedEdges(new Set()); // links aren't multi-selectable on touch (M5) — start nodes-only
      reconcileProjections(next, new Set());
    });
    return () => scene.setLongPress(null);
  }, [scene, mobileEditable, breakpoint, reconcileProjections]);

  // Aim doesn't outlive its source: a concurrent peer deleting the aimed step leaves `aim`
  // dangling, which would strand a labelless aim bar (and, with a branch tap, stack a second
  // bar). Exit aim the moment its source leaves the tree. The fade effect already self-clears.
  useEffect(() => {
    if (aim && tree && !nodesById.has(aim.sourceId)) setAim(null);
  }, [aim, tree, nodesById]);

  // Aim mode's canvas chooser (M3): dim the illegal targets so only eligible steps stay
  // bright; the source keeps its selection ring. Recomputes when the direction flips, and
  // clears the dim the instant aim ends — this effect is the sole owner of the fade during
  // aim, so the tap handlers only ever flip `aim`.
  useEffect(() => {
    if (!scene || !aim || !tree || !nodesById.has(aim.sourceId)) return undefined;
    const illegal = illegalTargets(tree, aim.sourceId, aim.direction);
    illegal.delete(aim.sourceId); // the source keeps its selection ring — never dim the anchor
    scene.setFaded(illegal);
    return () => scene.clearFaded();
  }, [scene, aim, tree, nodesById]);

  // The wire half of a mark (progress-wire): signed-in sessions mirror each local mark to
  // the server over the socket; ghosts stay localStorage-only. Offline sends no-op — the
  // reconciliation below carries those marks up on the next graft.
  function pushProgress(nodeId, wireStatus) {
    if (demoRef.current) return; // BEFORE the signed-in gate: a signed-in visitor never writes the demo tree's progress (F4 invariant)
    if (status !== 'signed-in') return;
    collabRef.current?.sendProgress(nodeId, wireStatus);
  }

  // Begin work on a step: mark it in-progress and stamp its start (once). The kindle
  // beat is deliberately quiet — the emit is silent (log only, no pulse/ticker) and the
  // scene plays the kindle off the states recompute, so we never double-announce it.
  function handleStart() {
    if (!selectedId) return;
    const node = nodesById.get(selectedId);
    const nextInProgress = new Set(inProgress).add(selectedId);
    const nextStartedAt = startedAt[selectedId] ? startedAt : { ...startedAt, [selectedId]: Date.now() };
    setInProgress(nextInProgress);
    setStartedAt(nextStartedAt);
    persistProgress({ completed, inProgress: nextInProgress, startedAt: nextStartedAt, completedAt });
    pushProgress(selectedId, 'active');
    emit({ verb: 'started', nodeId: selectedId, label: node?.label, kind: node?.color }, { silent: true });
  }

  // The share-on-unlock offer (milestone-share-beat / ceremony-moments canon): when a completion
  // finishes a whole BRANCH (a root-child's subtree) or the CROWN (the whole tree), the ceremony's
  // own toast gains a "Share the moment" action that opens the share sheet with the card
  // pre-rendered. Owner-only, never on read-only surfaces, once ever per milestone (the ledger
  // survives reloads and an undo/re-complete). Returns the milestone's toast copy + action, or null.
  function milestoneOffer(prevCompleted, nextCompleted) {
    // Owner editing this tree, on ANY device — gate on the genuine read-only signals (a shared/
    // demo VIEW, or a visitor demotion), NOT the width-derived readOnly: a phone owner is fully
    // editable and is exactly who shares, so the offer must reach them.
    if (!treeMine || shared || demo || demotion || !tree) return null;
    const fresh = detectMilestones(tree, prevCompleted, nextCompleted)
      .filter((milestone) => !milestoneLedger.has(treeId, milestone.id));
    const announcement = milestoneAnnouncement(fresh);
    if (!announcement) return null;
    // Every fresh milestone is marked offered (a diamond step can finish two at once) so none re-offers.
    for (const milestone of fresh) milestoneLedger.markOffered(treeId, milestone.id);
    dropWeekOffer(); // one pride moment per open: the milestone takes the lane, the week's ask is dropped
    return {
      summary: announcement.summary,
      action: { label: announcement.label, run: () => { publishOgImageRef.current?.(); setShareOpen(true); } },
    };
  }

  // The shared completion path the button and the chip menu both take, so they can't
  // drift: mark complete, stamp completedAt (keep any startedAt), persist, then run the
  // ceremony — record the beat + its unlocks in the log and hand the scene the summary.
  function completeStep(id, { fromRemote = false } = {}) {
    const node = nodesById.get(id);
    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, [id], 'complete', Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setCompletedAt(next.completedAt);
    persistProgress(next);
    if (!fromRemote) pushProgress(id, 'complete');
    // Record every beat in the log (the feed still tells the full story), but keep
    // them off the ticker — one summary toast closes the ceremony instead.
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
    // The summary is the ceremony's closing beat: hand it to the scene, which speaks
    // it once the bloom/travel/pulse have settled (§2 toast — last), not up front. In the
    // demo, completing the coached step speaks the canon unlock line (F4 §04) verbatim.
    const label = node?.label?.trim() || 'Step';
    const stepSummary = demo && id === COACHED_NODE_ID
      ? DEMO_COPY.unlockToast
      : (opened > 0 ? `Step completed: ${label} · ${opened} more opened` : `Step completed: ${label}`);
    // A milestone (whole branch or the crown) replaces the step line with its own copy and carries
    // the share offer; an ordinary step keeps the plain summary and no action. The week's offer is
    // never raised here — it belongs to the open, not to a completion (canon C7: never mid-session)
    // — and a milestone landing in that same window drops it outright rather than queueing it.
    // Only YOUR own completion offers anything: one finished on another device (fromRemote) is the
    // welcome-back recap's moment, not a live "share it" toast.
    const offer = fromRemote ? null : milestoneOffer(completed, next.completed);
    const ceremony = offer ? offer.summary : stepSummary;
    const ceremonyOptions = offer ? { action: offer.action } : {};
    // Ceremony plays where you are (X8): the scene is paused under the list, so its director can't
    // speak the summary — in the list, the fruits flipping in place + this toast ARE the ceremony.
    // The canvas path is untouched: the director still speaks it after the bloom/travel settle.
    if (listActive) showToast(ceremony, ceremonyOptions);
    else sceneRef.current?.announceCeremony(ceremony, ceremonyOptions);

    if (demo) {
      setDemoCompletions((count) => count + 1); // any completion retires the coach (§03)
      // The handoff (§04): +120ms after the unlock toast settles, the Fork CTA takes the
      // pulse waveform once — skipped under reduced motion, where the toast carries the invite.
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (id === COACHED_NODE_ID && !reduced) {
        setTimeout(() => { setCtaEcho(true); setTimeout(() => setCtaEcho(false), 2600); }, CTA_ECHO_DELAY);
      }
    }
  }

  completeStepRef.current = completeStep; // the auto-complete timer fires the freshest one

  // Mark the whole node selection complete in ONE gesture (brief #10, "Mark all done"). completeStep
  // can't be looped — each call reads the same render-time `completed`, so only the last would stick —
  // so this unions the members that aren't already complete (markDoneTargets) into one setState, then
  // runs the same feed beats. Silent: no toast (the applyStates effect blooms the set; only bulk delete
  // toasts), and the selection is KEPT so the bark rings stay and the user can act again.
  function bulkMarkDone() {
    const targets = markDoneTargets(selectedIdsRef.current, completed);
    if (!targets.length) return;
    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, targets, 'complete', Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setCompletedAt(next.completedAt);
    persistProgress(next);
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
    // "Mark all done" stays silent for ordinary steps (the applyStates effect blooms the set), but
    // a milestone it finishes still speaks — that one is a moment, and marking a handful of steps
    // at once is exactly how a branch gets closed.
    const offer = milestoneOffer(completed, next.completed);
    if (offer) sceneRef.current?.announceCeremony(offer.summary, { action: offer.action });
  }

  function handleMarkComplete() {
    if (selectedId) completeStep(selectedId);
  }

  // The chip menu's correction path: set a step to any of the three states directly.
  // Complete reuses completeStep (bloom + ceremony); backward moves are silent — the
  // scene dims them off the states recompute, and the menu itself is the reversibility.
  function handleSetState(id, target, { fromRemote = false } = {}) {
    if (!id) return;
    if (target === 'complete') { completeStep(id, { fromRemote }); return; }

    const next = advanceProgress({ completed, inProgress, startedAt, completedAt }, [id], target, Date.now());
    setCompleted(next.completed);
    setInProgress(next.inProgress);
    setStartedAt(next.startedAt);
    setCompletedAt(next.completedAt);
    persistProgress(next);
    if (!fromRemote) pushProgress(id, target === 'notstarted' ? 'none' : 'active');
  }

  // A remote progress frame — this account's own change from another session or an MCP edit —
  // reflected live through the same apply path a local mark takes. Idempotent: skip when the node
  // already holds that state so an echo doesn't replay the completion ceremony.
  applyRemoteProgressRef.current = (frame) => {
    if (demoRef.current) return; // the demo overlay is session-local, sealed inbound too — no wire frame touches it
    const id = frame?.nodeId;
    if (!id || !nodesById.has(id)) return;
    const target = frame.status === 'complete' ? 'complete'
      : frame.status === 'active' ? 'inprogress'
      : frame.status === 'none' ? 'notstarted' : null;
    if (!target) return;
    if (target === 'complete' && completed.has(id)) return;
    if (target === 'inprogress' && inProgress.has(id)) return;
    if (target === 'notstarted' && !completed.has(id) && !inProgress.has(id)) return;
    handleSetState(id, target, { fromRemote: true }); // the server already knows — don't echo it back
  };

  // Reconciliation (progress-wire, anti-clobber): after each subscribe graft, read the server's
  // own overlay and push only the local marks it holds no row for — absent from all three sets
  // (completed, in-progress and the cleared tombstones) means the server never heard of the mark
  // at all (made offline or before sign-in), so it is safe to send. A mark the server knows
  // anything about is never re-pushed; the LWW row there stands.
  reconcileProgressRef.current = async () => {
    // Read-only views never write: a signed-in visitor on someone's share page would
    // otherwise push the tree's authored seed marks into their own overlay just by looking.
    if (status !== 'signed-in' || readOnly || !seedRef.current || !repoRef.current) return;
    const server = await repoRef.current.loadServerProgress();
    if (!server) return; // the socket outlived the read or vice versa — the next graft reconciles
    const known = new Set([...server.completed, ...server.inProgress, ...server.cleared]);
    for (const id of completedRef.current) {
      if (!known.has(id)) collabRef.current?.sendProgress(id, 'complete');
    }
    for (const id of inProgressRef.current) {
      if (!known.has(id)) collabRef.current?.sendProgress(id, 'active');
    }
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

  // Recenter (read-only chrome): frame the whole tree and clear the "left the safe
  // frame" flag, so the chip retires until the next pan.
  function handleRecenter() {
    handleFitToView();
    setRecenterAvailable(false);
  }

  function handlePanTo(x, y) {
    sceneRef.current?.panTo(x, y);
  }

  // The paste composer, append mode (F3 §01): parsed live off the draft against the tree's
  // own legend, with bindOnly so an unmatched heading mints a fresh hue rather than
  // renaming an existing kind. It takes the top-priority dock seat while open — the
  // selection persists underneath as the graft target. Editor-only, so desktop-only (the
  // read-only guard on the ⌘V door already keeps it off shares, demos and small screens).
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

  // The selected step, rendered read-only: no editing controls, but its unlocks,
  // prerequisites and history. Shared by the phone sheet and the tablet/desktop panel.
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

  // Which of the four owner-editing surfaces is live (M7): the tablet panel reads the same
  // one-at-a-time precedence the phone docks to the bottom edge, then seats the winner in the
  // panel column and keys its cross-fade on the result (the editor keys on the node, so a
  // retarget remounts). A stranger's share leaves mobileEditable false → the read-only detail.
  const mobileSurface = activeSurface({ multiMode, aim, removing, selectedNode });

  // The action lane's three tenants (X8 §5). None of them depends on which view is live, so
  // flipping the pill moves nothing on the rail; the Tend bar yields the centre to any open
  // editing surface (you're editing one node, not telling the whole tree), and Share stands
  // for as long as there is a tree to share.
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

      {/* The way back in when the last step is deleted: an editable tree with no nodes
          strands the user on a blank canvas (the "+" lives on existing nodes). A calm
          centered card plants a first root through the same create path, selected with
          its name focused — mirroring the birth canvas, minus the naming ceremony. */}
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

      {/* X8 — the phone list layer. It sits over the still-mounted canvas (the scene keeps
          its camera) and cross-fades in and out; once shown it stays mounted so its scroll
          survives every flip. Owner edits in place (editable + handlers); a visitor gets neither. */}
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

      {/* The action lane (X8 §5) — the one band verbs live in below the desktop breakpoint, because
          the top of a scrolling list can't be reached by a thumb. The view pill takes the left slot
          (phone-only, hidden while the tree is empty or loading), the Tend bar the centre, and Share
          the right: the owner's standing share door, the twin of a visitor's Fork pill, and the one
          the week-card offer needs to exist before it may retire (§10, og-progress-card.md). The
          lane measures what it occupies and the list pads its scroller by that. */}
      {(lanePill || laneTend || laneShare) && (
        <ActionLane lift={laneLift} onHeight={setLaneInset} left={lanePill} center={laneTend} right={laneShare} />
      )}

      {/* The tree-switcher door (X8 L6): the list header's caret opens this half-sheet of the
          owner's trees. Mounted only for the list's owner (a visitor header is a plain label);
          it portals to the root and animates on `open`. onPick navigates the hash; onPlant
          lands on the birth canvas. */}
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

      {/* The Tend bar, desktop: summoned to centre with ⌘K / `/` over a soft scrim. Below the
          desktop breakpoint it is the action lane's centre tenant (assembled above). Both only for
          an owner of an armed, editable tree; the prompt reads "build" on an empty tree, "change"
          once it has steps. */}
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

      {/* The device line (X6). Honest, not nagging: an owned tree with no account lives only on
          this device. A lapsed session says so with "signed out"; a never-signed-in anon just
          needs the fact. The DOOR is the account seat in the shell's head above this room — this
          canvas drew a second seat of its own here until 2026-08-07, from before /app existed,
          and two seats on one screen is not an offer, it is a bug. It sits a row below the control
          cluster so it never collides with it, and below the detail panel's z so an open panel
          covers it just like it covers the control bar (z 20 < chip 24 < panel 25). */}
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

      {/* The color key (F6): the legend is the editor. It mounts once two hues are in
          use, or when the picker's "+" forces it open on a still-one-kind tree. Screen-
          space, bottom-left, lifted clear of the minimap in that same corner. Read-only
          drops the edit callbacks, so KindLegend renders as a plain key. */}
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
          {/* One dock, now three tenants: the paste composer takes the top seat while open
              (append mode, F3) with the selection persisting underneath as the graft target;
              otherwise the feed is summoned over the canvas edge, and selecting a fruit
              swaps in its details. The key toggle replays the swap on every change. */}
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
          {/* The owner's own tree grows the verb rail (M1); a stranger's share keeps the
              read-only detail. Keyed by node id so a retarget swaps content cleanly (and a
              freshly-added bud remounts with its name field focused, M2). */}
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

      {/* Aim mode + remove-link chrome (M3) and the multi-select bulk bar (M5): each stands in
          for the sheet — one surface at a time — and the undo snackbar floats above any of them.
          Owner-gated: a stranger's read-only tap never reaches them (editTap/longPress stay null). */}
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

      {/* The bulk bar docks over BOTH views (X8 L4): multi-select can be entered from the canvas
          (long-press) or the list (long-press a row), so — unlike the aim/remove bars, which are
          tree-view-only gestures — it must not be gated off the list. */}
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

      {/* The tablet stands the sheet up (M7): the owner's editing surfaces render in the same
          320px right-side panel the read-only page uses, one at a time, with the aim/remove/bulk
          bars docked in-flow (`inPanel`) into the column instead of the bottom edge. A stranger's
          share (or a read-only desktop view) keeps the read-only detail below, byte-unchanged. */}
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

      {/* The visitor's honesty chrome: the notice card first, then — dismissed ≠
          forgotten — the read-only chip persists; the Fork pill stays one click away. */}
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

      {/* The coach (F4 §02) — the one temporary element the demo adds: it points at the
          single ready step, once ever per human, and retires on ✕/Esc/any completion/fork. */}
      {demo && coachAllowed && scene && view !== 'list' && (
        <CoachChip
          scene={scene}
          nodeId={COACHED_NODE_ID}
          onMarkDone={() => completeStep(COACHED_NODE_ID)}
          completionCount={demoCompletions}
        />
      )}

      {/* Multi-select action card (brief #10 — not a dock tenant): a light, persistent card that
          replaces the single StepPanel while a set is live (>=2 nodes and/or edges), bottom-centre
          over the canvas in the toast lane, above the ControlBar. Count anchors LEFT; recolor swatches,
          Mark all done, and the brick Delete cluster grow leftward from the far RIGHT (muscle memory).
          A lone node or edge keeps its own single chrome (StepPanel / EdgeChrome). */}
      {!readOnly && selectedIds.size + selectedEdges.size > 1 && (
        <div className="st-selection-bar" role="status">
          <span className="st-selection-count">{selectedIds.size + selectedEdges.size} selected</span>
          {/* Recolor the node part of the selection to any legend kind — the same round Kind swatches
              as the single-node picker (StepPanel). Hover previews the whole set live; click commits
              silent + ⌘Z. The shared kind rings (a mixed-kind set rings nothing). Nodes only: hidden
              when the selection is edges alone, since edges carry no colour of their own. */}
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
          {/* Mark all done (brief #10 — set-status): complete every selected step in one gesture,
              silent + the set is kept. Nodes only (edges carry no progress). */}
          {selectedIds.size > 0 && (
            <button type="button" className="st-selection-done" onClick={bulkMarkDone}>Mark all done</button>
          )}
          {/* Delete — the one brick control, pinned far right. Hover dims the set as a cost preview;
              click resplices orphaned children up and drops one "N deleted · Undo" toast (one history). */}
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
                  // Reading the why cancels the auto-dismiss, so the toast waits while you read.
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
