// Orchestrator for the hand-rolled WebGL2 renderer: the GL context, the 2D camera, the node/connector batches and the DOM overlays above them.
import { BACKGROUND, NODE_SIZE, nodeTier, TIER_EMBER, TIER_COMPLETE, DEFAULT_NODE_COLOR } from '../theme.js';
import { SpatialGrid } from '../model/SpatialGrid.js';
import { CeremonyDirector } from '../ceremony/CeremonyDirector.js';
import { Camera2D } from './Camera2D.js';
import { NodeBatch } from './NodeBatch.js';
import { ConnectorBatch } from './ConnectorBatch.js';
import { IconAtlas } from './IconAtlas.js';
import { LabelOverlay, IconOverlay, ICON_DOM_START, ICON_DOM_FULL } from './NodeOverlay.js';
import { AffordanceLayer } from './AffordanceLayer.js';
import { ArrivalChevron } from './ArrivalChevron.js';
import { HoverLabel } from './HoverLabel.js';
import { EdgeChrome } from './EdgeChrome.js';
import { MarqueeOverlay } from './MarqueeOverlay.js';
import { ReorderSlot } from './ReorderSlot.js';
import { circularInsertionIndex, reorderPlan } from './input/reorderGeometry.js';
import { edgeKey } from './edgeKey.js';
import { createTextureFromCanvas } from './glcore.js';
import { InputController } from './input/InputController.js';
import { NavigateTool, ReadOnlyTool } from './input/tools.js';
import { track } from '../../../telemetry/beacon.js';

const SPATIAL_CELL_SIZE = NODE_SIZE * 2;
const PICK_RADIUS = NODE_SIZE * 0.65;
const TOUCH_HIT_RADIUS = 22; // screen px: read-only pick floor
const PAN_SETTLE_MS = 200;
const EDGE_PICK_RADIUS = 12; // screen px
const MAX_FRAME_DELTA = 0.1;
const ICON_ZOOM_START = 0.5;
const ICON_ZOOM_FULL = 1.1;
// Caps the fit zoom so a near-empty tree cannot balloon: the emphasised root reads at ~46px.
const FIT_MAX_ZOOM = 46 / (NODE_SIZE * 0.84 * 1.55);
const SETTLE_MS = 520;
const SETTLE_MIN_DELTA = 2; // world units
const SETTLE_STAGGER_MS = 120;
const AUTO_FRAME_IDLE_S = 2;
const AUTO_FRAME_EXPIRY_S = 10;
const AUTO_FRAME_MAX_ZOOM_OUT = 0.82;
const AUTO_FRAME_PAD = NODE_SIZE * 2; // world units

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class SkillTreeScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.readOnly = !!options.readOnly;

    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false });
    if (!gl) {
      track('webgl_init_fail');
      throw new Error('WebGL2 is not available');
    }
    this.gl = gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.clearColor = hexRgb(BACKGROUND.canvas);

    this.camera = new Camera2D();
    this.nodeBatch = new NodeBatch(gl);
    this.connectorBatch = new ConnectorBatch(gl);
    this.labelOverlay = new LabelOverlay(canvas);
    this.iconOverlay = new IconOverlay(canvas);
    this.hoverLabel = new HoverLabel(canvas);
    this.affordanceLayer = null;
    this.edgeChrome = null;
    this.marqueeOverlay = null;
    this.reorderSlot = null;
    this.reorder = null; // { id, radius, siblings, homeX, homeY }
    if (!this.readOnly) {
      this.marqueeOverlay = new MarqueeOverlay(canvas);
      this.reorderSlot = new ReorderSlot(canvas);
      this.affordanceLayer = new AffordanceLayer(canvas, {
        camera: this.camera,
        pick: (x, y) => this.pick(x, y),
        onCreate: (id) => this.options.onCreateChild && this.options.onCreateChild(id),
        onConnect: (sourceId, targetId) => this.options.onConnectNodes && this.options.onConnectNodes(sourceId, targetId),
        onReconnect: (oldFrom, oldTo, newFrom, newTo) => this.options.onReconnectEdge && this.options.onReconnectEdge(oldFrom, oldTo, newFrom, newTo),
        onFadeNodes: (ids) => this.nodeBatch.setFaded(ids),
        onRestoreNodes: () => this.nodeBatch.clearFaded(),
      });
      this.edgeChrome = new EdgeChrome(canvas, {
        onDeleteEdge: (from, to) => { this.selectEdge(null); if (this.options.onDeleteEdge) this.options.onDeleteEdge(from, to); },
        onReconnectStart: (edge, end, event) => this.affordanceLayer.connectGesture.startReconnect(edge, end, event),
      });
    }

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motion = this.motionQuery.matches ? 0 : 1;
    this.applyMotion = () => { this.motion = this.motionQuery.matches ? 0 : 1; };
    this.motionQuery.addEventListener('change', this.applyMotion);

    this.renderModel = null;
    this.nodesById = new Map();
    this.spatialGrid = null;
    this.iconAtlas = null;
    this.iconTexture = null;
    this.selectedId = null; // size<=1 projection of selectedIds
    this.selectedIds = new Set();
    this.hoveredId = null;
    this.selectedEdge = null;
    this.selectedEdges = new Set(); // edge keys
    this.hoveredEdge = null;
    this.lastArcs = new Map();

    this.viewportListeners = new Set();
    this.panning = false;
    this.panSettleTimer = null;
    this.running = false;
    this.elapsedSeconds = 0;
    this.lastFrameTime = null;
    this.rafHandle = null;
    this.overlaysDirty = false;

    this.director = new CeremonyDirector({
      nodes: this.nodeBatch,
      edges: this.connectorBatch,
      camera: this.camera,
      speak: (message, opts) => this.options.onCeremonyToast && this.options.onCeremonyToast(message, opts),
      clock: () => this.elapsedSeconds,
      motion: () => this.motion,
    });
    this.nodeStates = new Map(); // diff baseline
    this.arrivalNoun = 'Roadmap';
    this.arrivalSummaryOverride = null;
    this.arrivalToastSuppressed = false;
    this.returnRecap = null; // { sinceIds, summary } | null
    this.pendingSummary = null;
    this.pendingAction = null; // { label, run } | null
    this.settle = null; // { startAt, moves }
    this.pendingFrame = null; // { nodes, at }
    this.lastInputAt = 0;
    this.notePointer = () => { this.lastInputAt = this.elapsedSeconds; };
    canvas.addEventListener('pointermove', this.notePointer, { passive: true });
    this.arrivalChevron = new ArrivalChevron(canvas, {
      onReveal: (x, y) => {
        this.pendingFrame = null;
        this.director.yieldToInput();
        this.camera.glideTo(x, y);
      },
    });

    this.editTap = null;
    this.longPress = null;

    this.toolContext = {
      camera: this.camera,
      pick: (x, y) => this.pick(x, y),
      pickEdge: (x, y) => this.pickEdge(x, y),
      // A handler present consumes the tap by returning true; absent, false lets it through.
      editTap: (x, y) => this.editTap ? (this.editTap(x, y), true) : false,
      // Returning true makes the InputController swallow the lift, so no tap follows the hold.
      onLongPress: (id) => (id != null && this.longPress ? (this.longPress(id), true) : false),
      select: (id) => this.select(id),
      selectEdge: (edge) => { this.selectEdge(edge); this.options.onEdgePick?.(edge); },
      hover: (id) => this.hover(id),
      hoverEdge: (edge) => this.hoverEdge(edge),
      onInteract: () => {
        this.lastInputAt = this.elapsedSeconds;
        this.pendingFrame = null;
        this.director.yieldToInput();
        this.finishSettle();
      },
      onPan: () => this.reportPan(),
      press: (id) => this.setPress(id),
    };
    // Editor-only hooks: NavigateTool gates its marquee and reorder branches on their presence, and setReadOnly strips them.
    if (!this.readOnly) {
      this.toolContext.toggleSelect = (id) => this.toggleSelect(id);
      this.toolContext.toggleEdge = (edge) => this.toggleEdge(edge);
      this.toolContext.beginMarquee = (x0, y0) => this.marqueeOverlay?.show(x0, y0);
      this.toolContext.updateMarquee = (x0, y0, x1, y1) => this.updateMarquee(x0, y0, x1, y1);
      this.toolContext.cancelMarquee = () => { this.marqueeOverlay?.hide(); this.nodeBatch.setMarqueePreview(new Set()); };
      this.toolContext.commitMarquee = (x0, y0, x1, y1, additive) => this.commitMarquee(x0, y0, x1, y1, additive);
      this.toolContext.beginReorder = (id, sx, sy) => this.beginReorder(id, sx, sy);
      this.toolContext.updateReorder = (sx, sy) => this.updateReorder(sx, sy);
      this.toolContext.commitReorder = (sx, sy) => this.commitReorder(sx, sy);
      this.toolContext.cancelReorder = () => this.cancelReorder();
    }
    const tool = this.readOnly ? new ReadOnlyTool(this.toolContext) : new NavigateTool(this.toolContext);
    this.input = new InputController(canvas, this.toolContext, tool);

    this.resize();
    this.input.bind();
  }

  // ---- public API -----------------------------------------------------

  // Full load: fit the camera and clear selection.
  setModel(renderModel) {
    this.director.cancel();
    this.settle = null;
    this.pendingFrame = null;
    this.arrivalChevron.clear();
    this.nodeStates = new Map();
    this.lastArcs = new Map();
    this.installModel(renderModel);
    this.selectedId = null;
    this.hoveredId = null;
    this.selectedEdge = null;
    this.selectedEdges = new Set();
    this.fitToView();
    // Pre-dim before the first paint: a return-recap darkens only the steps it replays, any other first paint the whole tree.
    if (this.returnRecap) {
      const dimmed = new Map();
      for (const id of this.returnRecap.sinceIds) dimmed.set(id, 'locked');
      this.nodeBatch.setStates(dimmed);
      this.connectorBatch.setStates(dimmed, this.elapsedSeconds);
    } else if (this.arrivalLikely()) {
      const dimmed = new Map(renderModel.nodes.map((node) => [node.id, 'locked']));
      this.nodeBatch.setStates(dimmed);
      this.connectorBatch.setStates(dimmed, this.elapsedSeconds);
    }
  }

  // A re-derived model, keeping the camera and any still-present selection; a selected edge survives only if the new model carries it.
  applyModel(renderModel) {
    const previous = this.nodesById;
    const selected = this.selectedId;
    const hovered = this.hoveredId;
    const selectedEdge = this.selectedEdge;
    this.installModel(renderModel);
    this.selectedId = this.nodesById.has(selected) ? selected : null;
    this.selectedIds = new Set([...this.selectedIds].filter((id) => this.nodesById.has(id)));
    this.hoveredId = this.nodesById.has(hovered) ? hovered : null;
    this.selectedEdge = selectedEdge
      ? renderModel.edges.find((edge) => edge.from === selectedEdge.from && edge.to === selectedEdge.to) ?? null
      : null;
    const survivingEdges = new Set(renderModel.edges.map((edge) => edgeKey(edge.from, edge.to)));
    this.selectedEdges = new Set([...this.selectedEdges].filter((key) => survivingEdges.has(key)));
    this.connectorBatch.setSelectedEdges(this.selectedEdges);
    this.connectorBatch.setInSetEdges(this.selectedIds);
    // The node highlight tracks the SET, not the size<=1 projection: a mixed node+edge selection has one node with selectedId null.
    if (this.readOnly) {
      if (this.selectedIds.size > 0) this.nodeBatch.setSelectedSet(this.selectedIds);
      else this.nodeBatch.setSelected(this.hoveredId ?? this.selectedId);
    } else this.nodeBatch.setSelectedSet(this.selectedIds);
    this.affordanceLayer?.setSelected(this.selectedId);
    this.hoverLabel.setHovered(this.hoveredId);
    this.edgeChrome?.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
    const arrivals = renderModel.nodes.filter((node) => !previous.has(node.id));
    this.beginSettle(previous, arrivals);
    this.noteArrivals(arrivals);
  }

  isPointerActive() {
    return this.input.activePointerId !== null;
  }

  // Retire editing in place: the viewer tool takes the pointer, the edit chrome is disposed, the camera never moves.
  setReadOnly() {
    if (this.readOnly) return;
    this.readOnly = true;
    this.input.setTool(new ReadOnlyTool(this.toolContext));
    this.selectEdge(null);
    this.hoverEdge(null);
    // Clear the set directly — setSelectedSet no-ops in read-only — so the highlight repaints to selectedId.
    this.selectedIds = new Set();
    this.selectedEdges = new Set();
    this.connectorBatch.setSelectedEdges(this.selectedEdges);
    this.refreshHighlight();
    delete this.toolContext.toggleSelect;
    delete this.toolContext.toggleEdge;
    delete this.toolContext.beginMarquee;
    delete this.toolContext.updateMarquee;
    delete this.toolContext.cancelMarquee;
    delete this.toolContext.commitMarquee;
    delete this.toolContext.beginReorder;
    delete this.toolContext.updateReorder;
    delete this.toolContext.commitReorder;
    delete this.toolContext.cancelReorder;
    this.cancelReorder();
    this.marqueeOverlay?.dispose();
    this.marqueeOverlay = null;
    this.reorderSlot?.dispose();
    this.reorderSlot = null;
    this.affordanceLayer?.clear();
    const retiring = [this.affordanceLayer, this.edgeChrome].filter(Boolean);
    this.affordanceLayer = null;
    this.edgeChrome = null;
    for (const layer of retiring) {
      layer.container.style.transition = 'opacity 280ms var(--ease-standard)';
      layer.container.style.opacity = '0';
      layer.container.style.pointerEvents = 'none';
      setTimeout(() => layer.dispose(), 280);
    }
    if (this.renderModel) this.camera.setPanBounds(this.renderModel.bounds);
  }

  // Glide every displaced node to its new seat; an in-flight settle retargets, and brand-new nodes never glide in.
  beginSettle(previous, arrivals) {
    this.settle = null;
    if (this.motion === 0) return;
    const moves = [];
    for (const node of this.renderModel.nodes) {
      const before = previous.get(node.id);
      if (!before) continue;
      if (Math.hypot(node.x - before.x, node.y - before.y) < SETTLE_MIN_DELTA) continue;
      moves.push({ id: node.id, fromX: before.x, fromY: before.y, toX: node.x, toY: node.y, delayMs: 0 });
    }
    if (moves.length === 0) return;

    const anchor = centroid(arrivals.length > 0 ? arrivals : moves.map((move) => ({ x: move.toX, y: move.toY })));
    moves.sort((a, b) => Math.hypot(a.toX - anchor.x, a.toY - anchor.y) - Math.hypot(b.toX - anchor.x, b.toY - anchor.y));
    moves.forEach((move, index) => { move.delayMs = (SETTLE_STAGGER_MS * index) / Math.max(1, moves.length - 1); });

    for (const move of moves) this.moveNode(move.id, move.fromX, move.fromY);
    this.settle = { startAt: this.elapsedSeconds, moves };
  }

  advanceSettle() {
    const elapsedMs = (this.elapsedSeconds - this.settle.startAt) * 1000;
    let settling = false;
    for (const move of this.settle.moves) {
      const t = (elapsedMs - move.delayMs) / SETTLE_MS;
      if (t < 0) { settling = true; continue; }
      const eased = t >= 1 ? 1 : easeInOutCubic(t);
      this.moveNode(move.id, move.fromX + (move.toX - move.fromX) * eased, move.fromY + (move.toY - move.fromY) * eased);
      if (t < 1) settling = true;
    }
    if (!settling) this.settle = null;
  }

  finishSettle() {
    if (!this.settle) return;
    for (const move of this.settle.moves) this.moveNode(move.id, move.toX, move.toY);
    this.settle = null;
  }

  // Births outside the viewport never move the camera: the chevron points the way and one idle auto-frame may follow.
  noteArrivals(arrivals) {
    if (arrivals.length === 0) return;
    const viewport = this.camera.getViewport();
    const offscreen = arrivals.filter((node) =>
      node.x < viewport.minX || node.x > viewport.maxX || node.y < viewport.minY || node.y > viewport.maxY);
    if (offscreen.length === 0) return;
    this.arrivalChevron.announce(offscreen);
    this.pendingFrame = { nodes: offscreen, at: this.elapsedSeconds };
  }

  maybeAutoFrame() {
    if (this.elapsedSeconds - this.pendingFrame.at > AUTO_FRAME_EXPIRY_S) { this.pendingFrame = null; return; }
    if (this.settle || this.camera.isGliding()) return;
    if (this.motion === 0 || this.selectedId !== null) return;
    if (this.elapsedSeconds - this.lastInputAt < AUTO_FRAME_IDLE_S) return;

    const viewport = this.camera.getViewport();
    let minX = viewport.minX;
    let maxX = viewport.maxX;
    let minY = viewport.minY;
    let maxY = viewport.maxY;
    for (const node of this.pendingFrame.nodes) {
      minX = Math.min(minX, node.x - AUTO_FRAME_PAD);
      maxX = Math.max(maxX, node.x + AUTO_FRAME_PAD);
      minY = Math.min(minY, node.y - AUTO_FRAME_PAD);
      maxY = Math.max(maxY, node.y + AUTO_FRAME_PAD);
    }
    const required = Math.min(this.camera.viewportWidth / (maxX - minX), this.camera.viewportHeight / (maxY - minY));
    const zoom = Math.min(Math.max(required, this.camera.zoom * AUTO_FRAME_MAX_ZOOM_OUT), this.camera.zoom);
    this.camera.glideTo((minX + maxX) / 2, (minY + maxY) / 2, zoom);
    this.pendingFrame = null;
  }

  installModel(renderModel) {
    this.renderModel = renderModel;
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = new SpatialGrid(renderModel.nodes, SPATIAL_CELL_SIZE);
    this.hoveredEdge = null;

    this.syncIconAtlas(renderModel.nodes);
    this.nodeBatch.setInstances(renderModel.nodes, this.iconAtlas);
    this.nodeBatch.setArcs(this.lastArcs, this.elapsedSeconds);
    this.connectorBatch.setModel(renderModel);
    this.labelOverlay.setModel(renderModel, this.spatialGrid);
    this.iconOverlay.setModel(renderModel, this.spatialGrid);
    this.hoverLabel.setModel(renderModel);
    this.affordanceLayer?.setModel(renderModel);
    this.edgeChrome?.setModel(renderModel);
    if (this.readOnly) this.camera.setPanBounds(renderModel.bounds);
  }

  // The first push paints the resting look silently; later pushes diff against it.
  applyStates(statesMap) {
    this.iconOverlay.setStates(statesMap);

    // A stopped scene must never arm the director: the settle poll would spin on a frozen clock and burst stale beats on resume.
    if (!this.running) {
      this.nodeStates = new Map(statesMap);
      this.nodeBatch.setStates(statesMap);
      this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
      this.pendingSummary = null;
      this.pendingAction = null;
      return;
    }

    if (this.nodeStates.size === 0) {
      if (this.returnRecap) { this.playReturnRecap(statesMap); return; }
      this.nodeStates = new Map(statesMap);
      if (this.shouldAnimateArrival(statesMap)) { this.playArrival(statesMap); return; }
      this.nodeBatch.setStates(statesMap);
      this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
      return;
    }

    const changeset = this.buildChangeset(statesMap);
    for (const fall of changeset.fell) this.nodeBatch.igniteNode(fall.id, this.elapsedSeconds, fall.toTier, { durationMs: 280, blossom: false });
    if (changeset.fell.length > 0) this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
    this.nodeStates = new Map(statesMap);

    changeset.summary = this.pendingSummary;
    changeset.action = this.pendingAction;
    this.pendingSummary = null;
    this.pendingAction = null;
    this.director.celebrate(changeset);
  }

  // A rise into ember is applied here as a quiet kindle and kept out of `risen`, so the director never celebrates a start.
  buildChangeset(statesMap) {
    const risen = [];
    const fell = [];
    const completedNow = new Set();
    for (const [id, state] of statesMap) {
      const from = this.nodeStates.get(id) ?? 'locked';
      const toTier = nodeTier(state);
      const fromTier = nodeTier(from);
      const node = this.nodesById.get(id);
      if (toTier > fromTier && node) {
        if (state === 'active') this.kindle(id);
        else risen.push({ id, fromTier, toTier, x: node.x, y: node.y });
      } else if (toTier < fromTier) {
        fell.push({ id, toTier });
      }
      if (state === 'complete' && from !== 'complete') completedNow.add(id);
    }

    const risenById = new Map(risen.map((r) => [r.id, r]));
    const litEdges = [];
    const wakeByEdge = {};
    if (completedNow.size > 0) {
      for (const edge of this.renderModel.edges) {
        if (!completedNow.has(edge.from)) continue;
        litEdges.push({ from: edge.from, to: edge.to });
        const child = risenById.get(edge.to);
        if (child) wakeByEdge[`${edge.from}|${edge.to}`] = child;
      }
    }

    const frontier = risen.filter((r) => r.toTier === 1).map((r) => r.id);
    const focusNode = risen.find((r) => r.toTier === TIER_COMPLETE) ?? risen[0] ?? null;
    const focus = focusNode ? { x: focusNode.x, y: focusNode.y } : null;
    return { focus, risen, fell, litEdges, wakeByEdge, frontier, summary: null, action: null };
  }

  // Kindle the ember directly: no camera glide, light-travel, pulse or toast, and kept out of the changeset.
  kindle(id) {
    this.nodeBatch.igniteNode(id, this.elapsedSeconds, TIER_EMBER, { blossom: false, durationMs: 480 });
  }

  announceCeremony(summary, opts = {}) {
    this.pendingSummary = summary;
    this.pendingAction = opts.action ?? null;
  }

  // arcMap is Map<nodeId, fraction in [0,1]>; a node absent from it shows no arc.
  setArcs(arcMap) {
    this.lastArcs = arcMap;
    this.nodeBatch.setArcs(arcMap, this.elapsedSeconds);
  }

  // ---- arrival cascade --------------------------------------------------

  arrivalLikely() {
    return !!this.renderModel && this.renderModel.nodes.length >= 2;
  }

  shouldAnimateArrival(statesMap) {
    if (!this.arrivalLikely()) return false;
    for (const state of statesMap.values()) if (nodeTier(state) >= 1) return true;
    return false;
  }

  playArrival(statesMap) {
    const dimmed = new Map();
    for (const id of statesMap.keys()) dimmed.set(id, 'locked');
    this.nodeBatch.setStates(dimmed);
    this.connectorBatch.setStates(dimmed, this.elapsedSeconds);
    this.director.arrival(this.buildArrivalPlan(statesMap));
  }

  // Depth rings by BFS from the crowned root(s); each node carries its resting tier.
  buildArrivalPlan(statesMap) {
    const nodes = this.renderModel.nodes;
    const children = new Map();
    for (const edge of this.renderModel.edges) {
      if (!children.has(edge.from)) children.set(edge.from, []);
      children.get(edge.from).push(edge.to);
    }
    const depth = new Map();
    const queue = [];
    for (const node of nodes) if (node.emphasis === 1) { depth.set(node.id, 0); queue.push(node.id); }
    if (queue.length === 0 && nodes.length > 0) { depth.set(nodes[0].id, 0); queue.push(nodes[0].id); }
    for (let i = 0; i < queue.length; i += 1) {
      const next = depth.get(queue[i]) + 1;
      for (const child of children.get(queue[i]) ?? []) if (!depth.has(child)) { depth.set(child, next); queue.push(child); }
    }
    let maxDepth = 0;
    for (const node of nodes) { if (!depth.has(node.id)) depth.set(node.id, 0); maxDepth = Math.max(maxDepth, depth.get(node.id)); }

    const rings = Array.from({ length: maxDepth + 1 }, () => []);
    for (const node of nodes) rings[depth.get(node.id)].push({ id: node.id, tier: nodeTier(statesMap.get(node.id) ?? 'locked'), x: node.x, y: node.y });
    const litEdgesByRing = Array.from({ length: maxDepth + 1 }, () => []);
    for (const edge of this.renderModel.edges) {
      if ((statesMap.get(edge.from) ?? 'locked') === 'complete') litEdgesByRing[depth.get(edge.from) ?? 0].push({ from: edge.from, to: edge.to });
    }
    let done = 0;
    for (const state of statesMap.values()) if (state === 'complete') done += 1;
    const defaultSummary = `${this.arrivalNoun} planted · ${nodes.length} steps${done > 0 ? ` · ${done} already done` : ''}`;
    const summary = this.arrivalToastSuppressed ? null : (this.arrivalSummaryOverride ?? defaultSummary);
    this.arrivalToastSuppressed = false;
    this.arrivalSummaryOverride = null;
    return { rings, litEdgesByRing, summary };
  }

  // Replay the steps completed since the last visit: the since-nodes are painted back down to locked and the growth ceremony blooms them. One-shot.
  playReturnRecap(statesMap) {
    const recap = this.returnRecap;
    this.returnRecap = null;
    const priorStates = new Map(statesMap);
    for (const id of recap.sinceIds) if (priorStates.has(id)) priorStates.set(id, 'locked');
    this.nodeBatch.setStates(priorStates);
    this.connectorBatch.setStates(priorStates, this.elapsedSeconds);
    this.nodeStates = priorStates;

    const changeset = this.buildChangeset(statesMap);
    this.nodeStates = new Map(statesMap);

    // The director reads e.wave: depth within the since-only subgraph orders the replay parent->child.
    const depth = this.sinceDepths(recap.sinceIds);
    for (const edge of changeset.litEdges) edge.wave = depth.get(edge.from) ?? 0;

    changeset.summary = recap.summary;
    this.director.celebrate(changeset);
  }

  // Longest-path depth of each since-node within the since-only subgraph; 0 for a cascade root.
  sinceDepths(sinceIds) {
    const edges = this.renderModel.edges.filter((e) => sinceIds.has(e.from) && sinceIds.has(e.to));
    const depth = new Map();
    for (const id of sinceIds) depth.set(id, 0);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of edges) {
        const next = depth.get(e.from) + 1;
        if (next > depth.get(e.to)) { depth.set(e.to, next); changed = true; }
      }
    }
    return depth;
  }

  setArrivalNoun(noun) {
    this.arrivalNoun = noun;
  }

  setArrivalSummary(text) { this.arrivalSummaryOverride = text; }
  suppressArrivalToast() { this.arrivalToastSuppressed = true; }

  // Armed before the model installs: the first applyStates push replays these ids.
  armReturnRecap(sinceIds, summary) { this.returnRecap = { sinceIds: new Set(sinceIds), summary }; }

  moveNode(id, x, y) {
    const node = this.nodesById.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    this.nodeBatch.moveInstance(id, x, y);
    this.connectorBatch.moveNode(id, x, y);
    this.spatialGrid.move(id, x, y);
    this.overlaysDirty = true;
  }

  previewKind(id, kind) { this.nodeBatch.setColor(id, kind); }
  restoreKind(id) { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); }
  previewDeleteCost(id) { this.nodeBatch.setFaded(new Set([id])); }
  clearDeleteCost() { this.nodeBatch.clearFaded(); }

  previewKindSet(ids, kind) { for (const id of ids) this.nodeBatch.setColor(id, kind); }
  restoreKindSet(ids) { for (const id of ids) { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); } }
  previewDeleteCostSet(ids) { this.nodeBatch.setFaded(new Set(ids)); }
  setFaded(ids) { this.nodeBatch.setFaded(ids); }
  clearFaded() { this.nodeBatch.clearFaded(); }

  fitToView() {
    if (!this.renderModel) return;
    this.camera.fitToView(this.renderModel.bounds, this.camera.viewportWidth, this.camera.viewportHeight, 0.9, FIT_MAX_ZOOM);
  }

  getViewpoint() { return { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom }; }
  restoreViewpoint({ x, y, zoom }) { this.camera.restore(x, y, zoom); }

  focusNode(id) {
    const node = this.nodesById.get(id);
    if (!node) return;
    this.selectedId = id;
    this.selectedIds = new Set([id]);
    this.nodeBatch.setSelected(id);
    this.camera.focus(node.x, node.y);
  }

  panTo(x, y) { this.camera.panTo(x, y); }
  zoomBy(factor) { this.camera.zoomBy(factor); }

  frameNodes(ids) {
    const points = [];
    for (const id of ids) {
      const node = this.nodesById.get(id);
      if (node) points.push(node);
    }
    if (!points.length) return;
    const cx = points.reduce((sum, node) => sum + node.x, 0) / points.length;
    const cy = points.reduce((sum, node) => sum + node.y, 0) / points.length;
    this.camera.focus(cx, cy);
  }

  // Debounced pan signal: one `true` on a gesture’s first move, one `false` ~200ms after the last.
  reportPan() {
    if (!this.options.onPanStateChange) return;
    if (!this.panning) { this.panning = true; this.options.onPanStateChange(true); }
    clearTimeout(this.panSettleTimer);
    this.panSettleTimer = setTimeout(() => {
      this.panning = false;
      this.options.onPanStateChange(false);
    }, PAN_SETTLE_MS);
  }

  // ---- activity feed hooks ----------------------------------------------

  pulseNode(id) { this.nodeBatch.pulse(id, this.elapsedSeconds); }

  // Light one node + its branches and dim the rest; null restores the resting look.
  spotlightNode(id) {
    if (id == null) {
      this.nodeBatch.clearFaded();
      this.connectorBatch.setSpotlight(null);
      this.refreshHighlight();
      return;
    }
    const rest = new Set();
    for (const nodeId of this.nodesById.keys()) if (nodeId !== id) rest.add(nodeId);
    this.nodeBatch.setFaded(rest);
    this.nodeBatch.setSelected(id);
    this.connectorBatch.setSpotlight(id);
  }

  // Hold every node of one kind and fade the rest; null clears back to the resting look.
  highlightKind(hue) {
    if (hue == null) {
      this.nodeBatch.clearFaded();
      this.connectorBatch.setSpotlight(null);
      this.refreshHighlight();
      return;
    }
    const rest = new Set();
    for (const [id, node] of this.nodesById) if ((node.color ?? DEFAULT_NODE_COLOR) !== hue) rest.add(id);
    this.nodeBatch.setFaded(rest);
  }

  revealNode(id) {
    const node = this.nodesById.get(id);
    if (node) this.camera.glideTo(node.x, node.y);
  }

  // Fires now with the current viewport and again on every frame the camera moves; returns an unsubscribe.
  subscribeViewport = (listener) => {
    this.viewportListeners.add(listener);
    listener(this.getViewport());
    return () => this.viewportListeners.delete(listener);
  };

  getBounds() { return this.renderModel ? this.renderModel.bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }
  getViewport() { return this.camera.getViewport(); }

  // World -> screen pixels, so a DOM overlay can anchor itself to a node across pan/zoom.
  projectToScreen(worldX, worldY) {
    return {
      x: (worldX - this.camera.x) * this.camera.zoom + this.camera.viewportWidth / 2,
      y: (worldY - this.camera.y) * this.camera.zoom + this.camera.viewportHeight / 2,
    };
  }

  settleProgress() { return this.camera.settleProgress(); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.camera.resize(width, height);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = null;
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  // Answered from the director, not `running`: a paused scene still runs its beats on plain timers.
  ceremonyBusy() { return this.director.busy(); }

  stop() {
    this.running = false;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  dispose() {
    this.stop();
    this.director.cancel();
    this.input.unbind();
    clearTimeout(this.panSettleTimer);
    this.motionQuery.removeEventListener('change', this.applyMotion);
    this.canvas.removeEventListener('pointermove', this.notePointer);
    this.nodeBatch.dispose();
    this.connectorBatch.dispose();
    this.labelOverlay.dispose();
    this.iconOverlay.dispose();
    this.hoverLabel.dispose();
    this.arrivalChevron.dispose();
    this.affordanceLayer?.dispose();
    this.edgeChrome?.dispose();
    this.marqueeOverlay?.dispose();
    if (this.iconTexture) this.gl.deleteTexture(this.iconTexture);
  }

  // ---- render loop ------------------------------------------------------

  tick = (now) => {
    if (!this.running) return;
    if (this.lastFrameTime === null) this.lastFrameTime = now;
    const dt = Math.min((now - this.lastFrameTime) / 1000, MAX_FRAME_DELTA);
    this.lastFrameTime = now;
    this.elapsedSeconds += dt;
    if (this.settle) this.advanceSettle();
    if (this.pendingFrame) this.maybeAutoFrame();

    const moved = this.camera.update(dt);
    if (moved || this.overlaysDirty) {
      this.labelOverlay.update(this.camera);
      this.iconOverlay.update(this.camera);
      this.hoverLabel.update(this.camera);
      this.arrivalChevron.update(this.camera);
      this.affordanceLayer?.update(this.camera);
      this.edgeChrome?.update(this.camera);
      this.overlaysDirty = false;
    }
    if (moved) this.viewportListeners.forEach((listener) => listener(this.getViewport()));

    const gl = this.gl;
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.connectorBatch.draw(this.camera, this.elapsedSeconds, this.motion);
    const zoom = this.camera.zoom;
    const iconOpacity = smoothstep(zoom, ICON_ZOOM_START, ICON_ZOOM_FULL) * (1 - smoothstep(zoom, ICON_DOM_START, ICON_DOM_FULL));
    this.nodeBatch.draw(this.camera, this.elapsedSeconds, this.motion, iconOpacity);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  // ---- icon atlas -------------------------------------------------------

  syncIconAtlas(nodes) {
    if (this.iconAtlas && nodes.every((node) => this.iconAtlas.cellFor(node.icon) >= 0)) return;
    this.buildIconAtlas(nodes);
  }

  buildIconAtlas(nodes) {
    const gl = this.gl;
    if (this.iconTexture) gl.deleteTexture(this.iconTexture);
    this.iconAtlas = new IconAtlas(nodes.map((node) => node.icon));
    this.iconTexture = createTextureFromCanvas(gl, this.iconAtlas.canvas);
    this.nodeBatch.setIconAtlas(this.iconTexture, this.iconAtlas.cols, this.iconAtlas.rows);
    this.iconAtlas.onReady(() => {
      gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.iconAtlas.canvas);
      gl.bindTexture(gl.TEXTURE_2D, null);
    });
  }

  // ---- scene-state hooks the active tool drives -------------------------

  // select() drives selection from the canvas and notifies the shell; setSelection() mirrors one the shell already made, without clearing the edge or echoing back.
  select(id) {
    this.selectedIds = id ? new Set([id]) : new Set();
    this.setSelection(id);
    this.refreshHighlight();
    this.selectEdge(null);
    if (this.options.onNodePick) this.options.onNodePick(id);
  }

  // Drives only the GPU highlight; the single-select chrome still tracks selectedId.
  setSelectedSet(idSet) {
    this.selectedIds = idSet;
    this.refreshHighlight();
  }

  toggleSelect(id) {
    if (this.options.onSelectionToggle) this.options.onSelectionToggle(id);
  }

  // Mirror the edge multi-selection into the connector highlight; EdgeChrome is driven separately via selectEdge.
  setSelectedEdges(keySet) {
    if (this.readOnly) return;
    this.selectedEdges = keySet;
    this.connectorBatch.setSelectedEdges(keySet);
  }

  toggleEdge(edge) {
    if (this.options.onEdgeToggle) this.options.onEdgeToggle(edge);
  }

  // The enclosure must stay the same node-centre test commitMarquee uses, or preview and commit disagree.
  updateMarquee(x0, y0, x1, y1) {
    this.marqueeOverlay?.update(x0, y0, x1, y1);
    if (!this.spatialGrid) return;
    const a = this.camera.screenToWorld(x0, y0);
    const b = this.camera.screenToWorld(x1, y1);
    const ids = this.spatialGrid.within(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    this.nodeBatch.setMarqueePreview(new Set(ids));
  }

  commitMarquee(x0, y0, x1, y1, additive) {
    this.marqueeOverlay?.hide();
    this.nodeBatch.setMarqueePreview(new Set());
    if (!this.spatialGrid) return;
    const a = this.camera.screenToWorld(x0, y0);
    const b = this.camera.screenToWorld(x1, y1);
    const ids = this.spatialGrid.within(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    if (this.options.onMarqueeSelect) this.options.onMarqueeSelect(ids, additive);
  }

  // ---- Angular reorder ----------------------------------------------------
  // The view supplies the siblings and their order keys via reorderContext; the scene reports the chosen fractional key through onSetNodeOrder on release.
  beginReorder(id, sx, sy) {
    const node = this.nodesById.get(id);
    const context = this.options.reorderContext?.(id);
    if (!node || !context) { this.reorder = null; return; }
    const siblings = context.siblings
      .filter((s) => s.id !== id)
      .map((s) => { const n = this.nodesById.get(s.id); return n ? { id: s.id, order: s.order, x: n.x, y: n.y } : null; })
      .filter(Boolean);
    if (siblings.length === 0) { this.reorder = null; return; }
    this.finishSettle(); // land any in-flight glide first
    this.reorder = { id, radius: Math.hypot(node.x, node.y), siblings, homeX: node.x, homeY: node.y };
    this.nodeBatch.setMarqueePreview(new Set([id]));
    this.reorderSlot?.show();
    this.updateReorder(sx, sy);
  }

  updateReorder(sx, sy) {
    if (!this.reorder) return;
    const { id, radius, siblings } = this.reorder;
    const world = this.camera.screenToWorld(sx, sy);
    const angle = Math.atan2(world.y, world.x);
    this.moveNode(id, radius * Math.cos(angle), radius * Math.sin(angle)); // arc: radius pinned
    const index = circularInsertionIndex(siblings.map((s) => Math.atan2(s.y, s.x)), angle);
    const slot = this.slotAngle(siblings, index);
    const screen = this.camera.worldToScreen(radius * Math.cos(slot), radius * Math.sin(slot));
    this.reorderSlot?.moveTo(screen.x, screen.y, 1.3 * NODE_SIZE * this.camera.zoom);
  }

  commitReorder(sx, sy) {
    if (!this.reorder) return;
    const { id, siblings } = this.reorder;
    const plan = reorderPlan(siblings, this.camera.screenToWorld(sx, sy));
    this.clearReorder();
    if (plan) this.options.onSetNodeOrder?.(id, plan.key);
  }

  cancelReorder() {
    if (!this.reorder) return;
    const { id, homeX, homeY } = this.reorder;
    this.clearReorder();
    this.moveNode(id, homeX, homeY); // no dispatch: snap back to the seat it left
  }

  clearReorder() {
    this.nodeBatch.setMarqueePreview(new Set());
    this.reorderSlot?.hide();
    this.reorder = null;
  }

  // The angle of the insertion slot at `index`: the midpoint of the gap the node drops into, the ends borrowing half the wrap gap.
  slotAngle(siblings, index) {
    const TAU = Math.PI * 2;
    const norm = (a) => ((a % TAU) + TAU) % TAU;
    const m = siblings.length;
    const ang = siblings.map((s) => Math.atan2(s.y, s.x));
    if (m === 1) return index === 0 ? ang[0] - 0.3 : ang[0] + 0.3;
    const wrap = norm(ang[0] - ang[m - 1]);
    if (index === 0) return norm(ang[0] - wrap / 2);
    if (index === m) return norm(ang[m - 1] + wrap / 2);
    return norm(ang[index - 1] + norm(ang[index] - ang[index - 1]) / 2);
  }

  setSelection(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.affordanceLayer?.setSelected(id);
    this.overlaysDirty = true;
    this.refreshHighlight();
  }

  selectEdge(edge) {
    if (edge && this.selectedIds.size > 0) this.select(null);
    this.selectedEdge = edge ?? null;
    this.edgeChrome?.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
  }

  // The shell must drive the single-edge projection through here: selectEdge would fire a node-clear off lagging scene state and wipe a still-selected edge.
  projectEdge(edge) {
    this.selectedEdge = edge ?? null;
    this.edgeChrome?.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
  }

  hover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.hoverLabel.setHovered(id);
    this.nodeBatch.setHover(id, this.elapsedSeconds);
    this.overlaysDirty = true;
    if (this.options.onNodeHover) this.options.onNodeHover(id);
  }

  setPress(id) { this.nodeBatch.setPress(id, this.elapsedSeconds); }

  // null restores the tool’s default select.
  setEditTap(fn) { this.editTap = fn; }

  // null disarms the hold.
  setLongPress(fn) { this.longPress = fn; }

  hoverEdge(edge) {
    const next = edge ?? null;
    if (next === this.hoveredEdge) return;
    this.hoveredEdge = next;
    this.connectorBatch.setHovered(next);
    this.canvas.style.cursor = next ? 'pointer' : '';
  }

  refreshHighlight() {
    if (this.readOnly) {
      if (this.selectedIds.size > 0) this.nodeBatch.setSelectedSet(this.selectedIds);
      else this.nodeBatch.setSelected(this.selectedId);
      this.connectorBatch.setInSetEdges(this.selectedIds);
      return;
    }
    this.nodeBatch.setSelectedSet(this.selectedIds);
    this.connectorBatch.setInSetEdges(this.selectedIds);
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.camera.screenToWorld(x, y);
    const radius = this.readOnly ? Math.max(PICK_RADIUS, TOUCH_HIT_RADIUS / this.camera.zoom) : PICK_RADIUS;
    return this.spatialGrid.nearest(world.x, world.y, radius);
  }

  // Nearest branch to the cursor within EDGE_PICK_RADIUS, or null; only meaningful off-node.
  pickEdge(sx, sy) {
    if (!this.renderModel) return null;
    const world = this.camera.screenToWorld(sx, sy);
    const maxDist = EDGE_PICK_RADIUS / this.camera.zoom;
    let best = null;
    let bestDist = maxDist;
    for (const edge of this.renderModel.edges) {
      const from = this.nodesById.get(edge.from);
      const to = this.nodesById.get(edge.to);
      if (!from || !to) continue; // an edge can briefly outrun its endpoints mid-rebuild
      const d = distanceToSegment(world.x, world.y, from.x, from.y, to.x, to.y);
      if (d < bestDist) { bestDist = d; best = edge; }
    }
    return best;
  }
}

function smoothstep(x, edge0, edge1) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const point of points) { x += point.x; y += point.y; }
  return { x: x / points.length, y: y / points.length };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
