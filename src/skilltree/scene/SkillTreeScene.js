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
import { LabelOverlay } from './LabelOverlay.js';
import { createTextureFromCanvas } from './glcore.js';

const SPATIAL_CELL_SIZE = NODE_SIZE * 2;
const PICK_RADIUS = NODE_SIZE * 0.65;
const HOVER_THROTTLE_MS = 40;
const CAMERA_NOTIFY_THROTTLE_MS = 100;
const DRAG_CLICK_THRESHOLD_PX = 4;
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

    this.running = false;
    this.elapsedSeconds = 0;
    this.lastFrameTime = null;
    this.rafHandle = null;
    this.lastHoverAt = 0;
    this.lastCameraNotifyAt = 0;
    this.dragState = null;

    this.resize();
    this.bindEvents();
  }

  // ---- public API -----------------------------------------------------

  setModel(renderModel) {
    this.renderModel = renderModel;
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = new SpatialGrid(renderModel.nodes, SPATIAL_CELL_SIZE);
    this.selectedId = null;
    this.hoveredId = null;

    this.buildIconAtlas(renderModel.nodes);
    this.nodeBatch.setInstances(renderModel.nodes, this.iconAtlas);
    this.connectorBatch.setModel(renderModel);
    this.labelOverlay.setModel(renderModel, this.spatialGrid);

    this.fitToView();
  }

  applyStates(statesMap) {
    this.nodeBatch.setStates(statesMap);
    this.connectorBatch.setStates(statesMap, this.elapsedSeconds);
  }

  fitToView() {
    if (!this.renderModel) return;
    this.camera.fitToView(this.renderModel.bounds, this.camera.viewportWidth, this.camera.viewportHeight);
    this.notifyCameraChange();
  }

  focusNode(id) {
    const node = this.nodesById.get(id);
    if (!node) return;
    this.selectedId = id;
    this.nodeBatch.setSelected(id);
    this.camera.focus(node.x, node.y);
    this.notifyCameraChange();
  }

  panTo(x, y) { this.camera.panTo(x, y); this.notifyCameraChange(); }
  zoomBy(factor) { this.camera.zoomBy(factor); this.notifyCameraChange(); }

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
    this.notifyCameraChange();
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
    this.unbindEvents();
    this.motionQuery.removeEventListener('change', this.applyMotion);
    this.nodeBatch.dispose();
    this.connectorBatch.dispose();
    this.labelOverlay.dispose();
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
    if (moved && now - this.lastCameraNotifyAt > CAMERA_NOTIFY_THROTTLE_MS) this.notifyCameraChange();

    const gl = this.gl;
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.connectorBatch.draw(this.camera, this.elapsedSeconds, this.motion);
    const iconOpacity = smoothstep(this.camera.zoom, ICON_ZOOM_START, ICON_ZOOM_FULL);
    this.nodeBatch.draw(this.camera, this.elapsedSeconds, this.motion, iconOpacity);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  notifyCameraChange() {
    this.labelOverlay.update(this.camera);
    if (this.options.onCameraChange) this.options.onCameraChange(this.getViewport());
    this.lastCameraNotifyAt = performance.now();
  }

  // ---- icon atlas -------------------------------------------------------

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

  // ---- pointer input ----------------------------------------------------

  bindEvents() {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  unbindEvents() {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('wheel', this.handleWheel);
  }

  pointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  handlePointerDown = (event) => {
    this.canvas.setPointerCapture(event.pointerId);
    const { x, y } = this.pointerPosition(event);
    this.dragState = { pointerId: event.pointerId, startX: x, startY: y, lastX: x, lastY: y, lastTime: performance.now(), moved: false, velocityX: 0, velocityY: 0 };
  };

  handlePointerMove = (event) => {
    const { x, y } = this.pointerPosition(event);
    if (this.dragState && this.dragState.pointerId === event.pointerId) {
      const dx = x - this.dragState.lastX;
      const dy = y - this.dragState.lastY;
      const now = performance.now();
      const dt = Math.max(now - this.dragState.lastTime, 1);
      if (!this.dragState.moved && Math.hypot(x - this.dragState.startX, y - this.dragState.startY) > DRAG_CLICK_THRESHOLD_PX) this.dragState.moved = true;
      if (this.dragState.moved) this.camera.pan(dx, dy);
      this.dragState.velocityX = this.dragState.velocityX * 0.7 + (dx / dt) * 0.3;
      this.dragState.velocityY = this.dragState.velocityY * 0.7 + (dy / dt) * 0.3;
      this.dragState.lastX = x;
      this.dragState.lastY = y;
      this.dragState.lastTime = now;
      return;
    }
    this.handleHover(x, y);
  };

  handlePointerUp = (event) => {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const { x, y } = this.pointerPosition(event);
    const { moved, velocityX, velocityY } = this.dragState;
    this.dragState = null;
    if (moved) { this.camera.launchInertia(velocityX, velocityY); return; }
    this.handleClick(x, y);
  };

  handlePointerLeave = () => {
    if (this.dragState) return;
    if (this.hoveredId === null) return;
    this.hoveredId = null;
    this.refreshHighlight();
    if (this.options.onNodeHover) this.options.onNodeHover(null);
  };

  handleWheel = (event) => {
    event.preventDefault();
    const { x, y } = this.pointerPosition(event);
    this.camera.zoomAt(x, y, event.deltaY);
  };

  handleHover(x, y) {
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    const id = this.pick(x, y);
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.refreshHighlight();
    if (this.options.onNodeHover) this.options.onNodeHover(id);
  }

  handleClick(x, y) {
    const id = this.pick(x, y);
    this.selectedId = id;
    this.refreshHighlight();
    if (this.options.onNodePick) this.options.onNodePick(id);
  }

  refreshHighlight() {
    this.nodeBatch.setSelected(this.hoveredId ?? this.selectedId);
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.camera.screenToWorld(x, y);
    return this.spatialGrid.nearest(world.x, world.y, PICK_RADIUS);
  }
}

function smoothstep(x, edge0, edge1) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
