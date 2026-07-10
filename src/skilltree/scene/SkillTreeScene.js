// Orchestrator for the hand-rolled WebGL2 renderer: owns the GL context, the 2D
// camera, and the node/connector batches. The rAF loop only advances time and
// the camera; geometry is uploaded once per model and mutated in place on state
// change. Picking reuses the domain SpatialGrid. Public API is unchanged so the
// React shell above is renderer-agnostic.
import { BACKGROUND, NODE_SIZE } from '../theme.js';
import { SpatialGrid } from '../model/SpatialGrid.js';
import { Camera2D } from './Camera2D.js';
import { NodeBatch } from './NodeBatch.js';
import { ConnectorBatch } from './ConnectorBatch.js';
import { IconAtlas } from './IconAtlas.js';
import { LabelOverlay, IconOverlay, ICON_DOM_START, ICON_DOM_FULL } from './NodeOverlay.js';
import { AffordanceLayer } from './AffordanceLayer.js';
import { SelectionBar } from './SelectionBar.js';
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
    this.affordanceLayer = new AffordanceLayer(canvas, {
      camera: this.camera,
      pick: (x, y) => this.pick(x, y),
      onCreate: (id) => this.options.onCreateChild && this.options.onCreateChild(id),
      onConnect: (sourceId, targetId) => this.options.onConnectNodes && this.options.onConnectNodes(sourceId, targetId),
      onReconnect: (oldFrom, oldTo, newFrom, newTo) => this.options.onReconnectEdge && this.options.onReconnectEdge(oldFrom, oldTo, newFrom, newTo),
    });
    this.selectionBar = new SelectionBar(canvas, {
      onRename: (id) => this.beginRename(id),
      onDelete: (id) => this.options.onDeleteNode && this.options.onDeleteNode(id),
      onSetKind: (id, kind) => this.options.onSetKind && this.options.onSetKind(id, kind),
      onPreviewKind: (id, kind) => this.nodeBatch.setColor(id, kind),
      onRestoreKind: (id) => { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); },
      onDirty: () => { this.overlaysDirty = true; },
    });
    this.edgeChrome = new EdgeChrome(canvas, {
      onDeleteEdge: (from, to) => this.options.onDeleteEdge && this.options.onDeleteEdge(from, to),
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

    this.viewportListeners = new Set();
    this.running = false;
    this.elapsedSeconds = 0;
    this.lastFrameTime = null;
    this.rafHandle = null;
    this.overlaysDirty = false;

    this.toolContext = {
      camera: this.camera,
      pick: (x, y) => this.pick(x, y),
      getNode: (id) => this.nodesById.get(id),
      select: (id) => this.select(id),
      hover: (id) => this.hover(id),
      hoverEdge: (pos) => this.hoverEdge(pos),
      moveNode: (id, x, y) => this.moveNode(id, x, y),
      endMove: (id) => this.endMove(id),
      beginRename: (id) => this.beginRename(id),
    };
    this.input = new InputController(canvas, this.toolContext, new MoveTool(this.toolContext));

    this.resize();
    this.input.bind();
  }

  // ---- public API -----------------------------------------------------

  // Full load: fit the camera and clear selection. Used for first paint and
  // dataset swaps.
  setModel(renderModel) {
    this.installModel(renderModel);
    this.selectedId = null;
    this.hoveredId = null;
    this.fitToView();
  }

  // Apply a re-derived model (add/remove/reconnect/relayout) while keeping the
  // camera and any still-present selection. The edit layer produces the new model
  // and hands it here; live single-node drags use moveNode instead.
  applyModel(renderModel) {
    const selected = this.selectedId;
    const hovered = this.hoveredId;
    this.installModel(renderModel);
    this.selectedId = this.nodesById.has(selected) ? selected : null;
    this.hoveredId = this.nodesById.has(hovered) ? hovered : null;
    this.nodeBatch.setSelected(this.hoveredId ?? this.selectedId);
    this.selectionBar.setSelected(this.selectedId); // keep the action bar up across edits
    this.overlaysDirty = true;
  }

  installModel(renderModel) {
    this.renderModel = renderModel;
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = new SpatialGrid(renderModel.nodes, SPATIAL_CELL_SIZE);

    this.syncIconAtlas(renderModel.nodes);
    this.nodeBatch.setInstances(renderModel.nodes, this.iconAtlas);
    this.connectorBatch.setModel(renderModel);
    this.labelOverlay.setModel(renderModel, this.spatialGrid);
    this.iconOverlay.setModel(renderModel, this.spatialGrid);
    this.affordanceLayer.setModel(renderModel);
    this.selectionBar.setModel(renderModel);
    this.edgeChrome.setModel(renderModel);
  }

  applyStates(statesMap) {
    this.nodeBatch.setStates(statesMap);
    this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
    this.iconOverlay.setStates(statesMap);
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

  // Double-click: ask the shell to open the inline name field at the node's label.
  beginRename(id) {
    const node = this.nodesById.get(id);
    if (!node || !this.options.onRenameNode) return;
    const sx = (node.x - this.camera.x) * this.camera.zoom + this.camera.viewportWidth / 2;
    const sy = (node.y - this.camera.y) * this.camera.zoom + this.camera.viewportHeight / 2 + NODE_SIZE * 0.62 * this.camera.zoom;
    this.options.onRenameNode(id, node.label, sx, sy);
  }

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
    this.input.unbind();
    this.motionQuery.removeEventListener('change', this.applyMotion);
    this.nodeBatch.dispose();
    this.connectorBatch.dispose();
    this.labelOverlay.dispose();
    this.iconOverlay.dispose();
    this.affordanceLayer.dispose();
    this.selectionBar.dispose();
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
      this.affordanceLayer.update(this.camera);
      this.selectionBar.update(this.camera);
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

  select(id) {
    this.selectedId = id;
    this.selectionBar.setSelected(id);
    this.overlaysDirty = true;
    this.refreshHighlight();
    if (this.options.onNodePick) this.options.onNodePick(id);
  }

  hover(id) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.affordanceLayer.setHovered(id);
    this.overlaysDirty = true;
    this.refreshHighlight();
    if (this.options.onNodeHover) this.options.onNodeHover(id);
  }

  refreshHighlight() {
    this.nodeBatch.setSelected(this.hoveredId ?? this.selectedId);
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.camera.screenToWorld(x, y);
    return this.spatialGrid.nearest(world.x, world.y, PICK_RADIUS);
  }

  hoverEdge(pos) {
    if (!pos) { this.edgeChrome.setHoveredEdge(null); return; }
    const edge = this.pickEdge(pos.x, pos.y);
    this.edgeChrome.setHoveredEdge(edge);
    this.overlaysDirty = true;
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
