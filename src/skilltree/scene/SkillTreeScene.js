import * as THREE from 'three';
import { BACKGROUND, NODE_SIZE } from '../theme.js';
import { SpatialGrid } from '../model/SpatialGrid.js';
import { CameraController } from './CameraController.js';
import { NodeAtlas } from './NodeAtlas.js';
import { NodeLayer } from './NodeLayer.js';
import { ConnectorLayer } from './ConnectorLayer.js';
import { LabelLayer } from './LabelLayer.js';

/**
 * @typedef {Object} SceneOptions
 * @property {(id: string | null) => void} [onNodePick]
 * @property {(id: string | null) => void} [onNodeHover]
 * @property {(viewport: import('../model/ports.js').Bounds) => void} [onCameraChange]
 */

const SPATIAL_CELL_SIZE = NODE_SIZE * 2;
const PICK_RADIUS = NODE_SIZE * 0.65;
const HOVER_THROTTLE_MS = 40;
const CAMERA_NOTIFY_THROTTLE_MS = 100;
const DRAG_CLICK_THRESHOLD_PX = 4;
const MAX_FRAME_DELTA = 0.1; // clamp huge deltas from a tabbed-out browser

// Orchestrator: owns the renderer, the ortho camera (via CameraController) and
// the three GPU layers. The rAF loop below is the only per-frame JS in the whole
// scene, and it touches nothing per-node — just uTime and the camera. Everything
// node/edge-shaped is either baked into GPU buffers up front (setModel) or
// flipped in place on state change (applyStates); picking reuses the same
// SpatialGrid the LabelLayer uses for its LOD.
export class SkillTreeScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(BACKGROUND.canvas, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
    this.cameraController = new CameraController(this.camera);

    this.atlas = new NodeAtlas();
    this.nodeLayer = new NodeLayer(this.atlas);
    this.connectorLayer = new ConnectorLayer();
    this.labelLayer = new LabelLayer(this.scene);

    this.scene.add(this.connectorLayer.mesh);
    this.scene.add(this.nodeLayer.mesh);

    this.renderModel = null;
    this.nodesById = new Map();
    this.spatialGrid = null;
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

    this.nodeLayer.setInstances(renderModel.nodes);
    this.connectorLayer.setModel(renderModel);
    this.labelLayer.setModel(renderModel, this.spatialGrid);

    this.fitToView();
  }

  applyStates(statesMap) {
    this.nodeLayer.setStates(statesMap);
    this.connectorLayer.setStates(statesMap, this.elapsedSeconds);
  }

  fitToView() {
    if (!this.renderModel) return;
    this.cameraController.fitToView(this.renderModel.bounds, this.canvas.clientWidth, this.canvas.clientHeight);
    this.notifyCameraChange();
  }

  focusNode(id) {
    const node = this.nodesById.get(id);
    if (!node) return;
    this.selectedId = id;
    this.nodeLayer.setSelected(id);
    this.cameraController.focus(node.x, node.y);
    this.notifyCameraChange();
  }

  panTo(x, y) {
    this.cameraController.panTo(x, y);
    this.notifyCameraChange();
  }

  zoomBy(factor) {
    this.cameraController.zoomBy(factor);
    this.notifyCameraChange();
  }

  getBounds() {
    return this.renderModel ? this.renderModel.bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  getViewport() {
    return this.cameraController.getViewport();
  }

  resize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.cameraController.resize(width, height);
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
    this.scene.remove(this.connectorLayer.mesh, this.nodeLayer.mesh);
    this.nodeLayer.dispose();
    this.connectorLayer.dispose();
    this.labelLayer.dispose();
    this.atlas.dispose();
    this.renderer.dispose();
  }

  // ---- animation loop ---------------------------------------------------

  tick = (now) => {
    if (!this.running) return;
    if (this.lastFrameTime === null) this.lastFrameTime = now;
    const dt = Math.min((now - this.lastFrameTime) / 1000, MAX_FRAME_DELTA);
    this.lastFrameTime = now;
    this.elapsedSeconds += dt;

    const moved = this.cameraController.update(dt);
    this.nodeLayer.material.uniforms.uTime.value = this.elapsedSeconds;
    this.connectorLayer.material.uniforms.uTime.value = this.elapsedSeconds;

    if (moved && now - this.lastCameraNotifyAt > CAMERA_NOTIFY_THROTTLE_MS) {
      this.notifyCameraChange();
    }

    this.renderer.render(this.scene, this.camera);
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  notifyCameraChange() {
    const viewport = this.getViewport();
    this.labelLayer.update(viewport, this.camera.zoom);
    if (this.options.onCameraChange) this.options.onCameraChange(viewport);
    this.lastCameraNotifyAt = performance.now();
  }

  // ---- pointer input: drives both CameraController and picking ----------

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
    this.dragState = {
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      lastTime: performance.now(),
      moved: false,
      velocityX: 0,
      velocityY: 0,
    };
  };

  handlePointerMove = (event) => {
    const { x, y } = this.pointerPosition(event);

    if (this.dragState && this.dragState.pointerId === event.pointerId) {
      const dx = x - this.dragState.lastX;
      const dy = y - this.dragState.lastY;
      const now = performance.now();
      const dt = Math.max(now - this.dragState.lastTime, 1);

      if (!this.dragState.moved && Math.hypot(x - this.dragState.startX, y - this.dragState.startY) > DRAG_CLICK_THRESHOLD_PX) {
        this.dragState.moved = true;
      }
      if (this.dragState.moved) this.cameraController.pan(dx, dy);

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

    if (moved) {
      this.cameraController.launchInertia(velocityX, velocityY);
      return;
    }

    this.handleClick(x, y);
  };

  handlePointerLeave = () => {
    if (this.dragState) return; // pointer is captured; still dragging off-canvas
    if (this.hoveredId === null) return;
    this.hoveredId = null;
    this.refreshHighlight();
    if (this.options.onNodeHover) this.options.onNodeHover(null);
  };

  handleWheel = (event) => {
    event.preventDefault();
    const { x, y } = this.pointerPosition(event);
    // Left to the tick loop's throttled notify — wheel can fire faster than the
    // label LOD refresh needs to run.
    this.cameraController.zoomAt(x, y, event.deltaY);
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
    this.nodeLayer.setSelected(this.hoveredId ?? this.selectedId);
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.cameraController.screenToWorld(x, y);
    return this.spatialGrid.nearest(world.x, world.y, PICK_RADIUS);
  }
}
