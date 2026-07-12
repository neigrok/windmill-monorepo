// Skill-tree view — runs the pipeline (repository → domain → layout → scene)
// and hosts the overlay UI around the GPU canvas: top controls, the docked
// step panel, and a minimap. No business logic lives here — every node
// state comes from UnlockRules.derive; this file only wires data through.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './skilltree.css';
import { ControlBar } from './ui/ControlBar.jsx';
import { TreeSwitcher } from './ui/TreeSwitcher.jsx';
import { TidinessBadge } from './ui/TidinessBadge.jsx';
import { StepPanel } from './ui/StepPanel.jsx';
import { Minimap } from './ui/Minimap.jsx';
import { useViewMode } from './ui/useViewMode.js';
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
import { ActivityLog, ActivityEvent } from './activity/ActivityLog.js';
import { ActorAvatar, EventSentence } from './activity/grammar.jsx';
import { SkillTree } from './model/SkillTree.js';
import { makeRenderable } from './model/looseGraph.js';
import { TreeHealth } from './model/TreeHealth.js';
import { UnlockRules } from './model/UnlockRules.js';
import { RadialLayoutEngine } from './layout/RadialLayoutEngine.js';
import { applyNudges } from './layout/applyNudges.js';
import { MockTreeRepository } from './mock/MockTreeRepository.js';
import { HttpTreeRepository } from './persistence/HttpTreeRepository.js';
import { listTrees } from './persistence/TreeRegistry.js';
import { CollabClient } from './persistence/CollabClient.js';
import { PresenceLayer } from './presence/PresenceLayer.jsx';
import { TreeStore } from './persistence/TreeStore.js';
import { ProgressStore } from './persistence/ProgressStore.js';
import { WorkspaceStore } from './persistence/WorkspaceStore.js';
import { LegendStore } from './persistence/LegendStore.js';
import { emptyWorkspace, arcFraction, addSubtask, toggleSubtask, editSubtask, deleteSubtask, setNote, addLink, deleteLink } from './model/NodeWorkspace.js';
import { deriveLegend, withCounts, inUseCount, freeHue, renameKind, describeKind, addKind, removeKind, recolorKind, reorderKinds } from './model/Legend.js';
import { KindLegend } from '../components/tree/KindLegend.jsx';
import { SkillTreeScene } from './scene/SkillTreeScene.js';
import { TreeEditor } from './editing/TreeEditor.js';
import { repositionNode, addChildNode, renameNode, deleteNode, addEdge, removeEdge, reconnectEdge, setNodeColor, transitiveReduction } from './editing/edits.js';
import { NODE_SIZE } from './theme.js';

const layoutEngine = new RadialLayoutEngine();
const treeStore = new TreeStore();
const progressStore = new ProgressStore();
const workspaceStore = new WorkspaceStore();
const legendStore = new LegendStore();
const AUTO_COMPLETE_HOLD = 600; // held breath before auto-completing: arc-close 280 + hold 320 (§4)
const EMPTY_BOUNDS = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
const CHILD_DROP = NODE_SIZE * 2.6; // world units a new child spawns below its parent
const SIBLING_GAP = NODE_SIZE * 1.8; // horizontal spread between successive new children
const NEW_NODE_ICON = 'sparkles';

export function SkillTreeView({ treeId, openSignInSignal = 0 }) {
  const { breakpoint, readOnly } = useViewMode();
  const { user, status, signOut } = useAuth(); // the account seat's source of truth (X6)
  const canvasRef = useRef(null);
  const rootRef = useRef(null);
  const sceneRef = useRef(null);
  const readOnlyRef = useRef(readOnly); // the scene is built once; it reads the fresh mode without a rebuild
  const progressRef = useRef({ completed: new Set(), inProgress: new Set() });
  const editorRef = useRef(null);
  const rawLayoutRef = useRef(new Map());
  const completedRef = useRef(new Set());
  const inProgressRef = useRef(new Set());
  const logRef = useRef(new ActivityLog());
  const feedOpenRef = useRef(false); // mirrors feedOpen for emit's synchronous "is the feed being watched?" check
  const pinnedRef = useRef(false);
  const unseenIdsRef = useRef(new Set()); // events that arrived while the feed wasn't visible
  const seedRef = useRef(null); // authored tree for the current dataset (persistence baseline)
  const datasetSizeRef = useRef('demo');
  const collabRef = useRef(null); // live socket to windmill-backend (dogfood roadmap only)
  const peersRef = useRef(new Map()); // actor -> { name, color, cursor, selection } for the presence overlay
  const applyRemoteOpRef = useRef(null); // always points at the latest applyRemoteOp
  const invalidRef = useRef(false); // whether the last render fell back to the loose-graph path
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

  const [datasetSize, setDatasetSize] = useState('demo');
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
  const [selectedId, setSelectedId] = useState(null);
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

  const showActivity = datasetSize === 'demo'; // the feed only rides on the dogfood roadmap
  const [hasLocalEdits, setHasLocalEdits] = useState(false); // local edits overlaid on the authored seed
  const [reloadKey, setReloadKey] = useState(0); // bump to re-run the load pipeline (e.g. after reset)
  const [shareOpen, setShareOpen] = useState(false); // the Share dialog (export postcard preview)
  const [forkOpen, setForkOpen] = useState(false); // the fork "door" (read-only — the page's one verb)
  const [signInOpen, setSignInOpen] = useState(false); // the one sign-in door (X6) — opened by the seat or an expired landing
  const [panning, setPanning] = useState(false); // the scene is being panned; mobile chrome yields (§chrome)
  const [recenterAvailable, setRecenterAvailable] = useState(false); // the tree left the safe frame — offer Recenter

  // Save the edited tree over its seed. Only the dogfood roadmap persists — the
  // huge perf tree is a throwaway. Every structural edit, undo/redo, and move
  // funnels here, so the browser always reloads the latest edit.
  const persistEdits = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !seedRef.current || datasetSizeRef.current !== 'demo') return;
    treeStore.save(seedRef.current, editor.treeData);
    setHasLocalEdits(true);
  }, []);

  // Durable progress: save the user's completions, in-progress steps, and the
  // timestamps of those actions so they survive a reload. Same dataset guard as
  // persistEdits — only the dogfood roadmap persists; the perf tree is a throwaway.
  // Callers pass the freshly-computed next values, since state setters are async.
  const persistProgress = useCallback((next) => {
    if (!seedRef.current || datasetSizeRef.current !== 'demo') return;
    progressStore.save(seedRef.current.id, next);
  }, []);

  // Durable per-node workspaces (F13): same dataset guard as progress — only the
  // dogfood roadmap persists; the perf tree is a throwaway. Callers pass the
  // freshly-computed map, since the state setter is async.
  const persistWorkspace = useCallback((byNode) => {
    if (!seedRef.current || datasetSizeRef.current !== 'demo') return;
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
    if (visibleAsFeed) { setFeedOpen(false); setPinned(false); }
    else { setFeedOpen(true); setSelectedId(null); }
  }, []);

  const closeActivity = useCallback(() => { setFeedOpen(false); setPinned(false); }, []);
  const togglePin = useCallback(() => setPinned((value) => !value), []);

  // Discard local edits and reload the authored seed fresh (clears history too),
  // including the user's durable progress and its timestamps for this tree.
  const handleResetEdits = useCallback(() => {
    if (seedRef.current) {
      treeStore.clear(seedRef.current.id);
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

    const positions = applyNudges(rawLayoutRef.current, nextTree);
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
  }, [persistEdits, showToast]);

  // Apply an authoritative op frame from the backend to the local tree, then re-render
  // through the same seam a local edit uses. If the op leaves the graph invalid (e.g. a
  // remote cycle), syncStructure renders the loose-graph projection and surfaces it.
  const applyRemoteOp = useCallback((op) => {
    const editor = editorRef.current;
    if (!editor) return;
    const data = editor.treeData;
    const p = op.payload || {};
    let next = null;
    switch (op.kind) {
      case 'CreateNode':
        next = { ...data, nodes: [...data.nodes, {
          id: p.id, label: p.label, icon: p.icon, color: p.color,
          prerequisites: p.parentId ? [p.parentId] : [],
          position: (p.x != null && p.y != null) ? { x: p.x, y: p.y } : undefined,
        }] };
        break;
      case 'AddEdge': next = addEdge(data, p.from, p.to); break;
      case 'RemoveEdge': next = removeEdge(data, p.from, p.to); break;
      case 'ReconnectEdge': next = reconnectEdge(data, p.oldFrom, p.oldTo, p.newFrom, p.newTo); break;
      case 'RenameNode': next = renameNode(data, p.id, p.label); break;
      case 'SetNodeColor': next = setNodeColor(data, p.id, p.color); break;
      case 'RepositionNode': next = repositionNode(data, p.id, p.x, p.y); break;
      case 'DeleteNode': next = deleteNode(data, p.id); break;
      case 'TransitiveReduction': next = transitiveReduction(data); break;
      // Legend ops (F6) carry no treeData change (except RecolorKind, which repaints the
      // nodes wearing the old hue — the server did the same atomically). They update the
      // ordered kinds through the same commit seam a local legend edit uses.
      case 'RenameKind': commitLegendRef.current?.(renameKind(legendRef.current, p.id, p.label)); return;
      case 'DescribeKind': commitLegendRef.current?.(describeKind(legendRef.current, p.id, p.description)); return;
      case 'AddKind': commitLegendRef.current?.(addKind(legendRef.current, p.hue, p.id)); return;
      case 'RemoveKind': commitLegendRef.current?.(removeKind(legendRef.current, p.id)); return;
      case 'ReorderKinds': commitLegendRef.current?.(reorderKinds(legendRef.current, p.order)); return;
      case 'RecolorKind': {
        const oldHue = legendRef.current.find((kind) => kind.id === p.id)?.hue;
        let repainted = data;
        if (oldHue) for (const node of data.nodes.filter((n) => n.color === oldHue)) repainted = setNodeColor(repainted, node.id, p.hue);
        if (repainted !== data && editor.commit(repainted)) syncStructure();
        commitLegendRef.current?.(legendRef.current.map((kind) => (kind.id === p.id ? { ...kind, hue: p.hue } : kind)));
        return;
      }
      default: return;
    }
    console.log('[collab] applying op', op.seq, op.kind, op.payload);
    if (editor.commit(next)) syncStructure();
  }, [syncStructure]);
  applyRemoteOpRef.current = applyRemoteOp;

  // A node was dragged to a new spot: record it as one edit. The scene is already
  // showing the new position, so only history + the minimap need updating.
  const handleNodeMoved = useCallback((id, x, y) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.commit(repositionNode(editor.treeData, id, x, y));
    setRenderModel((model) => (model ? { ...model } : model));
    persistEdits();
    collabRef.current?.send('RepositionNode', { id, x, y });
  }, [persistEdits]);

  // On the live roadmap, undo/redo is server-driven (per author) so it stays in sync;
  // the throwaway perf tree falls back to the local editor history.
  const undo = useCallback(() => {
    if (collabRef.current) { collabRef.current.undo(); return; }
    if (editorRef.current?.undo()) syncStructure();
  }, [syncStructure]);
  const redo = useCallback(() => {
    if (collabRef.current) { collabRef.current.redo(); return; }
    if (editorRef.current?.redo()) syncStructure();
  }, [syncStructure]);

  // The panel's name field committed (Enter/blur): one history step, and only
  // if the label actually changed.
  const handleRename = useCallback((id, label) => {
    const editor = editorRef.current;
    if (!editor) return;
    const node = editor.treeData.nodes.find((n) => n.id === id);
    if (!node || node.label === label) return;
    const wasNamed = node.label.trim() !== ''; // naming a fresh bud is part of the add, not a rename
    editor.commit(renameNode(editor.treeData, id, label));
    syncStructure();
    collabRef.current?.send('RenameNode', { id, label });
    if (wasNamed) emit({ verb: 'renamed', nodeId: id, label, kind: node.color });
  }, [syncStructure, emit]);

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
    editor.commit(addChildNode(editor.treeData, params));
    syncStructure();
    collabRef.current?.send('CreateNode', params);
    scene.select(id);
    setSelectedId(id);
    setAutoFocusNameId(id);
    emit({ verb: 'added', nodeId: id, label: '', kind: parent.color });
  }, [syncStructure, emit]);

  // Drag from a port to a node → add a dependency (one history step). The gesture
  // already blocked cycles before the drop.
  const handleConnect = useCallback((sourceId, targetId) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(addEdge(editor.treeData, sourceId, targetId))) {
      syncStructure();
      collabRef.current?.send('AddEdge', { from: sourceId, to: targetId });
    }
  }, [syncStructure]);

  // Midpoint × on a branch → drop the edge (silent, one step; ⌘Z restores).
  const handleDeleteEdge = useCallback((sourceId, targetId) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(removeEdge(editor.treeData, sourceId, targetId))) {
      syncStructure();
      collabRef.current?.send('RemoveEdge', { from: sourceId, to: targetId });
    }
  }, [syncStructure]);

  // Drag an edge endpoint to a new node → re-aim it in one undoable step. The
  // gesture already blocked cycles and dropping back on the original end.
  const handleReconnect = useCallback((oldFrom, oldTo, newFrom, newTo) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(reconnectEdge(editor.treeData, oldFrom, oldTo, newFrom, newTo))) {
      syncStructure();
      collabRef.current?.send('ReconnectEdge', { oldFrom, oldTo, newFrom, newTo });
    }
  }, [syncStructure]);

  // Delete a node; its children splice up to the deleted node's parents (one
  // history step). The one destructive edit that earns a toast.
  const deleteNodeAt = useCallback((id) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    const before = editor.treeData;
    const node = before.nodes.find((n) => n.id === id); // snapshot before it's gone

    // The app splices orphaned children up to the deleted node's parents; the backend's
    // DeleteNode is a plain tombstone. Send the delete plus the re-tether edges as
    // primitive ops so both sides converge on the same spliced result.
    const grandparents = node ? node.prerequisites : [];
    const retether = [];
    for (const child of before.nodes) {
      if (!child.prerequisites.includes(id)) continue;
      if (child.prerequisites.some((p) => p !== id)) continue; // keeps another parent, no re-tether
      for (const g of grandparents) if (g !== child.id) retether.push({ from: g, to: child.id });
    }

    editor.commit(deleteNode(before, id));
    if (selectedIdRef.current === id) setSelectedId(null);
    syncStructure();
    collabRef.current?.send('DeleteNode', { id });
    retether.forEach((edge) => collabRef.current?.send('AddEdge', edge));
    showToast('Step deleted', { action: { label: 'Undo', run: undo } });
    emit({ verb: 'removed', nodeId: id, label: node?.label, kind: node?.color });
  }, [syncStructure, emit, showToast, undo]);
  const deleteSelected = useCallback(() => deleteNodeAt(selectedIdRef.current), [deleteNodeAt]);

  const handleSetKind = useCallback((id, kind) => {
    const editor = editorRef.current;
    if (!editor || !id) return;
    if (editor.commit(setNodeColor(editor.treeData, id, kind))) {
      syncStructure();
      collabRef.current?.send('SetNodeColor', { id, color: kind });
    }
  }, [syncStructure]);

  // The legend (F6): every kind edit funnels through one seam — update the fresh ref,
  // set state, and persist — mirroring commitWorkspace. Persistence is demo-only, the
  // same throwaway-tree guard as progress/workspace; the open flag rides in the payload.
  const persistLegend = useCallback((kinds, open) => {
    if (!seedRef.current || datasetSizeRef.current !== 'demo') return;
    legendStore.save(seedRef.current.id, { kinds, open });
  }, []);

  const commitLegend = useCallback((kinds) => {
    legendRef.current = kinds;
    setLegend(kinds);
    persistLegend(kinds, legendOpenRef.current);
  }, [persistLegend]);
  commitLegendRef.current = commitLegend; // let applyRemoteOp (defined earlier) reach the latest

  // Each legend edit commits locally (optimistic) and, on the live roadmap, sends its op
  // to the backend — the authority for the legend (F6). The echo of our own op is skipped
  // by CollabClient; a collaborator's op arrives through applyRemoteOp.
  const onRenameKind = useCallback((id, label) => {
    commitLegend(renameKind(legendRef.current, id, label));
    collabRef.current?.send('RenameKind', { id, label: legendRef.current.find((k) => k.id === id)?.label ?? label });
  }, [commitLegend]);
  const onDescribeKind = useCallback((id, description) => {
    commitLegend(describeKind(legendRef.current, id, description));
    collabRef.current?.send('DescribeKind', { id, description: legendRef.current.find((k) => k.id === id)?.description ?? description });
  }, [commitLegend]);
  const onAddKind = useCallback((hue) => {
    const next = addKind(legendRef.current, hue ?? freeHue(legendRef.current));
    if (next === legendRef.current) return; // hue taken or palette full — nothing added
    commitLegend(next);
    const added = next[next.length - 1];
    collabRef.current?.send('AddKind', { id: added.id, hue: added.hue });
  }, [commitLegend]);

  // Remove is offered only for a kind no node wears; guard here against a stale click,
  // reading the editor's live nodes (the freshest source of every node's hue).
  const onRemoveKind = useCallback((id) => {
    const nodes = editorRef.current?.treeData.nodes ?? [];
    const target = withCounts(legendRef.current, nodes).find((kind) => kind.id === id);
    if (!target || target.count > 0) return;
    commitLegend(removeKind(legendRef.current, id));
    collabRef.current?.send('RemoveKind', { id });
  }, [commitLegend]);

  // Recolor a kind = swap its hue AND repaint every node of the old hue to the new. On the
  // live roadmap this is one atomic RecolorKind op (the server repaints too); locally we
  // apply the same effect optimistically. A no-op swap (hue taken) leaves the nodes alone.
  const onRecolorKind = useCallback((id, targetHue) => {
    const editor = editorRef.current;
    if (!editor) return;
    const { legend: nextLegend, oldHue, newHue } = recolorKind(legendRef.current, id, targetHue);
    if (!newHue) return;
    const repainted = editor.treeData.nodes.filter((node) => node.color === oldHue);
    for (const node of repainted) editor.commit(setNodeColor(editor.treeData, node.id, newHue));
    if (repainted.length > 0) syncStructure();
    commitLegend(nextLegend);
    collabRef.current?.send('RecolorKind', { id, hue: newHue });
  }, [commitLegend, syncStructure]);

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

  // One-click tidy: drop transitively-implied dependencies in one undoable step.
  // Only offered when there's redundancy to remove, so the commit is never a no-op.
  const handleTidy = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.commit(transitiveReduction(editor.treeData))) {
      syncStructure();
      collabRef.current?.send('TransitiveReduction', {});
      showToast('Tidied — dropped redundant links', { action: { label: 'Undo', run: undo } });
    }
  }, [syncStructure, showToast, undo]);

  // Construct the scene once; React only ever drives it through the methods below.
  // Read-only omits every edit callback so no gesture can mutate the tree, and passes
  // `readOnly` so the scene suppresses its own affordances (X5 shared contract).
  useEffect(() => {
    const editing = readOnlyRef.current ? {} : {
      onNodeMoveEnd: handleNodeMoved,
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
        else { setFeedOpen(false); setPinned(false); }
      },
      onNodeHover: (id) => setHoveredId(id),
      onCeremonyToast: (message, options) => showToast(message, options),
      ...editing,
    });
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
  }, [handleNodeMoved, handleCreateChild, handleConnect, deleteNodeAt, handleSetKind, handleDeleteEdge, handleReconnect, showToast, handlePanStateChange]);

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

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // Mirror React's selection back to the scene so the canvas chrome (affordances,
  // highlight) tracks it however it cleared — Esc, the panel's close button, or a
  // canvas click. The scene guards a same-id call, so canvas-driven picks no-op here.
  useEffect(() => { sceneRef.current?.setSelection(selectedId); }, [selectedId]);

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
    setLoading(true);
    setLoadError(false);
    setSelectedId(null);

    async function loadTree() {
      // The routed tree comes from the backend, per treeId; the throwaway 5k perf tree
      // is generated client-side, so it stays on the mock repository.
      const repo = datasetSize === 'huge'
        ? new MockTreeRepository({ size: 'huge' })
        : new HttpTreeRepository({ treeId });
      const seed = await repo.loadTree();
      // Overlay any locally-saved edits on the seed (dogfood roadmap only); a
      // changed seed invalidates them inside the store, so code wins over state.
      const persisted = datasetSize === 'demo' ? treeStore.load(seed) : null;
      const treeData = persisted ?? seed;
      if (!cancelled) setHasLocalEdits(!!persisted);
      const nextTree = new SkillTree(treeData);
      const progress = await repo.loadProgress(treeData);
      // The authoritative structural history from the op log (demo only) — merged into the
      // resting feed below so a collaborator's edits show up, not just this browser's.
      const serverActivity = datasetSize === 'demo' ? await repo.loadActivity({ limit: 200 }) : [];
      // Durable progress overlays the repo/seed baseline: a user's saved completions
      // win (they already fold in whatever seed state existed when saved), so marking
      // — or un-marking — a step sticks across reloads. No saved progress → seed as today.
      const savedProgress = datasetSize === 'demo' ? progressStore.load(seed.id) : null;
      if (savedProgress) {
        progress.completed = new Set(savedProgress.completed);
        progress.inProgress = new Set(savedProgress.inProgress);
      }
      const startedAtMap = savedProgress?.startedAt ?? {};
      const completedAtMap = savedProgress?.completedAt ?? {};
      // Per-node workspaces overlay the same way — saved sub-tasks/notes/links win, and
      // the throwaway perf tree keeps none. The arc feed reads this hydrated map below.
      const savedWorkspace = datasetSize === 'demo' ? workspaceStore.load(seed.id) : null;
      const workspaceMap = savedWorkspace ?? {};
      // The color legend (F6) is served by the backend for the live roadmap (its `kinds`,
      // reconciled so every in-use hue still has an entry); the mock perf tree derives it
      // from the hues in use. Open/collapsed stays a local UI preference in localStorage.
      const savedLegend = datasetSize === 'demo' ? legendStore.load(seed.id) : null;
      const backendKinds = datasetSize === 'demo' ? (seed.kinds ?? null) : null;
      const legendKinds = deriveLegend(nextTree.nodes, backendKinds);
      const states = UnlockRules.derive(nextTree, progress);
      const rawLayout = await layoutEngine.layout(nextTree);
      const positions = applyNudges(rawLayout, nextTree);
      const model = nextTree.toRenderModel(positions, states);
      if (cancelled) return;

      const scene = sceneRef.current;
      scene.setModel(model);
      scene.fitToView();

      editorRef.current = new TreeEditor(treeData);
      rawLayoutRef.current = rawLayout;
      seedRef.current = seed;
      datasetSizeRef.current = datasetSize;
      progressRef.current = progress;
      completedRef.current = new Set(progress.completed);
      inProgressRef.current = new Set(progress.inProgress);
      // Seed the resting feed from the roadmap's build history (the completed deeds) and
      // fold in the server's structural op history, oldest-first (demo only; the 5k perf
      // tree is a throwaway with no story to tell).
      if (datasetSize === 'demo') {
        const built = ActivityLog.fromTree(nextTree, states, Date.now()).events;
        const fromServer = serverActivity.map((event) => new ActivityEvent({ ...event, actor: event.actor || null }));
        logRef.current = new ActivityLog([...built, ...fromServer].sort((a, b) => a.at - b.at));
      } else {
        logRef.current = new ActivityLog();
      }
      setTree(nextTree);
      setRenderModel(model);
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
      setLoading(false);

      // Go live: subscribe to the backend and apply authoritative ops as they land, so
      // an edit made anywhere shows up here. Dogfood roadmap only.
      collabRef.current?.close();
      peersRef.current.clear();
      if (datasetSize === 'demo') {
        collabRef.current = new CollabClient({ treeId: seed.id })
          .onOp((op) => applyRemoteOpRef.current?.(op))
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
          .connect();
      }
    }

    loadTree().catch((err) => {
      if (cancelled) return;
      console.warn('[tree] load failed', treeId, err);
      setLoadError(true);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      collabRef.current?.close();
      collabRef.current = null;
    };
  }, [datasetSize, reloadKey, treeId]);

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

  // An expired magic-link landing routes back here and bumps this signal to summon
  // the sign-in door — the same one door the seat opens. Zero is the resting value.
  useEffect(() => { if (openSignInSignal > 0) setSignInOpen(true); }, [openSignInSignal]);

  // The feed is the visible dock tenant when summoned/pinned and no step is
  // selected. Whenever it becomes visible, mark everything read (with a catch-up flash).
  const feedVisible = showActivity && (feedOpen || pinned) && !selectedId;
  useEffect(() => { if (feedVisible) markRead(); }, [feedVisible, markRead]);

  const nodesById = useMemo(() => {
    if (!tree) return new Map();
    return new Map(tree.nodes.map((node) => [node.id, node]));
  }, [tree]);

  // Graph tidiness — cross-area coupling + redundancy → a score the user nudges up.
  const health = useMemo(() => (tree ? TreeHealth.assess(tree) : null), [tree]);

  // The grouped view and per-node history both recompute when the log version bumps.
  const activityGroups = useMemo(() => logRef.current.groupedByDay(Date.now()), [logVersion]);
  const selectedHistory = useMemo(() => (selectedId ? logRef.current.forNode(selectedId) : []), [selectedId, logVersion]);

  const handleRowHover = useCallback((id) => sceneRef.current?.spotlightNode(id), []);
  const handleRowLeave = useCallback(() => sceneRef.current?.spotlightNode(null), []);
  const handleRevealNode = useCallback((id) => sceneRef.current?.revealNode(id), []);

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
    emit({ verb: 'started', nodeId: selectedId, label: node?.label, kind: node?.color }, { silent: true });
  }

  // The shared completion path the button and the chip menu both take, so they can't
  // drift: mark complete, stamp completedAt (keep any startedAt), persist, then run the
  // ceremony — record the beat + its unlocks in the log and hand the scene the summary.
  function completeStep(id) {
    const node = nodesById.get(id);
    const nextCompleted = new Set(completed).add(id);
    const nextInProgress = new Set(inProgress);
    nextInProgress.delete(id);
    const nextCompletedAt = { ...completedAt, [id]: Date.now() };
    setCompleted(nextCompleted);
    setInProgress(nextInProgress);
    setCompletedAt(nextCompletedAt);
    persistProgress({ completed: nextCompleted, inProgress: nextInProgress, startedAt, completedAt: nextCompletedAt });
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
    // it once the bloom/travel/pulse have settled (§2 toast — last), not up front.
    const label = node?.label?.trim() || 'Step';
    sceneRef.current?.announceCeremony(opened > 0 ? `Step completed: ${label} · ${opened} more opened` : `Step completed: ${label}`);
  }

  completeStepRef.current = completeStep; // the auto-complete timer fires the freshest one

  function handleMarkComplete() {
    if (selectedId) completeStep(selectedId);
  }

  // The chip menu's correction path: set a step to any of the three states directly.
  // Complete reuses completeStep (bloom + ceremony); backward moves are silent — the
  // scene dims them off the states recompute, and the menu itself is the reversibility.
  function handleSetState(id, target) {
    if (!id) return;
    if (target === 'complete') { completeStep(id); return; }

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
  }

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

  // Fork is the read-only page's one verb. Submit is stubbed here — the real fork is
  // a backend task (X5); ForkDoor shows its own "check your email" sent state.
  function handleForkSubmit() {}

  function handlePanTo(x, y) {
    sceneRef.current?.panTo(x, y);
  }

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
      onClose={() => setSelectedId(null)}
    />
  );

  return (
    <div className={`st-root ${panning ? 'panning' : ''}`} ref={rootRef}>
      <canvas ref={canvasRef} className={`st-canvas ${hoveredId ? 'st-canvas--hover' : ''}`} />

      {showActivity && !readOnly && (
        <PresenceLayer peersRef={peersRef} scene={scene} canvasRef={canvasRef} collabRef={collabRef} selection={selectedId} />
      )}

      {readOnly ? (
        <MobileChrome
          title={tree?.title}
          progress={{ done: shareStats?.done ?? 0, total: shareStats?.total ?? 0 }}
          author={tree?.author}
          dominantKind={shareStats?.dominantKind}
          onFork={() => setForkOpen(true)}
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
              listTrees={listTrees}
              onNew={() => { window.location.hash = '#/app/new'; }}
            />
          }
          datasetSize={datasetSize}
          onDatasetSizeChange={setDatasetSize}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onFitToView={handleFitToView}
          canReset={hasLocalEdits}
          onResetEdits={handleResetEdits}
          canTidy={!!health && health.redundant > 0}
          onTidy={handleTidy}
          onShare={() => setShareOpen(true)}
          showActivity={showActivity}
          activityOpen={feedVisible}
          activityUnread={unreadCount}
          activityPing={activityPing}
          onToggleActivity={toggleActivity}
        />
      )}

      {/* The account seat (X6) — a desktop/editor concern this pass. It sits a row
          below the control cluster in the top-right so it never collides with it, and
          below the detail panel's z so an open panel covers it just like it covers the
          control bar (z 20 < seat 24 < panel 25). */}
      {!readOnly && (
        <div style={{ position: 'absolute', top: 'calc(var(--space-6) + 52px)', right: 'var(--space-6)', zIndex: 24 }}>
          <AccountSeat
            user={user}
            status={status}
            onSignIn={() => setSignInOpen(true)}
            onSignOut={signOut}
            onSettings={() => {}}
          />
        </div>
      )}

      {datasetSize === 'demo' && !readOnly && <TidinessBadge health={health} />}

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
        <aside className={`st-detail-panel ${selectedNode || feedVisible ? 'st-detail-panel--open' : ''}`}>
          {/* One dock, two tenants (design A′/A″): the feed is summoned over the canvas
              edge; selecting a fruit swaps in its details. Key toggle replays the swap. */}
          <div className="st-dock-tenant" key={selectedNode ? selectedNode.id : 'activity'}>
            {selectedNode ? (
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

      {readOnly && (
        <ForkDoor open={forkOpen} tablet={breakpoint === 'tablet'} stepCount={shareStats?.total} onClose={() => setForkOpen(false)} onSubmit={handleForkSubmit} />
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
        model={renderModel}
        title={tree?.title}
        stats={shareStats}
      />

      {loading && !loadError && <div className="st-loading">Planting the tree…</div>}
      {loadError && <div className="st-loading">Couldn’t load this roadmap. It may have moved, or the server is unreachable.</div>}
    </div>
  );
}
