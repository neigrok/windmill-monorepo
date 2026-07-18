// Skill-tree view — runs the pipeline (repository → domain → layout → scene)
// and hosts the overlay UI around the GPU canvas: top controls, the docked
// step panel, and a minimap. No business logic lives here — every node
// state comes from UnlockRules.derive; this file only wires data through.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ControlBar } from './ui/ControlBar.jsx';
import { TreeSwitcher } from './ui/TreeSwitcher.jsx';
import { StepPanel } from './ui/StepPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { useViewMode } from './ui/useViewMode.js';
import { StatusChip, VisitorNotice } from './ui/HonestyChrome.jsx';
import { MobileChrome } from './ui/mobile/MobileChrome.jsx';
import { BottomSheet } from './ui/mobile/BottomSheet.jsx';
import { ForkDoor } from './ui/mobile/ForkDoor.jsx';
import { useAuth } from './auth/AuthProvider.jsx';
import { AccountSeat } from './auth/AccountSeat.jsx';
import { SignInDialog } from './auth/SignInDialog.jsx';
import { requestMagicLink } from './auth/AuthClient.js';
import { ShareDialog } from './share/ShareDialog.jsx';
import { ShareStats } from './share/ShareStats.js';
import { ActivityFeed } from './activity/ActivityFeed.jsx';
import { NextUp, planNextUp, considerAutoOpen } from './ui/NextUp.jsx';
import { ActivityLog, ActivityEvent } from './activity/ActivityLog.js';
import { ActorAvatar, EventSentence } from './activity/grammar.jsx';
import { SkillTree } from './model/SkillTree.js';
import { makeRenderable } from './model/renderableGraph.js';
import { UnlockRules } from './model/UnlockRules.js';
import { RadialLayoutEngine } from './layout/RadialLayoutEngine.js';
import { applyNudges } from './layout/applyNudges.js';
import { HttpTreeRepository } from './persistence/HttpTreeRepository.js';
import { API_BASE } from './apiBase.js';
import { listAllTrees, renameTree, deleteTree } from './persistence/TreeRegistry.js';
import { SyncSession } from './sync/SyncSession.js';
import { SyncStore } from './sync/SyncStore.js';
import { TreeLattice } from './sync/lattice.js';
import { claimLocalTrees } from './sync/claimLocalTrees.js';
import { renameLocalTree, deleteLocalTree } from './sync/localTrees.js';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { ProgressStore } from './persistence/ProgressStore.js';
import { WorkspaceStore } from './persistence/WorkspaceStore.js';
import { LegendStore } from './persistence/LegendStore.js';
import { LocalTreeRegistry } from './persistence/LocalTreeRegistry.js';
import { PlaceStore } from './persistence/PlaceStore.js';
import { emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask, setNote, addLink, deleteLink } from './model/NodeWorkspace.js';
import { deriveLegend, withCounts, inUseCount, freeHue, addKind, recolorKind } from './model/Legend.js';
import { KindLegend } from '../components/tree/KindLegend.jsx';
import { PasteComposer } from './paste/PasteComposer.jsx';
import { parsePlan } from './paste/planGrammar.js';
import { graftPlan } from './paste/graftPlan.js';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { NODE_SIZE } from './theme.js';
import { track } from '../telemetry/beacon.js';
import { CoachChip } from './demo/CoachChip.jsx';
import { DEMO_TREE_ID, DEMO_STAGED_COMPLETED, COACHED_NODE_ID, COACH_DONE_KEY, FORKED_FROM_DEMO_KEY, DEMO_COPY, coachEligible } from './demo/demoStage.js';

const layoutEngine = new RadialLayoutEngine();
const progressStore = new ProgressStore();
const workspaceStore = new WorkspaceStore();
const legendStore = new LegendStore();
const syncStore = new SyncStore();
const deviceTrees = new LocalTreeRegistry();
const placeStore = new PlaceStore();
const AUTO_COMPLETE_HOLD = 600; // held breath before auto-completing: arc-close 280 + hold 320 (§4)
const NEXT_UP_SELECT_MS = 540; // ~90% of the camera's default 600ms glide — the dock swaps as the fly settles
const NEXT_UP_ENTER_MS = 600; // auto-open waits for the fit-to-view camera to still (whats-next-panel §04)
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const CHILD_DROP = NODE_SIZE * 2.6; // world units a new child spawns below its parent
const SIBLING_GAP = NODE_SIZE * 1.8; // horizontal spread between successive new children
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

export function SkillTreeView({ treeId, demo = false, openSignInSignal = 0 }) {
  const { breakpoint, readOnly: viewReadOnly, shared } = useViewMode();
  const { user, status, signOut, refresh } = useAuth(); // the account seat's source of truth (X6)

  // The honesty split (share-hardening): an owner's lapsed sign-in never downgrades —
  // saves stay on this device and only the chrome tells the truth (lapsed). A visitor
  // on a tree that isn't theirs gets the true downgrade (demotion) into read-only.
  const [lapsed, setLapsed] = useState(false); // owner lapse: chip persists until re-auth
  const [demotion, setDemotion] = useState(null); // visitor downgrade: { edits, cardOpen } | null
  const [claimBusy, setClaimBusy] = useState(false); // a narrated claim run is in flight (the seat chip holds gold)
  const readOnly = viewReadOnly || !!demotion;

  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const readOnlyRef = useRef(readOnly); // the scene is built once; it reads the fresh mode without a rebuild
  const progressRef = useRef({ completed: new Set(), inProgress: new Set() });
  const editorRef = useRef(null);
  const layoutCacheRef = useRef({ signature: '', raw: new Map() });
  const completedRef = useRef(new Set());
  const inProgressRef = useRef(new Set());
  const logRef = useRef(new ActivityLog());
  const feedOpenRef = useRef(false); // mirrors feedOpen for emit's synchronous "is the feed being watched?" check
  const pinnedRef = useRef(false);
  const unseenIdsRef = useRef(new Set()); // events that arrived while the feed wasn't visible
  const seedRef = useRef(null); // the authored seed for the current tree (persistence baseline)
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
  // mid-claim loses nothing, the next trigger re-runs the sequence. Only a live
  // ghost→signed-in flip narrates (the seat chip, F5); boot resumes stay silent.
  const kickClaim = useCallback((narrated) => {
    if (claimRunRef.current) return;
    claimRunRef.current = true;
    if (narrated) setClaimBusy(true);
    claimLocalTrees({ openTreeId: treeId, openSession: () => collabRef.current })
      .then((result) => { if (narrated) setClaimBusy(result.claimed < result.pending ? 'incomplete' : false); })
      .catch(() => { if (narrated) setClaimBusy('incomplete'); })
      .finally(() => { claimRunRef.current = false; });
  }, [treeId]);

  // A tab born signed-in — the magic-link landing's fresh tab, or a reload that lost a
  // mid-flight claim — still resumes whatever the device index holds unclaimed.
  useEffect(() => {
    if (prevAuthRef.current === 'signed-in') kickClaim(false);
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
      kickClaim(false); // silent resume of unfinished claims (anon-first-tree F4 boot trigger)
      return;
    }
    if (prev === 'ghost' && status === 'signed-in') {
      collabRef.current?.forceReconnect();
      kickClaim(true); // the live claim — the seat chip narrates while it runs
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
      if (event.detail === 'this tree belongs to another account') {
        if (demotedRef.current || waiting) return;
        lastActivityAt = Date.now(); // the rejected gesture itself counts as activity
        demote();
        return;
      }
      // 'sign in to edit' / 'sign in to track progress' — suspicion, not verdict: re-check
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
  const toastTimersRef = useRef([]); // pending hold→leave→unmount timers for the active toast
  const toastKeyRef = useRef(0); // monotonic key so a replacing toast remounts and re-enters
  const workspaceByNodeRef = useRef({}); // nodeId → workspace; the fresh read for arc pushes + persistence
  const pendingCompleteRef = useRef(new Map()); // nodeId → auto-complete timer awaiting its held breath
  const completeStepRef = useRef(null); // always points at the latest completeStep (for the deferred beat)
  const legendRef = useRef([]); // the current ordered kinds; the fresh read for legend ops + persistence
  const commitLegendRef = useRef(null); // latest commitLegend, so applyRemoteOp (defined earlier) can reach it
  const legendOpenRef = useRef(true); // mirrors legendOpen so persistence reads it without a dep churn
  const highlightedKindIdRef = useRef(null); // mirrors the highlighted kind for the Esc/toggle checks
  const composerOpenRef = useRef(false); // mirrors composerOpen for the capture-phase ⌘V guard

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false); // the routed tree couldn't load (offline / gone)
  const [tree, setTree] = useState(null);
  const [renderModel, setRenderModel] = useState(null);
  const [completed, setCompleted] = useState(() => new Set());
  const [inProgress, setInProgress] = useState(() => new Set());
  const [startedAt, setStartedAt] = useState(() => ({})); // { nodeId: ms } — when work began
  const [completedAt, setCompletedAt] = useState(() => ({})); // { nodeId: ms } — when it finished
  const [workspaceByNode, setWorkspaceByNode] = useState(() => ({})); // { nodeId: workspace } — sub-tasks, note, links
  const [legend, setLegend] = useState([]); // the tree's ordered kinds (F6 — color legend)
  const [legendOpen, setLegendOpen] = useState(true); // whether the key is expanded, remembered per tree
  const [legendForceOpen, setLegendForceOpen] = useState(false); // the picker's "+" summoned the key on a 1-kind tree
  const [highlightedKindId, setHighlightedKindId] = useState(null); // a legend row is spotlighting its kind on the graph
  // paste append-mode (F3 §01): ⌘V on the editor opens the same composer to graft a plan
  // under the current selection. The draft text survives Esc; the draft legend seeds from
  // the live legend on open so headings reuse the tree's own kinds.
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftKinds, setDraftKinds] = useState([]);
  const [selectedId, commitSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [bounds, setBounds] = useState(EMPTY_BOUNDS);
  const [scene, setScene] = useState(null);
  const [autoFocusNameId, setAutoFocusNameId] = useState(null); // freshly created bud → StepPanel focuses its name field
  const [toast, setToast] = useState(null); // single status beat: { message, action, key, leaving }
  const [logVersion, setLogVersion] = useState(0); // bump to re-render off the mutable activity log
  const [ticker, setTicker] = useState([]); // live arrival toasts (design C), max 3
  const [newEventIds, setNewEventIds] = useState(() => new Set()); // rows flashing on arrival
  const [feedOpen, setFeedOpen] = useState(false); // the activity feed is summoned (design A″ — closed by default)
  const [pinned, setPinned] = useState(false); // …or pinned to stay docked (= option A)
  const [unreadCount, setUnreadCount] = useState(0); // events since the feed was last opened
  const [activityPing, setActivityPing] = useState(false); // transient chip pulse on a fresh arrival

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
  const setSelectedId = useCallback((id) => {
    cancelNextUpSelect();
    commitSelectedId(id);
  }, [cancelNextUpSelect]);

  const [hasLocalEdits, setHasLocalEdits] = useState(false); // local edits overlaid on the authored seed
  const [reloadKey, setReloadKey] = useState(0); // bump to re-run the load pipeline (e.g. after reset)
  const [shareOpen, setShareOpen] = useState(false); // the Share dialog (export postcard preview)
  const [treeVisibility, setTreeVisibility] = useState(null); // server stance on this tree: 'private'|'unlisted'|'public'|null
  const [treeMine, setTreeMine] = useState(false); // is the signed-in caller this tree's owner
  const [forkOpen, setForkOpen] = useState(false); // the fork "door" (read-only — the page's one verb)
  const [signInOpen, setSignInOpen] = useState(false); // the one sign-in door (X6) — opened by the seat or an expired landing
  const [panning, setPanning] = useState(false); // the scene is being panned; mobile chrome yields (§chrome)
  const [recenterAvailable, setRecenterAvailable] = useState(false); // the tree left the safe frame — offer Recenter
  const [coachAllowed, setCoachAllowed] = useState(false); // the demo coach may mount — a stranger who hasn't seen it (F4 §03)
  const [demoCompletions, setDemoCompletions] = useState(0); // marks made this demo session — any one retires the coach
  const [ctaEcho, setCtaEcho] = useState(false); // the Fork CTA takes the pulse once, after the unlock toast (§04)

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
  }, []);

  // Durable per-node workspaces (F13): callers pass the freshly-computed map, since
  // the state setter is async.
  const persistWorkspace = useCallback((byNode) => {
    if (!seedRef.current) return;
    workspaceStore.save(seedRef.current.id, byNode);
  }, []);

  // The arc feed (§3): hand the scene a fraction for every node whose workspace has
  // sub-tasks (nodes absent = no arc). Reads the fresh ref, so it can fire right after
  // a commit. The scene caches these and re-applies them across model rebuilds.
  const pushArcs = useCallback(() => {
    const arcs = new Map();
    for (const [nodeId, ws] of Object.entries(workspaceByNodeRef.current)) {
      const fraction = arcFraction(ws);
      if (fraction !== null) arcs.set(nodeId, fraction);
    }
    sceneRef.current?.setArcs?.(arcs);
  }, []);

  // The single status beat (canonical §2): a toast enters fade+rise, holds, then
  // fades out. A newer call REPLACES the current one (never stacks); toasts that
  // carry an action (Undo) hold longer so there's time to act.
  const showToast = useCallback((message, options = {}) => {
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    const action = options.action ?? null;
    const hold = action ? 6000 : 4000;
    const key = (toastKeyRef.current += 1);
    setToast({ message, action, key, leaving: false });
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

  // The scene reports pan start/stop (§chrome yields): mobile chrome fades while
  // panning, and the first pan means the tree has left the safe frame — offer Recenter.
  const handlePanStateChange = useCallback((isPanning) => {
    setPanning(isPanning);
    if (isPanning) setRecenterAvailable(true);
  }, []);

  // Record one activity event and play its arrival: the node pulses on the graph
  // (felt first), a ticker toast announces it, and the fresh row flashes in the
  // feed. Removed events skip the pulse/toast — the node is gone and the delete's
  // Undo toast already speaks. Unlocks belong to the tree, so they carry no actor.
  const emit = useCallback((partial, options = {}) => {
    const event = new ActivityEvent({
      id: crypto.randomUUID?.() ?? `ev-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      actor: partial.actor ?? (partial.verb === 'unlocked' ? null : 'You'),
      verb: partial.verb,
      nodeId: partial.nodeId,
      label: partial.label,
      kind: partial.kind,
      at: Date.now(),
    });
    logRef.current.record(event);
    setLogVersion((version) => version + 1);

    // Closed ≠ deaf (design A″): an arrival that lands while the feed isn't being
    // watched counts toward the unread badge and pings the chip; it'll flash on open.
    const watching = (feedOpenRef.current || pinnedRef.current) && !selectedIdRef.current;
    if (!watching) {
      unseenIdsRef.current.add(event.id);
      setUnreadCount(unseenIdsRef.current.size);
      setActivityPing(true);
      setTimeout(() => setActivityPing(false), 900);
    }

    if (event.verb === 'removed') return event;

    setNewEventIds((prev) => new Set(prev).add(event.id));
    setTimeout(() => setNewEventIds((prev) => { const next = new Set(prev); next.delete(event.id); return next; }), 1400);

    // A ceremony's completed/unlocked beats are the growth ceremony's to animate and
    // summarize: they don't pulse individually here, nor stack the ticker. Other
    // verbs (added / renamed / started) still feel their arrival pulse + ticker.
    if (!options.silent) {
      sceneRef.current?.pulseNode(event.nodeId);
      setTicker((prev) => [...prev, event].slice(-3));
      setTimeout(() => setTicker((prev) => prev.filter((entry) => entry.id !== event.id)), 4500);
    }
    return event;
  }, []);

  // The feed became visible: clear the unread badge and replay the events that
  // arrived while it was closed with the arrival flash (design A″ — E's catch-up).
  const markRead = useCallback(() => {
    const ids = [...unseenIdsRef.current];
    if (ids.length === 0) return;
    unseenIdsRef.current = new Set();
    setUnreadCount(0);
    setActivityPing(false);
    setNewEventIds((prev) => new Set([...prev, ...ids]));
    setTimeout(() => setNewEventIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; }), 1400);
  }, []);

  // The Activity chip / the `a` key: summon the feed, or dismiss it if it's the
  // visible tenant. Opening deselects so the feed (not a step's details) shows.
  const toggleActivity = useCallback(() => {
    const visibleAsFeed = (feedOpenRef.current || pinnedRef.current) && !selectedIdRef.current;
    if (visibleAsFeed) { cancelNextUpSelect(); setFeedOpen(false); setPinned(false); }
    else { setFeedOpen(true); setSelectedId(null); }
  }, [cancelNextUpSelect, setSelectedId]);

  const closeActivity = useCallback(() => { cancelNextUpSelect(); setFeedOpen(false); setPinned(false); }, [cancelNextUpSelect]);
  const togglePin = useCallback(() => setPinned((value) => !value), []);

  // Discard local edits and reload the authored seed fresh (clears history too),
  // including the user's durable progress and its timestamps for this tree.
  const handleResetEdits = useCallback(() => {
    if (seedRef.current) {
      collabRef.current?.clearDurable?.();  // drop the durable lattice for this tree
      progressStore.clear(seedRef.current.id);
      workspaceStore.clear(seedRef.current.id);
      legendStore.clear(seedRef.current.id);
    }
    pendingCompleteRef.current.forEach(clearTimeout);
    pendingCompleteRef.current.clear();
    setReloadKey((key) => key + 1);
  }, []);

  // Re-derive the whole render model from the editor's current TreeData and apply
  // it to the scene preserving the view. The seam every structural edit + undo/redo
  // funnels through; constructing a SkillTree here also re-validates the DAG.
  // Positions are a projection of structure: whenever the node/edge signature changes —
  // a create, connect, or delete, local or remote alike — the engine lays the whole tree
  // out afresh, exactly as a page load would. Content-only updates (rename, progress,
  // drag) reuse the cached layout so nothing else moves, and hand-placed nodes win over
  // the engine either way via nudges.
  const layoutPositions = useCallback((nextTree) => {
    const signature = nextTree.allNodes
      .map((node) => `${node.id}<${[...node.prerequisites].sort().join(',')}`)
      .sort()
      .join('|');
    if (layoutCacheRef.current.signature !== signature) {
      layoutCacheRef.current = { signature, raw: layoutEngine.layout(nextTree) };
    }
    return applyNudges(layoutCacheRef.current.raw, nextTree);
  }, []);

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
    commitLegendRef.current?.(deriveLegend(treeData.nodes, treeData.kinds));

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
  }, [syncStructure, showToast]);
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

    // spread successive new children beside each other rather than stacking
    const placed = editor.treeData.nodes.filter((n) => n.position && n.prerequisites.includes(parentId)).length;
    const id = crypto.randomUUID?.() ?? `n-${Date.now()}`;
    // born in the parent's kind (same branch) and pushed radially outward from the
    // center, so a new step lands cleanly in its area rather than crossing others
    const dist = Math.hypot(parent.x, parent.y);
    const outX = dist < 1 ? 0 : parent.x / dist;
    const outY = dist < 1 ? 1 : parent.y / dist;
    const spread = placed * SIBLING_GAP;
    const x = parent.x + outX * CHILD_DROP - outY * spread;
    const y = parent.y + outY * CHILD_DROP + outX * spread;
    const params = { id, label: '', icon: NEW_NODE_ICON, color: parent.color, parentId, x, y };
    collabRef.current?.dispatch({ kind: 'CreateNode', ...params });
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
  }, [syncStructure, emit]);

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

  const handleSetKind = useCallback((id, kind) => {
    if (!id) return;
    collabRef.current?.dispatch({ kind: 'SetNodeColor', id, color: kind });
  }, []);

  // The legend (F6): every kind edit funnels through one seam — update the fresh ref,
  // set state, and persist — mirroring commitWorkspace; the open flag rides in the payload.
  const persistLegend = useCallback((kinds, open) => {
    if (!seedRef.current) return;
    legendStore.save(seedRef.current.id, { kinds, open });
  }, []);

  const commitLegend = useCallback((kinds) => {
    legendRef.current = kinds;
    setLegend(kinds);
    persistLegend(kinds, legendOpenRef.current);
  }, [persistLegend]);
  commitLegendRef.current = commitLegend; // let applyRemoteOp (defined earlier) reach the latest

  // Each legend edit is dispatched as one gesture; the lattice is the authority for the
  // legend (F6) as for everything else, and onTreeChanged re-derives the displayed kinds
  // from it — for our own edit and a collaborator's alike.
  const onRenameKind = useCallback((id, label) => {
    collabRef.current?.dispatch({ kind: 'RenameKind', id, label });
  }, []);
  const onDescribeKind = useCallback((id, description) => {
    collabRef.current?.dispatch({ kind: 'DescribeKind', id, description });
  }, []);
  const onAddKind = useCallback((hue) => {
    const next = addKind(legendRef.current, hue ?? freeHue(legendRef.current));
    if (next === legendRef.current) return; // hue taken or palette full — nothing added
    const added = next[next.length - 1];
    collabRef.current?.dispatch({ kind: 'AddKind', id: added.id, hue: added.hue });
  }, []);

  // Remove is offered only for a kind no node wears; guard here against a stale click,
  // reading the editor's live nodes (the freshest source of every node's hue).
  const onRemoveKind = useCallback((id) => {
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const target = withCounts(legendRef.current, nodes).find((kind) => kind.id === id);
    if (!target || target.count > 0) return;
    collabRef.current?.dispatch({ kind: 'RemoveKind', id });
  }, []);

  // Recolor a kind = swap its hue AND repaint every node of the old hue to the new — one
  // atomic RecolorKind gesture (materialize computes the fan-out; every peer repaints the
  // same set). A no-op swap (hue taken) leaves the nodes alone.
  const onRecolorKind = useCallback((id, targetHue) => {
    const { newHue } = recolorKind(legendRef.current, id, targetHue);
    if (!newHue) return;
    collabRef.current?.dispatch({ kind: 'RecolorKind', id, hue: newHue });
  }, []);

  // A legend row spotlights its kind on the graph (WS-C's scene.highlightKind, called
  // defensively — a sibling adds it). Clicking the lit row again clears it. We track the
  // kind id in state but hand the scene the *hue* (the shared contract), null to clear.
  const onHighlightKind = useCallback((id) => {
    const nextId = id === highlightedKindIdRef.current ? null : id;
    highlightedKindIdRef.current = nextId;
    setHighlightedKindId(nextId);
    const hue = nextId ? legendRef.current.find((kind) => kind.id === nextId)?.hue ?? null : null;
    sceneRef.current?.highlightKind?.(hue);
  }, []);

  const onLegendOpenChange = useCallback((open) => {
    legendOpenRef.current = open;
    setLegendOpen(open);
    persistLegend(legendRef.current, open);
  }, [persistLegend]);

  // The StepPanel picker's ghost "+" forces the key open on a still-keyless 1-kind tree.
  const openLegendFromPicker = useCallback(() => {
    setLegendForceOpen(true);
    onLegendOpenChange(true);
  }, [onLegendOpenChange]);

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
    };
    const nextScene = new SkillTreeScene(canvasRef.current, {
      readOnly: readOnlyRef.current,
      onPanStateChange: handlePanStateChange,
      onNodePick: (id) => {
        if (id) { setSelectedId(id); return; }
        // Empty-canvas click: close details (the feed returns iff it was open),
        // or dismiss the feed itself when nothing was selected (design A″).
        if (selectedIdRef.current) setSelectedId(null);
        else { cancelNextUpSelect(); setFeedOpen(false); setPinned(false); }
      },
      onNodeHover: (id) => setHoveredId(id),
      onCeremonyToast: (message, options) => showToast(message, options),
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
  }, [handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, showToast, handlePanStateChange]);

  // Keyboard: ⌘Z / ⇧⌘Z history, ⌫ / Delete removes the selection, Esc deselects.
  useEffect(() => {
    const onKey = (event) => {
      if (!readOnlyRef.current && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === 'Escape') {
        if (highlightedKindIdRef.current) {
          highlightedKindIdRef.current = null;
          setHighlightedKindId(null);
          sceneRef.current?.highlightKind?.(null);
          return;
        }
        if (selectedIdRef.current) { setSelectedId(null); return; }
        if (sceneRef.current?.selectedEdge) { sceneRef.current.selectEdge(null); return; }
        if (feedOpenRef.current || pinnedRef.current) closeActivity();
        return;
      }
      const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      if (event.key === 'a' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
        event.preventDefault();
        toggleActivity();
        return;
      }
      if (!readOnlyRef.current && (event.key === 'Backspace' || event.key === 'Delete')) {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (selectedIdRef.current) { event.preventDefault(); deleteSelected(); return; }
        const edge = sceneRef.current?.selectedEdge; // edge selection lives in the scene, not React
        if (edge) { event.preventDefault(); handleDeleteEdge(edge.from, edge.to); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected, handleDeleteEdge, toggleActivity, closeActivity]);

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

  // Mirror React's selection back to the scene so the canvas chrome (affordances,
  // highlight) tracks it however it cleared — Esc, the panel's close button, or a
  // canvas click. The scene guards a same-id call, so canvas-driven picks no-op here.
  useEffect(() => { sceneRef.current?.setSelection(selectedId); }, [selectedId]);

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
  useEffect(() => () => pendingCompleteRef.current.forEach(clearTimeout), []);

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
      // Per-node workspaces overlay the same way — saved sub-tasks/notes/links win.
      // The arc feed reads this hydrated map below.
      const savedWorkspace = workspaceStore.load(seed.id);
      const workspaceMap = savedWorkspace ?? {};
      // The color legend (F6) is served by the backend (its `kinds`, reconciled so every
      // in-use hue still has an entry). Open/collapsed stays a local UI preference in localStorage.
      const savedLegend = legendStore.load(seed.id);
      const backendKinds = seed.kinds ?? null;
      const legendKinds = deriveLegend(nextTree.nodes, backendKinds);
      const states = UnlockRules.derive(nextTree, progress);
      const positions = layoutPositions(nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
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
      progressRef.current = progress;
      completedRef.current = new Set(progress.completed);
      inProgressRef.current = new Set(progress.inProgress);
      // Seed the resting feed from the roadmap's build history (the completed deeds) and
      // fold in the server's structural op history, oldest-first.
      const built = ActivityLog.fromTree(nextTree, states, Date.now()).events;
      const fromServer = serverActivity.map((event) => new ActivityEvent({ ...event, actor: event.actor || null }));
      logRef.current = new ActivityLog([...built, ...fromServer].sort((a, b) => a.at - b.at));
      setTree(nextTree);
      setRenderModel(model);
      setTreeVisibility(seed.visibility ?? null); // the server's stance rides the seed; the blob fallback carries none
      setTreeMine(seed.mine ?? false);
      setCompleted(new Set(progress.completed));
      setInProgress(new Set(progress.inProgress));
      setStartedAt(startedAtMap);
      setCompletedAt(completedAtMap);
      workspaceByNodeRef.current = workspaceMap;
      setWorkspaceByNode(workspaceMap);
      legendRef.current = legendKinds;
      legendOpenRef.current = savedLegend?.open ?? true;
      highlightedKindIdRef.current = null;
      setLegend(legendKinds);
      setLegendOpen(savedLegend?.open ?? true);
      setLegendForceOpen(false);
      setHighlightedKindId(null);
      pushArcs(); // seed the gauges from the hydrated workspaces (model is already applied)
      setLogVersion((version) => version + 1);
      setTicker([]);
      setNewEventIds(new Set());
      setFeedOpen(false);
      setPinned(false);
      setUnreadCount(0);
      setActivityPing(false);
      unseenIdsRef.current = new Set();
      setBounds(scene.getBounds());
      if (restoredSelection) setSelectedId(restoredSelection);
      if (!viewReadOnly) placeStore.save({ treeId: seed.id, camera: scene.getViewpoint(), selectedId: restoredSelection });
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
            if (readOnlyRef.current || selectedIdRef.current || feedOpenRef.current || pinnedRef.current) return;
            autoOpen.commit();
            setFeedOpen(true);
          }, NEXT_UP_ENTER_MS);
        }
      }

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
      cancelNextUpSelect(); // unmount / reload strands any pending Next-up select (X1)
      collabRef.current?.close();
      collabRef.current = null;
    };
  }, [reloadKey, treeId, demo]);

  // Single source of truth for node state — every completion ripples through here.
  const states = useMemo(() => {
    if (!tree) return new Map();
    return UnlockRules.derive(tree, { completed, inProgress });
  }, [tree, completed, inProgress]);

  // The legend against the live nodes: each kind's count, and how many are worn (the
  // key appears at two). Recomputes as structure changes — a recolor/set-kind lands a
  // new tree, an add/rename a new legend — so counts and the mount gate stay honest.
  const legendWithCounts = useMemo(() => (tree ? withCounts(legend, tree.nodes) : []), [legend, tree, states]);
  const inUse = useMemo(() => (tree ? inUseCount(legend, tree.nodes) : 0), [legend, tree, states]);

  // The share "score" — done/total + the dominant kind that tints the exported frame.
  const shareStats = useMemo(() => (tree ? ShareStats.from(tree, states) : null), [tree, states]);

  // Push re-derived states to the scene whenever completion changes; the
  // scene owns the growth animation for newly-unlocked branches.
  useEffect(() => {
    sceneRef.current?.applyStates(states);
  }, [states]);

  useEffect(() => { completedRef.current = completed; }, [completed]);
  useEffect(() => { inProgressRef.current = inProgress; }, [inProgress]);
  useEffect(() => { workspaceByNodeRef.current = workspaceByNode; }, [workspaceByNode]);
  useEffect(() => { feedOpenRef.current = feedOpen; }, [feedOpen]);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);
  useEffect(() => { legendRef.current = legend; }, [legend]);
  useEffect(() => { legendOpenRef.current = legendOpen; }, [legendOpen]);
  useEffect(() => { highlightedKindIdRef.current = highlightedKindId; }, [highlightedKindId]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);
  useEffect(() => { composerOpenRef.current = composerOpen; }, [composerOpen]);

  // An expired magic-link landing routes back here and bumps this signal to summon
  // the sign-in door — the same one door the seat opens. Zero is the resting value.
  useEffect(() => { if (openSignInSignal > 0) setSignInOpen(true); }, [openSignInSignal]);

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

  // The feed is the visible dock tenant when summoned/pinned and no step is
  // selected. Whenever it becomes visible, mark everything read (with a catch-up flash).
  const feedVisible = (feedOpen || pinned) && !selectedId;
  useEffect(() => { if (feedVisible) markRead(); }, [feedVisible, markRead]);

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

  // The grouped view and per-node history both recompute when the log version bumps.
  const activityGroups = useMemo(() => logRef.current.groupedByDay(Date.now()), [logVersion]);
  const selectedHistory = useMemo(() => (selectedId ? logRef.current.forNode(selectedId) : []), [selectedId, logVersion]);

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

  const prerequisites = useMemo(() => {
    if (!selectedNode) return [];
    return selectedNode.prerequisites.map((id) => ({
      id,
      label: nodesById.get(id)?.label ?? id,
      complete: states.get(id) === 'complete',
    }));
  }, [selectedNode, nodesById, states]);

  // What completing this step opens up — the node's children, mirroring the
  // prerequisites shape. The read-only StepPanel shows these in place of editing.
  const unlocks = useMemo(() => {
    if (!selectedNode || !tree) return [];
    return tree.nodes
      .filter((node) => node.prerequisites.includes(selectedNode.id))
      .map((node) => ({ id: node.id, label: node.label, complete: states.get(node.id) === 'complete' }));
  }, [selectedNode, tree, states]);

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

  // The shared completion path the button and the chip menu both take, so they can't
  // drift: mark complete, stamp completedAt (keep any startedAt), persist, then run the
  // ceremony — record the beat + its unlocks in the log and hand the scene the summary.
  function completeStep(id, { fromRemote = false } = {}) {
    const node = nodesById.get(id);
    const nextCompleted = new Set(completed).add(id);
    const nextInProgress = new Set(inProgress);
    nextInProgress.delete(id);
    const nextCompletedAt = { ...completedAt, [id]: Date.now() };
    setCompleted(nextCompleted);
    setInProgress(nextInProgress);
    setCompletedAt(nextCompletedAt);
    persistProgress({ completed: nextCompleted, inProgress: nextInProgress, startedAt, completedAt: nextCompletedAt });
    if (!fromRemote) pushProgress(id, 'complete');
    // Record every beat in the log (the feed still tells the full story), but keep
    // them off the ticker — one summary toast closes the ceremony instead.
    emit({ verb: 'completed', nodeId: id, label: node?.label, kind: node?.color }, { silent: true });
    const after = UnlockRules.derive(tree, { completed: nextCompleted, inProgress: nextInProgress });
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
    const summary = demo && id === COACHED_NODE_ID
      ? DEMO_COPY.unlockToast
      : (opened > 0 ? `Step completed: ${label} · ${opened} more opened` : `Step completed: ${label}`);
    sceneRef.current?.announceCeremony(summary);

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

  function handleMarkComplete() {
    if (selectedId) completeStep(selectedId);
  }

  // The chip menu's correction path: set a step to any of the three states directly.
  // Complete reuses completeStep (bloom + ceremony); backward moves are silent — the
  // scene dims them off the states recompute, and the menu itself is the reversibility.
  function handleSetState(id, target, { fromRemote = false } = {}) {
    if (!id) return;
    if (target === 'complete') { completeStep(id, { fromRemote }); return; }

    const nextCompleted = new Set(completed);
    const nextInProgress = new Set(inProgress);
    const nextStartedAt = { ...startedAt };
    const nextCompletedAt = { ...completedAt };
    if (target === 'notstarted') {
      nextCompleted.delete(id);
      nextInProgress.delete(id);
      delete nextStartedAt[id];
      delete nextCompletedAt[id];
    } else {
      nextInProgress.add(id);
      nextCompleted.delete(id);
      if (!nextStartedAt[id]) nextStartedAt[id] = Date.now();
      delete nextCompletedAt[id];
    }
    setCompleted(nextCompleted);
    setInProgress(nextInProgress);
    setStartedAt(nextStartedAt);
    setCompletedAt(nextCompletedAt);
    persistProgress({ completed: nextCompleted, inProgress: nextInProgress, startedAt: nextStartedAt, completedAt: nextCompletedAt });
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

  // Reconciliation (progress-wire, anti-clobber): after each subscribe graft, fetch the server's
  // overlay and push only the local marks it holds no row for — absent from BOTH sets means the
  // server never heard of the mark (made offline or before sign-in), so it's safe to send. A mark
  // the server knows anything about is never re-pushed; the LWW row there stands.
  reconcileProgressRef.current = async () => {
    // Read-only views never write: a signed-in visitor on someone's share page would
    // otherwise push the tree's authored seed marks into their own overlay just by looking.
    if (status !== 'signed-in' || readOnly || !seedRef.current) return;
    let server;
    try {
      const response = await fetch(`${API_BASE}/v1/trees/${seedRef.current.id}/progress`, { credentials: 'include' });
      if (!response.ok) return;
      server = await response.json();
    } catch {
      return; // the socket outlived the fetch or vice versa — the next graft reconciles
    }
    const known = new Set([...(server.completed ?? []), ...(server.inProgress ?? []), ...(server.cleared ?? [])]);
    for (const id of completedRef.current) {
      if (!known.has(id)) collabRef.current?.sendProgress(id, 'complete');
    }
    for (const id of inProgressRef.current) {
      if (!known.has(id)) collabRef.current?.sendProgress(id, 'active');
    }
  };

  // Any workspace change on a node calls off a pending auto-complete for it (§4) —
  // an uncheck, a note edit, a link, all count as "the user is still working".
  const cancelAutoComplete = useCallback((nodeId) => {
    const timer = pendingCompleteRef.current.get(nodeId);
    if (!timer) return;
    clearTimeout(timer);
    pendingCompleteRef.current.delete(nodeId);
  }, []);

  // The one seam every workspace edit funnels through: store the node's next
  // workspace (fresh ref for immediate reads), render it, and persist the map.
  const commitWorkspace = useCallback((nodeId, nextWs) => {
    const nextMap = { ...workspaceByNodeRef.current, [nodeId]: nextWs };
    workspaceByNodeRef.current = nextMap;
    setWorkspaceByNode(nextMap);
    persistWorkspace(nextMap);
  }, [persistWorkspace]);

  const onAddSubtask = useCallback((nodeId, label) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addSubtask(current, label));
    pushArcs();
  }, [cancelAutoComplete, commitWorkspace, pushArcs]);

  // A check can close the gauge: after the fraction is pushed, if every box is now
  // done and the node isn't already complete, hold a breath then run F1's completion
  // beat (bloom + unlocks). The timer is cancelable — a later change lands the
  // cancelAutoComplete above first. Sticky (§4.3): only a check ever schedules this.
  const onToggleSubtask = useCallback((nodeId, subtaskId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    const next = toggleSubtask(current, subtaskId);
    commitWorkspace(nodeId, next);
    pushArcs();
    const allDone = next.subtasks.length > 0 && next.subtasks.every((subtask) => subtask.done);
    if (!allDone || completedRef.current.has(nodeId)) return;
    const timer = setTimeout(() => {
      pendingCompleteRef.current.delete(nodeId);
      completeStepRef.current?.(nodeId);
    }, AUTO_COMPLETE_HOLD);
    pendingCompleteRef.current.set(nodeId, timer);
  }, [cancelAutoComplete, commitWorkspace, pushArcs]);

  const onEditSubtask = useCallback((nodeId, subtaskId, label) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, editSubtask(current, subtaskId, label));
  }, [cancelAutoComplete, commitWorkspace]);

  const onDeleteSubtask = useCallback((nodeId, subtaskId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteSubtask(current, subtaskId));
    pushArcs();
  }, [cancelAutoComplete, commitWorkspace, pushArcs]);

  const onSetNote = useCallback((nodeId, markdown) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, setNote(current, markdown));
  }, [cancelAutoComplete, commitWorkspace]);

  const onAddLink = useCallback((nodeId, rawUrl) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, addLink(current, rawUrl));
  }, [cancelAutoComplete, commitWorkspace]);

  const onDeleteLink = useCallback((nodeId, linkId) => {
    cancelAutoComplete(nodeId);
    const current = workspaceByNodeRef.current[nodeId] ?? emptyWorkspace();
    commitWorkspace(nodeId, deleteLink(current, linkId));
  }, [cancelAutoComplete, commitWorkspace]);

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
      onMarkComplete={demo ? handleMarkComplete : undefined}
      onClose={() => setSelectedId(null)}
    />
  );

  return (
    <div className={`st-root ${panning ? 'panning' : ''}`} ref={rootRef}>
      <canvas ref={canvasRef} className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''}`} />

      {!readOnly && (
        <PresenceLayer peersRef={peersRef} scene={scene} canvasRef={canvasRef} collabRef={collabRef} selection={selectedId} />
      )}

      {readOnly ? (
        <MobileChrome
          title={tree?.title}
          progress={{ done: shareStats?.done ?? 0, total: shareStats?.total ?? 0 }}
          author={tree?.author}
          byline={demo ? `${DEMO_COPY.plaqueByline} · ${shareStats?.done ?? 0}/${shareStats?.total ?? 0} done` : undefined}
          ctaEcho={ctaEcho}
          dominantKind={shareStats?.dominantKind}
          onFork={(shared || !!demotion) && !demotion?.cardOpen ? () => setForkOpen(true) : undefined}
          onRecenter={handleRecenter}
          showRecenter={recenterAvailable}
          tablet={breakpoint === 'tablet'}
          panelOpen={!!selectedNode}
        />
      ) : (
        <ControlBar
          title={tree?.title}
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
          activityOpen={feedVisible}
          activityUnread={unreadCount}
          activityPing={activityPing}
          readyCount={readyCount}
          onToggleActivity={toggleActivity}
        />
      )}

      {/* The account seat (X6) — a desktop/editor concern this pass. It sits a row
          below the control cluster in the top-right so it never collides with it, and
          below the detail panel's z so an open panel covers it just like it covers the
          control bar (z 20 < seat 24 < panel 25). */}
      {!readOnly && (
        <div style={{ position: 'absolute', top: 'calc(var(--space-6) + 52px)', right: 'var(--space-6)', zIndex: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          {lapsed && status !== 'signed-in' && <StatusChip>Signed out — saved on this device</StatusChip>}
          <AccountSeat
            user={user}
            status={status}
            expired={lapsed}
            claimBusy={claimBusy}
            onSignIn={() => setSignInOpen(true)}
            onSignOut={signOut}
            onConnect={() => { window.location.hash = '#/connect'; }}
            onSettings={() => { window.location.hash = '#/settings'; }}
          />
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
                count={logRef.current.size}
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
        <BottomSheet open={!!selectedNode} onDismiss={() => setSelectedId(null)}>
          {readOnlyDetail}
        </BottomSheet>
      )}

      {readOnly && breakpoint !== 'phone' && (
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
          onSignIn={() => setSignInOpen(true)}
        />
      )}

      {(shared || !!demotion) && (
        <ForkDoor open={forkOpen} tablet={breakpoint === 'tablet'} treeId={treeId} signedIn={status === 'signed-in'} demo={demo} stepCount={shareStats?.total} onClose={() => setForkOpen(false)} />
      )}

      {/* The coach (F4 §02) — the one temporary element the demo adds: it points at the
          single ready step, once ever per human, and retires on ✕/Esc/any completion/fork. */}
      {demo && coachAllowed && scene && (
        <CoachChip
          scene={scene}
          nodeId={COACHED_NODE_ID}
          onMarkDone={() => completeStep(COACHED_NODE_ID)}
          completionCount={demoCompletions}
        />
      )}

      {toast && (
        <div className={`st-toast ${toast.leaving ? 'is-leaving' : ''}`} role="status" key={toast.key}>
          <span>{toast.message}</span>
          {toast.action && (
            <button className="st-toast-undo" onClick={() => { toast.action.run(); dismissToast(); }}>
              {toast.action.label}
            </button>
          )}
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

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        visibility={treeVisibility}
        mine={treeMine}
      />

      {loading && !loadError && <div className="st-loading">Planting the tree…</div>}
      {loadError && <div className="st-loading">Couldn’t load this roadmap. It may have moved, or the server is unreachable.</div>}
    </div>
  );
}
