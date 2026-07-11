// Orchestrator for the hand-rolled WebGL2 renderer: owns the GL context, the 2D
// camera, and the node/connector batches. The rAF loop only advances time and
// the camera; geometry is uploaded once per model and mutated in place on state
// change. Picking reuses the domain SpatialGrid. Public API is unchanged so the
// React shell above is renderer-agnostic.
import { BACKGROUND, NODE_SIZE, nodeTier } from '../theme.js';
import { SpatialGrid } from '../model/SpatialGrid.js';
import { CeremonyDirector } from '../ceremony/CeremonyDirector.js';
import { Camera2D } from './Camera2D.js';
import { NodeBatch } from './NodeBatch.js';
import { ConnectorBatch } from './ConnectorBatch.js';
import { IconAtlas } from './IconAtlas.js';
import { LabelOverlay, IconOverlay, ICON_DOM_START, ICON_DOM_FULL } from './NodeOverlay.js';
import { AffordanceLayer } from './AffordanceLayer.js';
import { HoverLabel } from './HoverLabel.js';
import { EdgeChrome } from './EdgeChrome.js';
import { createTextureFromCanvas } from './glcore.js';
import { InputController } from './input/InputController.js';
import { MoveTool } from './input/tools.js';

const SPATIAL_CELL_SIZE = NODE_SIZE * 2;
const PICK_RADIUS = NODE_SIZE * 0.65;
const EDGE_PICK_RADIUS = 12; // screen px tolerance for hovering a branch
const MAX_FRAME_DELTA = 0.1;
const ICON_ZOOM_START = 0.5;
const ICON_ZOOM_FULL = 1.1;
const ARRIVAL_MAX = 120; // above this a fresh model paints at rest — no plant cascade (the 5k perf tree)

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class SkillTreeScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;

    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
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

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.motion = this.motionQuery.matches ? 0 : 1;
    this.applyMotion = () => { this.motion = this.motionQuery.matches ? 0 : 1; };
    this.motionQuery.addEventListener('change', this.applyMotion);

    this.renderModel = null;
    this.nodesById = new Map();
    this.spatialGrid = null;
    this.iconAtlas = null;
    this.iconTexture = null;
    this.selectedId = null;
    this.hoveredId = null;
    this.selectedEdge = null;
    this.hoveredEdge = null;

    this.viewportListeners = new Set();
    this.running = false;
    this.elapsedSeconds = 0;
    this.lastFrameTime = null;
    this.rafHandle = null;
    this.overlaysDirty = false;

    // The one ceremony scheduler: it composes the growth "sentence" and yields to
    // any canvas grab. It reaches growth only through the batches/camera and never
    // owns GL state. The scene diffs states into changesets and hands them here.
    this.director = new CeremonyDirector({
      nodes: this.nodeBatch,
      edges: this.connectorBatch,
      camera: this.camera,
      speak: (message, opts) => this.options.onCeremonyToast && this.options.onCeremonyToast(message, opts),
      clock: () => this.elapsedSeconds,
      motion: () => this.motion,
    });
    this.nodeStates = new Map(); // last states pushed — the diff baseline
    this.pendingSummary = null; // the toast the next ceremony speaks (set by the shell)
    this.pendingHasAction = false;

    this.toolContext = {
      camera: this.camera,
      pick: (x, y) => this.pick(x, y),
      pickEdge: (x, y) => this.pickEdge(x, y),
      getNode: (id) => this.nodesById.get(id),
      select: (id) => this.select(id),
      selectEdge: (edge) => this.selectEdge(edge),
      hover: (id) => this.hover(id),
      hoverEdge: (edge) => this.hoverEdge(edge),
      moveNode: (id, x, y) => this.moveNode(id, x, y),
      endMove: (id) => this.endMove(id),
      onInteract: () => this.director.yieldToInput(),
      press: (id) => this.setPress(id),
    };
    this.input = new InputController(canvas, this.toolContext, new MoveTool(this.toolContext));

    this.resize();
    this.input.bind();
  }

  // ---- public API -----------------------------------------------------

  // Full load: fit the camera and clear selection. Used for first paint and
  // dataset swaps.
  setModel(renderModel) {
    this.director.cancel();
    this.nodeStates = new Map(); // a fresh dataset re-baselines: the next applyStates plants or paints
    this.installModel(renderModel);
    this.selectedId = null;
    this.hoveredId = null;
    this.selectedEdge = null;
    this.fitToView();
    // Pre-dim before the first paint so the plant cascade doesn't flash the resting tree first.
    if (this.arrivalLikely()) {
      const dimmed = new Map(renderModel.nodes.map((node) => [node.id, 'locked']));
      this.nodeBatch.setStates(dimmed);
      this.connectorBatch.setStates(dimmed, this.elapsedSeconds);
    }
  }

  // Apply a re-derived model (add/remove/reconnect/relayout) while keeping the
  // camera and any still-present selection — node chrome stays up, a selected
  // edge survives only if the new model still carries it. The edit layer produces
  // the new model and hands it here; live single-node drags use moveNode instead.
  applyModel(renderModel) {
    const selected = this.selectedId;
    const hovered = this.hoveredId;
    const selectedEdge = this.selectedEdge;
    this.installModel(renderModel);
    this.selectedId = this.nodesById.has(selected) ? selected : null;
    this.hoveredId = this.nodesById.has(hovered) ? hovered : null;
    this.selectedEdge = selectedEdge
      ? renderModel.edges.find((edge) => edge.from === selectedEdge.from && edge.to === selectedEdge.to) ?? null
      : null;
    this.nodeBatch.setSelected(this.hoveredId ?? this.selectedId);
    this.affordanceLayer.setSelected(this.selectedId);
    this.hoverLabel.setHovered(this.hoveredId);
    this.edgeChrome.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
  }

  installModel(renderModel) {
    this.renderModel = renderModel;
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = new SpatialGrid(renderModel.nodes, SPATIAL_CELL_SIZE);
    this.hoveredEdge = null; // the connector batch was rebuilt; the next move re-picks

    this.syncIconAtlas(renderModel.nodes);
    this.nodeBatch.setInstances(renderModel.nodes, this.iconAtlas);
    this.connectorBatch.setModel(renderModel);
    this.labelOverlay.setModel(renderModel, this.spatialGrid);
    this.iconOverlay.setModel(renderModel, this.spatialGrid);
    this.hoverLabel.setModel(renderModel);
    this.affordanceLayer.setModel(renderModel);
    this.edgeChrome.setModel(renderModel);
  }

  // Push re-derived node states to the scene. The first push (a fresh model) paints
  // the resting look silently; later pushes diff against it — upward changes become
  // one growth ceremony (bloom/travel/pulse/toast), downward changes just dim in
  // place (280ms, no beat). Icons always follow the new state at once.
  applyStates(statesMap) {
    this.iconOverlay.setStates(statesMap);

    if (this.nodeStates.size === 0) {
      this.nodeStates = new Map(statesMap);
      if (this.shouldAnimateArrival(statesMap)) { this.playArrival(statesMap); return; }
      this.nodeBatch.setStates(statesMap);
      this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
      return;
    }

    const changeset = this.buildChangeset(statesMap);
    for (const fall of changeset.fell) this.nodeBatch.igniteNode(fall.id, this.elapsedSeconds, fall.toTier, { durationMs: 280, blossom: false });
    if (changeset.fell.length > 0) this.connectorBatch.setStates(statesMap, this.elapsedSeconds); // an un-done source unlights its edges
    this.nodeStates = new Map(statesMap);

    changeset.summary = this.pendingSummary;
    changeset.hasAction = this.pendingHasAction;
    this.pendingSummary = null;
    this.pendingHasAction = false;
    this.director.celebrate(changeset);
  }

  // Diff the incoming states against the baseline into the ceremony's changeset:
  // which nodes rose a tier (and from where), which edges a freshly-completed
  // source lights, which children the light wakes, the available frontier to pulse,
  // and the node to settle the camera on. Downward transitions ride along as `fell`.
  buildChangeset(statesMap) {
    const risen = [];
    const fell = [];
    const completedNow = new Set();
    for (const [id, state] of statesMap) {
      const from = this.nodeStates.get(id) ?? 'locked';
      const toTier = nodeTier(state);
      const fromTier = nodeTier(from);
      if (toTier > fromTier) {
        const node = this.nodesById.get(id);
        if (node) risen.push({ id, fromTier, toTier, x: node.x, y: node.y });
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
    const focusNode = risen.find((r) => r.toTier === 2) ?? risen[0] ?? null;
    const focus = focusNode ? { x: focusNode.x, y: focusNode.y } : null;
    return { focus, risen, fell, litEdges, wakeByEdge, frontier, summary: null, hasAction: false };
  }

  // The shell hands the next ceremony its summary line before it triggers the state
  // change; the director speaks it as the closing beat (§2 toast — last, once).
  announceCeremony(summary, opts = {}) {
    this.pendingSummary = summary;
    this.pendingHasAction = !!opts.hasAction;
  }

  // ---- arrival cascade (#3) --------------------------------------------

  // A fresh model plants itself only when it's small enough to read and motion is on;
  // the huge perf tree and reduced motion paint at rest instead.
  arrivalLikely() {
    return this.motion === 1 && !!this.renderModel && this.renderModel.nodes.length >= 2 && this.renderModel.nodes.length <= ARRIVAL_MAX;
  }

  shouldAnimateArrival(statesMap) {
    if (!this.arrivalLikely()) return false;
    for (const state of statesMap.values()) if (nodeTier(state) >= 1) return true;
    return false;
  }

  // Paint the whole tree dim, then hand the director a ring plan so it wakes the roadmap
  // outward from the crowned root — the light travels each edge as its ring enters.
  playArrival(statesMap) {
    const dimmed = new Map();
    for (const id of statesMap.keys()) dimmed.set(id, 'locked');
    this.nodeBatch.setStates(dimmed);
    this.connectorBatch.setStates(dimmed, this.elapsedSeconds);
    this.director.arrival(this.buildArrivalPlan(statesMap));
  }

  // Depth rings by BFS from the crowned root(s); each node carries its resting tier, and
  // each ring the edges a freshly-complete source in it lights as the ring wakes.
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
    return { rings, litEdgesByRing, summary: `Roadmap planted · ${nodes.length} steps` };
  }

  // Live reposition of one node: cheap per-instance GPU writes for the node and
  // its incident edges, plus a spatial re-bucket. Overlays follow next frame.
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

  // A drag ended: report the node's committed position so the shell can record it
  // in edit history. The scene snapshot already holds the new position.
  endMove(id) {
    const node = this.nodesById.get(id);
    if (node && this.options.onNodeMoveEnd) this.options.onNodeMoveEnd(id, node.x, node.y);
  }

  // Live previews the React step panel drives: recolour while a kind swatch is
  // hovered, dim while the delete button is hovered. No history; a commit's
  // model rebuild (or the restore/clear on leave) supersedes them.
  previewKind(id, kind) { this.nodeBatch.setColor(id, kind); }
  restoreKind(id) { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); }
  previewDeleteCost(id) { this.nodeBatch.setFaded(new Set([id])); } // §5.1 branch-dim deferred: needs a connector fade
  clearDeleteCost() { this.nodeBatch.clearFaded(); }

  fitToView() {
    if (!this.renderModel) return;
    this.camera.fitToView(this.renderModel.bounds, this.camera.viewportWidth, this.camera.viewportHeight);
  }

  focusNode(id) {
    const node = this.nodesById.get(id);
    if (!node) return;
    this.selectedId = id;
    this.nodeBatch.setSelected(id);
    this.camera.focus(node.x, node.y);
  }

  panTo(x, y) { this.camera.panTo(x, y); }
  zoomBy(factor) { this.camera.zoomBy(factor); }

  // ---- activity feed hooks (design: event-log-options) -----------------

  // A live event landed on this node: fire its one-shot arrival pulse.
  pulseNode(id) { this.nodeBatch.pulse(id, this.elapsedSeconds); }

  // Row hover ↔ graph: light one node + its branches, dim the rest to a wash.
  // Passing null restores the resting look and the real selection highlight.
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

  // Camera-only reveal: glide to a node without selecting it (a feed row flies the
  // camera; only a fruit click opens details — design A′).
  revealNode(id) {
    const node = this.nodesById.get(id);
    if (node) this.camera.glideTo(node.x, node.y);
  }

  // Per-frame camera viewport, straight from the render loop (never throttled,
  // never through React). The listener fires now with the current viewport and
  // again on every frame the camera moves; returns an unsubscribe.
  subscribeViewport = (listener) => {
    this.viewportListeners.add(listener);
    listener(this.getViewport());
    return () => this.viewportListeners.delete(listener);
  };

  getBounds() { return this.renderModel ? this.renderModel.bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }
  getViewport() { return this.camera.getViewport(); }

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

  stop() {
    this.running = false;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  dispose() {
    this.stop();
    this.director.cancel();
    this.input.unbind();
    this.motionQuery.removeEventListener('change', this.applyMotion);
    this.nodeBatch.dispose();
    this.connectorBatch.dispose();
    this.labelOverlay.dispose();
    this.iconOverlay.dispose();
    this.hoverLabel.dispose();
    this.affordanceLayer.dispose();
    this.edgeChrome.dispose();
    if (this.iconTexture) this.gl.deleteTexture(this.iconTexture);
  }

  // ---- render loop ------------------------------------------------------

  tick = (now) => {
    if (!this.running) return;
    if (this.lastFrameTime === null) this.lastFrameTime = now;
    const dt = Math.min((now - this.lastFrameTime) / 1000, MAX_FRAME_DELTA);
    this.lastFrameTime = now;
    this.elapsedSeconds += dt;

    const moved = this.camera.update(dt);
    if (moved || this.overlaysDirty) {
      this.labelOverlay.update(this.camera);
      this.iconOverlay.update(this.camera);
      this.hoverLabel.update(this.camera);
      this.affordanceLayer.update(this.camera);
      this.edgeChrome.update(this.camera);
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

  // Keep the current atlas when every icon it needs is already baked; only
  // re-raster when a new icon appears (so add/relayout doesn't flicker the atlas).
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

  // Node and edge selection are mutually exclusive: picking one clears the other.
  // select() drives selection from the canvas — clears any edge and notifies the
  // shell. setSelection() mirrors a selection the shell already made (Esc / close /
  // create) without clearing the edge or echoing back, so the canvas chrome tracks
  // React however it changed. The id guard makes the mirror idempotent.
  select(id) {
    this.setSelection(id);
    this.selectEdge(null);
    if (this.options.onNodePick) this.options.onNodePick(id);
  }

  setSelection(id) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.affordanceLayer.setSelected(id);
    this.overlaysDirty = true;
    this.refreshHighlight();
  }

  selectEdge(edge) {
    if (edge && this.selectedId !== null) this.select(null); // safe: its selectEdge(null) recursion stops on the falsy edge
    this.selectedEdge = edge ?? null;
    this.edgeChrome.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
  }

  hover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.hoverLabel.setHovered(id);
    this.nodeBatch.setHover(id, this.elapsedSeconds); // feedback: swell 1.06 + a subtle brightness
    this.overlaysDirty = true;
    if (this.options.onNodeHover) this.options.onNodeHover(id);
  }

  // Press feedback: a node dips to 0.97 while held (pointer-down over it), springs back
  // on release. Immediate feedback, never queued; the shader skips the scale under reduced motion.
  setPress(id) { this.nodeBatch.setPress(id, this.elapsedSeconds); }

  // Hovering a branch only deepens its line + a pointer cursor — never chrome.
  hoverEdge(edge) {
    const next = edge ?? null;
    if (next === this.hoveredEdge) return;
    this.hoveredEdge = next;
    this.connectorBatch.setHovered(next);
    this.canvas.style.cursor = next ? 'pointer' : '';
  }

  refreshHighlight() {
    this.nodeBatch.setSelected(this.selectedId);
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.camera.screenToWorld(x, y);
    return this.spatialGrid.nearest(world.x, world.y, PICK_RADIUS);
  }

  // Nearest branch to the cursor within EDGE_PICK_RADIUS (straight-segment
  // approximation — the curve bend is small), or null. Only meaningful off-node.
  pickEdge(sx, sy) {
    if (!this.renderModel) return null;
    const world = this.camera.screenToWorld(sx, sy);
    const maxDist = EDGE_PICK_RADIUS / this.camera.zoom;
    let best = null;
    let bestDist = maxDist;
    for (const edge of this.renderModel.edges) {
      const from = this.nodesById.get(edge.from);
      const to = this.nodesById.get(edge.to);
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

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
