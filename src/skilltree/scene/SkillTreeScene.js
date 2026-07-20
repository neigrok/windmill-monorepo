// Orchestrator for the hand-rolled WebGL2 renderer: owns the GL context, the 2D
// camera, and the node/connector batches. The rAF loop only advances time and
// the camera; geometry is uploaded once per model and mutated in place on state
// change. Picking reuses the domain SpatialGrid. Public API is unchanged so the
// React shell above is renderer-agnostic.
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
import { track } from '../../telemetry/beacon.js';

const SPATIAL_CELL_SIZE = NODE_SIZE * 2;
const PICK_RADIUS = NODE_SIZE * 0.65;
const TOUCH_HIT_RADIUS = 22; // read-only pick floor: a ≥44px hit disc so small nodes stay tappable
const PAN_SETTLE_MS = 200; // quiet after the last pan before the chrome is signalled back
const EDGE_PICK_RADIUS = 12; // screen px tolerance for hovering a branch
const MAX_FRAME_DELTA = 0.1;
const ICON_ZOOM_START = 0.5;
const ICON_ZOOM_FULL = 1.1;
// First paint (and manual fit) must not zoom in past the point where a lone / near-empty tree
// balloons: cap so the emphasised root reads at its birth-preview size (~46px) instead of
// fit-to-filling the viewport. Root disc = base disc (NODE_SIZE * 0.84) × emphasis (1.55, see
// NodeBatch `aEmphasis`); 46 / that ≈ 0.63. Larger trees fit below this cap, so they're untouched.
const FIT_MAX_ZOOM = 46 / (NODE_SIZE * 0.84 * 1.55);
const SETTLE_MS = 520; // a displaced node's glide to its new seat after a live relayout
const SETTLE_MIN_DELTA = 2; // world units — sub-pixel layout drift snaps silently instead of shimmering
const SETTLE_STAGGER_MS = 120; // glides ripple outward from the change, not all at once
const AUTO_FRAME_IDLE_S = 2; // quiet this long (and nothing selected) before an auto-frame may fire
const AUTO_FRAME_EXPIRY_S = 10; // an arrival the user stayed busy through never auto-frames late
const AUTO_FRAME_MAX_ZOOM_OUT = 0.82; // one burst breathes the view out at most ~18%
const AUTO_FRAME_PAD = NODE_SIZE * 2; // world-space margin around framed arrivals

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class SkillTreeScene {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.readOnly = !!options.readOnly; // a shared/mobile viewer: no editing chrome, pan-only

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
    // The editing chrome — ghost buds/connect ports and edge edit handles — only mounts
    // for the editor. A read-only scene still renders, picks, selects, pans and zooms;
    // it just never grows the affordances, so every call into them is guarded below.
    this.affordanceLayer = null;
    this.edgeChrome = null;
    this.marqueeOverlay = null;
    this.reorderSlot = null;
    this.reorder = null; // the in-flight angular-reorder drag: { id, radius, siblings, homeX, homeY }
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
    this.selectedId = null;      // the size≤1 projection of selectedIds — single-select chrome tracks this
    this.selectedIds = new Set(); // the full multi-selection; size>1 shows the floating bar, hides single chrome
    this.hoveredId = null;
    this.selectedEdge = null;
    this.selectedEdges = new Set(); // desktop multi-select: edge keys highlighted in the ConnectorBatch
    this.hoveredEdge = null;
    this.lastArcs = new Map(); // last workspace arc fractions — re-applied across model rebuilds

    this.viewportListeners = new Set();
    this.panning = false; // debounced pan-gesture state reported via onPanStateChange
    this.panSettleTimer = null;
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
    this.arrivalNoun = 'Roadmap'; // what the arrival toast says was planted (the quest shelf flips it)
    this.arrivalSummaryOverride = null; // a fixed arrival toast line (the fork re-plant sets it), or null for the default
    this.arrivalToastSuppressed = false; // the demo load suppresses the arrival toast — visitors watch, toasts are for actors
    this.returnRecap = null; // a one-shot return-recap intent (set before setModel): { sinceIds, summary } | null
    this.pendingSummary = null; // the toast the next ceremony speaks (set by the shell)
    this.pendingAction = null;  // an optional {label, run} the toast carries (e.g. share-on-unlock)
    this.settle = null; // in-flight layout glide: { startAt, moves } (see beginSettle)
    this.pendingFrame = null; // off-screen arrivals awaiting an idle auto-frame: { nodes, at }
    this.lastInputAt = 0; // when the pointer last touched the canvas — the idle gate reads this
    this.notePointer = () => { this.lastInputAt = this.elapsedSeconds; };
    canvas.addEventListener('pointermove', this.notePointer, { passive: true });
    this.arrivalChevron = new ArrivalChevron(canvas, {
      onReveal: (x, y) => {
        this.pendingFrame = null; // the user chose to look — no auto-frame on top
        this.director.yieldToInput();
        this.camera.glideTo(x, y);
      },
    });

    // A React tap override for phone editing (Wave B): the scene stays read-only, but an
    // owner editing on a phone routes canvas taps through here so React owns the mode logic
    // (aim / remove / select). Absent (read-only shares) it stays null and the tool's default
    // select fires byte-unchanged.
    this.editTap = null;
    // A React long-press override for phone multi-select (Wave C, M5): the scene stays read-only,
    // but a held finger over a node routes here so React owns the mode. Absent (read-only shares,
    // desktop) it stays null and no hold arms — the tool's default select fires byte-unchanged.
    this.longPress = null;

    this.toolContext = {
      camera: this.camera,
      pick: (x, y) => this.pick(x, y),
      pickEdge: (x, y) => this.pickEdge(x, y),
      // The tool stays dumb: it detects an unmoved tap and offers it here. A handler present
      // consumes the tap (returns true so the default select never fires); absent, false lets it through.
      editTap: (x, y) => this.editTap ? (this.editTap(x, y), true) : false,
      // A held finger over a real node offers the id here; a handler present enters multi-select
      // and returns true so the InputController swallows the lift (no tap follows). Absent, false
      // lets the ordinary gesture through — mirrors editTap's consume contract.
      onLongPress: (id) => (id != null && this.longPress ? (this.longPress(id), true) : false),
      select: (id) => this.select(id),
      // A plain edge pick reports up (onEdgePick) so the shell drops any lingering multi-selection.
      selectEdge: (edge) => { this.selectEdge(edge); this.options.onEdgePick?.(edge); },
      hover: (id) => this.hover(id),
      hoverEdge: (edge) => this.hoverEdge(edge),
      onInteract: () => {
        this.lastInputAt = this.elapsedSeconds;
        this.pendingFrame = null; // a grab is intent — never auto-frame over it
        this.director.yieldToInput();
        this.finishSettle();
      },
      onPan: () => this.reportPan(),
      press: (id) => this.setPress(id),
    };
    // The marquee + shift-click hooks are an editor capability the tool probes for: present
    // only when editing, and stripped on demotion (setReadOnly) so a read-only shift-drag stays
    // a plain pan. NavigateTool gates its marquee branch on `ctx.beginMarquee` existing.
    if (!this.readOnly) {
      this.toolContext.toggleSelect = (id) => this.toggleSelect(id);
      this.toolContext.toggleEdge = (edge) => this.toggleEdge(edge);
      this.toolContext.beginMarquee = (x0, y0) => this.marqueeOverlay?.show(x0, y0);
      this.toolContext.updateMarquee = (x0, y0, x1, y1) => this.updateMarquee(x0, y0, x1, y1);
      this.toolContext.cancelMarquee = () => { this.marqueeOverlay?.hide(); this.nodeBatch.setMarqueePreview(new Set()); };
      this.toolContext.commitMarquee = (x0, y0, x1, y1, additive) => this.commitMarquee(x0, y0, x1, y1, additive);
      // The angular-reorder capability (editing spec v2 §07) — a node drag reslots it among its
      // siblings. Editor-only and stripped on demotion, exactly like the marquee; NavigateTool gates
      // its reorder branch on `ctx.beginReorder` existing, so a read-only node drag stays a plain pan.
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

  // Full load: fit the camera and clear selection. Used for first paint and
  // dataset swaps.
  setModel(renderModel) {
    this.director.cancel();
    this.settle = null; // a fresh dataset has nowhere to glide from
    this.pendingFrame = null;
    this.arrivalChevron.clear();
    this.nodeStates = new Map(); // a fresh dataset re-baselines: the next applyStates plants or paints
    this.lastArcs = new Map();   // and drops any arcs the previous dataset carried
    this.installModel(renderModel);
    this.selectedId = null;
    this.hoveredId = null;
    this.selectedEdge = null;
    this.selectedEdges = new Set(); // a fresh dataset clears the edge multi-selection (connector rebuilt)
    this.fitToView();
    // Pre-dim before the first paint so the first ceremony doesn't flash a resting tree first.
    // A return-recap only darkens the steps it will replay — the backdrop keeps the lit rest that
    // installModel just painted, so the returning eye lands on the tree at rest before the new
    // steps bloom (no full-tree black flash). Any other first paint dims the whole tree to wake
    // it outward from the crowned root.
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

  // Apply a re-derived model (add/remove/reconnect/relayout) while keeping the
  // camera and any still-present selection — node chrome stays up, a selected
  // edge survives only if the new model still carries it. The edit layer produces
  // the new model and hands it here; settle glides move single nodes via moveNode.
  applyModel(renderModel) {
    const previous = this.nodesById;
    const selected = this.selectedId;
    const hovered = this.hoveredId;
    const selectedEdge = this.selectedEdge;
    this.installModel(renderModel);
    this.selectedId = this.nodesById.has(selected) ? selected : null;
    // Intersect the multi-selection with the survivors too, so a deleted id can't linger
    // highlighted after a rebuild (mirrors the single selectedId intersection above).
    this.selectedIds = new Set([...this.selectedIds].filter((id) => this.nodesById.has(id)));
    this.hoveredId = this.nodesById.has(hovered) ? hovered : null;
    this.selectedEdge = selectedEdge
      ? renderModel.edges.find((edge) => edge.from === selectedEdge.from && edge.to === selectedEdge.to) ?? null
      : null;
    // Intersect the edge multi-selection with the survivors too (installModel rebuilt the connector
    // batch to a zeroed selected buffer), so a deleted edge can't linger highlighted after a rebuild.
    const survivingEdges = new Set(renderModel.edges.map((edge) => edgeKey(edge.from, edge.to)));
    this.selectedEdges = new Set([...this.selectedEdges].filter((key) => survivingEdges.has(key)));
    this.connectorBatch.setSelectedEdges(this.selectedEdges);
    // installModel rebuilt the connector to a zeroed inSet buffer — re-light the inside-set links
    // (both endpoints in the surviving node set) so a rebuild that keeps the selection keeps them.
    this.connectorBatch.setInSetEdges(this.selectedIds);
    // The node highlight tracks the SET, not the size≤1 projection — a mixed node+edge selection
    // has one node with selectedId null, which setSelected would blank. Read-only lights the phone
    // owner's multi-select set when it's non-empty (else a rebuild — e.g. a bulk recolor that keeps
    // the selection — would blank every ring), and otherwise keeps its hover-fallback single path.
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

  // The cheapest honest signal that a pointer gesture (drag, pan, connect) is mid-flight —
  // the demote wait reads it so a downgrade never lands under a moving hand.
  isPointerActive() {
    return this.input.activePointerId !== null;
  }

  // The visitor downgrade (honesty moments): retire editing in place — the viewer tool
  // takes the pointer, the edit chrome fades out over one 280ms wave and is disposed,
  // and the camera never moves. Rendering, picking, panning all continue untouched.
  setReadOnly() {
    if (this.readOnly) return;
    this.readOnly = true;
    this.input.setTool(new ReadOnlyTool(this.toolContext));
    this.selectEdge(null);
    this.hoverEdge(null);
    // Drop the multi-selection and the editor-only marquee capability: a demoted view pans on
    // shift-drag exactly like a born-read-only one, and no floating bar can linger. Clear the set
    // directly (setSelectedSet now no-ops in read-only) so the highlight repaints to selectedId.
    this.selectedIds = new Set();
    this.selectedEdges = new Set(); // and the edge multi-selection — a demoted view carries neither
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

  // A re-derived model can carry a whole fresh layout (a live create/connect re-lays
  // the tree — see SkillTreeView's layoutPositions). Rather than teleport, every
  // displaced node glides from where it currently stands to its new seat — an
  // in-flight settle retargets smoothly because the old node objects hold their
  // mid-glide coordinates. Glides start staggered, nearest-to-the-change first, so
  // the motion reads as the new work pushing the tree open. Brand-new nodes don't
  // glide in: their arrival pulse is the activity feed's beat.
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

    for (const move of moves) this.moveNode(move.id, move.fromX, move.fromY); // hold the old seat until each glide starts
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

  // The user grabbed the canvas mid-settle: land every glide now so the world is
  // steady under their cursor — the same yield-to-input contract the ceremonies keep.
  finishSettle() {
    if (!this.settle) return;
    for (const move of this.settle.moves) this.moveNode(move.id, move.toX, move.toY);
    this.settle = null;
  }

  // Births outside the viewport never yank the camera (burst-camera): the chevron
  // points the way at the viewport edge, and the arrivals are remembered so a
  // strictly idle viewer gets one gentle auto-frame once the settle has landed.
  noteArrivals(arrivals) {
    if (arrivals.length === 0) return;
    const viewport = this.camera.getViewport();
    const offscreen = arrivals.filter((node) =>
      node.x < viewport.minX || node.x > viewport.maxX || node.y < viewport.minY || node.y > viewport.maxY);
    if (offscreen.length === 0) return;
    this.arrivalChevron.announce(offscreen);
    this.pendingFrame = { nodes: offscreen, at: this.elapsedSeconds };
  }

  // The auto-frame fires only for a viewer who is plainly just watching: motion on,
  // nothing selected, pointer quiet, no settle or glide in flight — and then it takes
  // one capped breath outward toward the arrivals rather than fitting them by force.
  // A busy user ages the pending frame out instead; the chevron alone points the way.
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
    this.hoveredEdge = null; // the connector batch was rebuilt; the next move re-picks

    this.syncIconAtlas(renderModel.nodes);
    this.nodeBatch.setInstances(renderModel.nodes, this.iconAtlas);
    this.nodeBatch.setArcs(this.lastArcs, this.elapsedSeconds); // rebuild reset the arcs; re-apply them (snaps, no ease)
    this.connectorBatch.setModel(renderModel);
    this.labelOverlay.setModel(renderModel, this.spatialGrid);
    this.iconOverlay.setModel(renderModel, this.spatialGrid);
    this.hoverLabel.setModel(renderModel);
    this.affordanceLayer?.setModel(renderModel);
    this.edgeChrome?.setModel(renderModel);
    if (this.readOnly) this.camera.setPanBounds(renderModel.bounds); // soft-clamp the touch pan to the tree
  }

  // Push re-derived node states to the scene. The first push (a fresh model) paints
  // the resting look silently; later pushes diff against it — upward changes become
  // one growth ceremony (bloom/travel/pulse/toast), downward changes just dim in
  // place (280ms, no beat). Icons always follow the new state at once.
  applyStates(statesMap) {
    this.iconOverlay.setStates(statesMap);

    if (this.nodeStates.size === 0) {
      // A returning visit replaces the generic arrival cascade with a replay of the steps
      // completed since last time (return-recap, P3); a first-ever visit or nothing-new
      // falls through to the ordinary arrival, untouched.
      if (this.returnRecap) { this.playReturnRecap(statesMap); return; }
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
    changeset.action = this.pendingAction;
    this.pendingSummary = null;
    this.pendingAction = null;
    this.director.celebrate(changeset);
  }

  // Diff the incoming states against the baseline into the ceremony's changeset:
  // which nodes rose a tier (and from where), which edges a freshly-completed
  // source lights, which children the light wakes, the available frontier to pulse,
  // and the node to settle the camera on. Downward transitions ride along as `fell`.
  // A rise into ember (a *start*) is applied here as a quiet kindle and kept out of
  // `risen`, so the ceremony director never celebrates starting — only finishing.
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

  // A quiet start: a step became in-progress. Kindle the ember directly — a soft glow-in
  // over 480ms and a 1.02 wake — with no camera glide, no light-travel, no pulse, no toast.
  // Kept out of the changeset (see buildChangeset) so downstream branches stay dormant:
  // unlock stays completion-gated.
  kindle(id) {
    this.nodeBatch.igniteNode(id, this.elapsedSeconds, TIER_EMBER, { blossom: false, durationMs: 480 });
  }

  // The shell hands the next ceremony its summary line before it triggers the state
  // change; the director speaks it as the closing beat (§2 toast — last, once).
  announceCeremony(summary, opts = {}) {
    this.pendingSummary = summary;
    this.pendingAction = opts.action ?? null;
  }

  // Push each node's sub-task completion fraction (done / total) to the progress arcs.
  // arcMap is Map<nodeId, fraction in [0,1]>; a node absent from the map has no sub-tasks and
  // shows no arc. We cache it so installModel can re-apply after a structural rebuild — the
  // workspace layer only calls this when its data changes, not on every add/relayout.
  setArcs(arcMap) {
    this.lastArcs = arcMap;
    this.nodeBatch.setArcs(arcMap, this.elapsedSeconds);
  }

  // ---- arrival cascade (#3) --------------------------------------------

  // A fresh model plants itself whenever there's a roadmap to read — two nodes or
  // more. Big pastes compress rather than vanish, and reduced motion still arrives:
  // the director decides between the ring cascade and the one-beat cross-fade, and
  // the toast speaks either way.
  arrivalLikely() {
    return !!this.renderModel && this.renderModel.nodes.length >= 2;
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
    let done = 0;
    for (const state of statesMap.values()) if (state === 'complete') done += 1;
    const defaultSummary = `${this.arrivalNoun} planted · ${nodes.length} steps${done > 0 ? ` · ${done} already done` : ''}`;
    const summary = this.arrivalToastSuppressed ? null : (this.arrivalSummaryOverride ?? defaultSummary);
    // One-shot intentions: this arrival consumed them, so the NEXT arrival on a reused
    // scene (a same-id demo→share flip never remounts) starts from the honest default.
    this.arrivalToastSuppressed = false;
    this.arrivalSummaryOverride = null;
    return { rings, litEdgesByRing, summary };
  }

  // return-recap (P3): a returning visit replays the steps completed since the last one,
  // instead of the generic full-tree arrival. The since-nodes are painted back down to a
  // pre-completion baseline (locked — an accepted approximation; the true prior tier isn't
  // stored), the rest of the tree rests at its current state, and the ordinary growth
  // ceremony blooms them + travels their newly-lit edges into the current frontier, closing
  // on the one summary toast. Reduced motion (celebrate → the director's reduced path) and
  // any yield-to-input are honoured for free. One-shot: consumed on the first push.
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

    // A path completed while away must cascade parent→child, not bloom all at once. Each since-node's
    // depth within the since-only subgraph orders the replay: its edges travel one ring later than its
    // since-parent's (the director reads e.wave), and a chained descendant blooms as the light lands,
    // not at t0. Roots (no since-parent) are depth 0 and seed the travel.
    const depth = this.sinceDepths(recap.sinceIds);
    for (const edge of changeset.litEdges) edge.wave = depth.get(edge.from) ?? 0;

    changeset.summary = recap.summary;
    this.director.celebrate(changeset);
  }

  // Longest-path depth of each since-node within the since-only subgraph: 0 for a node with no
  // since-parent (a cascade root), one past its deepest since-parent otherwise. Orders the recap.
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

  // A quest plant announces itself as one (F5 §04): the shell flips the noun before the
  // first model install, so the arrival toast says "Quest planted" instead of Roadmap.
  setArrivalNoun(noun) {
    this.arrivalNoun = noun;
  }

  // The fork re-plant (F4 §05) hands the arrival its own toast line ("Forked — 17 steps
  // planted") before the fresh copy blooms in; the demo load suppresses the toast entirely
  // (visitors watch the tree grow — toasts speak to actors). Both are read by buildArrivalPlan.
  setArrivalSummary(text) { this.arrivalSummaryOverride = text; }
  suppressArrivalToast() { this.arrivalToastSuppressed = true; }

  // The shell arms the return-recap before the model installs (the same seam the arrival
  // intents use): the first applyStates push replays these ids instead of the arrival.
  armReturnRecap(sinceIds, summary) { this.returnRecap = { sinceIds: new Set(sinceIds), summary }; }

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

  // Live previews the React step panel drives: recolour while a kind swatch is
  // hovered, dim while the delete button is hovered. No history; a commit's
  // model rebuild (or the restore/clear on leave) supersedes them.
  previewKind(id, kind) { this.nodeBatch.setColor(id, kind); }
  restoreKind(id) { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); }
  previewDeleteCost(id) { this.nodeBatch.setFaded(new Set([id])); } // §5.1 branch-dim deferred: needs a connector fade
  clearDeleteCost() { this.nodeBatch.clearFaded(); }

  // The set-wide previews the multi-select action card drives (brief #10): recolour the whole
  // selection while a swatch is hovered, dim it as a delete cost-preview while Delete is hovered.
  // No history — a commit's model rebuild (or the restore/clear on leave) supersedes them.
  previewKindSet(ids, kind) { for (const id of ids) this.nodeBatch.setColor(id, kind); }
  restoreKindSet(ids) { for (const id of ids) { const node = this.nodesById.get(id); if (node) this.nodeBatch.setColor(id, node.color); } }
  previewDeleteCostSet(ids) { this.nodeBatch.setFaded(new Set(ids)); } // §5.1 branch-dim deferred, as the single-node case
  setFaded(ids) { this.nodeBatch.setFaded(ids); } // aim mode's illegal-target dim (M3)
  clearFaded() { this.nodeBatch.clearFaded(); }

  fitToView() {
    if (!this.renderModel) return;
    this.camera.fitToView(this.renderModel.bounds, this.camera.viewportWidth, this.camera.viewportHeight, 0.9, FIT_MAX_ZOOM);
  }

  // The last-place ledger's camera half (anon-first-tree F6): a plain center+zoom
  // snapshot out, a teleport back in — a returning tab stands where the last one stood.
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

  // A pan gesture is underway: tell the shell so it can fade the editing chrome (WS-A),
  // then restore it a short quiet after the finger settles. Debounced — one `true` on
  // the first move of a gesture, one `false` ~200ms after the last. No-op in the editor
  // (no onPanStateChange passed), so any tool's pan can call this freely.
  reportPan() {
    if (!this.options.onPanStateChange) return;
    if (!this.panning) { this.panning = true; this.options.onPanStateChange(true); }
    clearTimeout(this.panSettleTimer);
    this.panSettleTimer = setTimeout(() => {
      this.panning = false;
      this.options.onPanStateChange(false);
    }, PAN_SETTLE_MS);
  }

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

  // Legend highlight: hold every node of one kind (hue) and fade the rest to a wash.
  // An overlay on the real selection — unlike spotlightNode it never touches setSelected,
  // so the current selection chrome stays put. Passing null clears back to the resting look.
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

  // World → screen pixels (the NodeOverlay placement formula), so a DOM overlay — the
  // coach chip — can anchor itself to a node and follow it across pan/zoom.
  projectToScreen(worldX, worldY) {
    return {
      x: (worldX - this.camera.x) * this.camera.zoom + this.camera.viewportWidth / 2,
      y: (worldY - this.camera.y) * this.camera.zoom + this.camera.viewportHeight / 2,
    };
  }

  // The camera's eased settle (0..1) of any in-flight reveal — the coach waits for 90%
  // before it mounts, so the chip lands as the pre-ease stills, not mid-glide.
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
    this.selectedIds = id ? new Set([id]) : new Set(); // a plain pick collapses any multi-selection
    this.setSelection(id);
    this.refreshHighlight(); // repaint even when setSelection's id-guard short-circuits (multi → same selectedId)
    this.selectEdge(null);
    if (this.options.onNodePick) this.options.onNodePick(id);
  }

  // Mirror React's multi-selection into the scene: store the set and repaint. The single-select
  // chrome still tracks selectedId (the size≤1 projection the shell keeps null above one) — this
  // only drives the GPU highlight, which the shader lifts identically for one node or many. Read-only
  // stores the set too now (Wave C): the phone owner's multi-select lights on the calm read-only
  // scene. A demoted view is already emptied by setReadOnly and never re-pushed a non-empty set.
  setSelectedSet(idSet) {
    this.selectedIds = idSet;
    this.refreshHighlight();
  }

  // A shift-click toggled a node — report it up so the shell reconciles the set (and the
  // selectedId projection); the scene sync effect pushes the result straight back.
  toggleSelect(id) {
    if (this.options.onSelectionToggle) this.options.onSelectionToggle(id);
  }

  // Mirror React's edge multi-selection into the connector highlight (editor-only; a demoted view
  // keeps it empty). The single selectedEdge chrome (EdgeChrome) is driven separately via selectEdge
  // — this only paints the GL highlight across the whole set, one branch or many.
  setSelectedEdges(keySet) {
    if (this.readOnly) return;
    this.selectedEdges = keySet;
    this.connectorBatch.setSelectedEdges(keySet);
  }

  // A shift-click toggled a branch — report it up so the shell reconciles the edge set (and the
  // single selectedEdge projection); the scene sync effect pushes the highlight straight back.
  toggleEdge(edge) {
    if (this.options.onEdgeToggle) this.options.onEdgeToggle(edge);
  }

  // A marquee drag moved: grow the band AND preview the nodes it now encloses with a lighter bark
  // ring (honest before commit — release promotes them to full members). The enclosure is the same
  // node-centre test commitMarquee uses, run live off the spatial grid, so the preview and the commit
  // can never disagree about which nodes the box takes.
  updateMarquee(x0, y0, x1, y1) {
    this.marqueeOverlay?.update(x0, y0, x1, y1);
    if (!this.spatialGrid) return;
    const a = this.camera.screenToWorld(x0, y0);
    const b = this.camera.screenToWorld(x1, y1);
    const ids = this.spatialGrid.within(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    this.nodeBatch.setMarqueePreview(new Set(ids));
  }

  // A marquee drag committed: turn the screen rect into the world-space nodes it encloses via
  // the spatial grid, hide the band, drop the pre-commit preview, and report the ids up (additive
  // when the drop held Shift) — the selection sync then promotes them to full bark members.
  commitMarquee(x0, y0, x1, y1, additive) {
    this.marqueeOverlay?.hide();
    this.nodeBatch.setMarqueePreview(new Set());
    if (!this.spatialGrid) return;
    const a = this.camera.screenToWorld(x0, y0);
    const b = this.camera.screenToWorld(x1, y1);
    const ids = this.spatialGrid.within(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    if (this.options.onMarqueeSelect) this.options.onMarqueeSelect(ids, additive);
  }

  // ---- Angular reorder (editing spec v2 §07) ------------------------------------------------
  // A node drag reslots the node among its same-parent siblings. The view supplies the sibling set
  // + their order keys (reorderContext); the scene owns the visual — lift the grabbed node, arc it
  // along its pinned-radius depth ring, preview the insertion slot — and reports the chosen
  // fractional key up (onSetNodeOrder) on release. The dispatch re-lays the tree and the ordinary
  // settle glides every sibling to even spacing, so the scene never eases the ring itself.
  beginReorder(id, sx, sy) {
    const node = this.nodesById.get(id);
    const context = this.options.reorderContext?.(id);
    if (!node || !context) { this.reorder = null; return; }
    const siblings = context.siblings
      .filter((s) => s.id !== id)
      .map((s) => { const n = this.nodesById.get(s.id); return n ? { id: s.id, order: s.order, x: n.x, y: n.y } : null; })
      .filter(Boolean);
    if (siblings.length === 0) { this.reorder = null; return; } // a lone child / single root can't move
    this.finishSettle(); // land any in-flight glide so moveNode owns the dragged node cleanly
    this.reorder = { id, radius: Math.hypot(node.x, node.y), siblings, homeX: node.x, homeY: node.y };
    this.nodeBatch.setMarqueePreview(new Set([id])); // the lift: a bark ring marks the grabbed node
    this.reorderSlot?.show();
    this.updateReorder(sx, sy);
  }

  updateReorder(sx, sy) {
    if (!this.reorder) return;
    const { id, radius, siblings } = this.reorder;
    const world = this.camera.screenToWorld(sx, sy);
    const angle = Math.atan2(world.y, world.x);
    this.moveNode(id, radius * Math.cos(angle), radius * Math.sin(angle)); // arc, radius pinned
    const index = circularInsertionIndex(siblings.map((s) => Math.atan2(s.y, s.x)), angle);
    const slot = this.slotAngle(siblings, index);
    const screen = this.camera.worldToScreen(radius * Math.cos(slot), radius * Math.sin(slot));
    this.reorderSlot?.moveTo(screen.x, screen.y, 1.3 * NODE_SIZE * this.camera.zoom);
  }

  commitReorder(sx, sy) {
    if (!this.reorder) return;
    const { id, siblings } = this.reorder;
    const plan = reorderPlan(siblings, this.camera.screenToWorld(sx, sy));
    this.clearReorder(); // drop the lift + slot before the model rebuild glides everyone
    if (plan) this.options.onSetNodeOrder?.(id, plan.key);
  }

  cancelReorder() {
    if (!this.reorder) return;
    const { id, homeX, homeY } = this.reorder;
    this.clearReorder();
    this.moveNode(id, homeX, homeY); // no dispatch: snap the arc back to the seat it left
  }

  clearReorder() {
    this.nodeBatch.setMarqueePreview(new Set());
    this.reorderSlot?.hide();
    this.reorder = null;
  }

  // The angle of the insertion slot at `index` — the midpoint of the gap the dragged node will drop
  // into, so the dashed ring previews the resulting seat. The ends borrow half the seam (wrap) gap.
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
    if (edge && this.selectedIds.size > 0) this.select(null); // clear any node selection — multi too (selectedId is null above 1)
    this.selectedEdge = edge ?? null;
    this.edgeChrome?.setSelectedEdge(this.selectedEdge);
    this.overlaysDirty = true;
  }

  // Set the single-edge projection WITHOUT selectEdge's user-pick side effects (no node-clear, no
  // report up). The shell's reconciliation already owns the exact target sets, so it must drive the
  // projection through here — routing it through selectEdge would fire a node-clear cascade off
  // lagging scene state, wiping a still-selected edge. selectEdge keeps those side effects for a
  // genuine plain edge pick, where clearing any node selection is the right thing.
  projectEdge(edge) {
    this.selectedEdge = edge ?? null;
    this.edgeChrome?.setSelectedEdge(this.selectedEdge);
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

  // Install (or clear) the phone-editing tap override — React hands (x, y) and owns the
  // mode logic; null restores the tool's default read-only select (Wave B).
  setEditTap(fn) { this.editTap = fn; }

  // Install (or clear) the phone long-press override — React gets a real node id and enters
  // multi-select (Wave C, M5); null disarms the hold (the tool's default select is unchanged).
  setLongPress(fn) { this.longPress = fn; }

  // Hovering a branch only deepens its line + a pointer cursor — never chrome.
  hoverEdge(edge) {
    const next = edge ?? null;
    if (next === this.hoveredEdge) return;
    this.hoveredEdge = next;
    this.connectorBatch.setHovered(next);
    this.canvas.style.cursor = next ? 'pointer' : '';
  }

  refreshHighlight() {
    // Editor: the node highlight is the SET — one, mixed, or many all sweep the same way, and a
    // deselect clears stale slots. Read-only single-select tracks the lone selectedId, but the
    // phone owner's multi-select (Wave C) lights the whole set with the same glow: a non-empty set
    // wins, otherwise the single selectedId (setSelected and a size-1 sweep light one node alike).
    if (this.readOnly) {
      if (this.selectedIds.size > 0) this.nodeBatch.setSelectedSet(this.selectedIds);
      else this.nodeBatch.setSelected(this.selectedId);
      this.connectorBatch.setInSetEdges(this.selectedIds); // inside-set links light on the phone bulk select too
      return;
    }
    this.nodeBatch.setSelectedSet(this.selectedIds);
    this.connectorBatch.setInSetEdges(this.selectedIds); // brighten a branch whose both ends are in the set
  }

  pick(x, y) {
    if (!this.spatialGrid) return null;
    const world = this.camera.screenToWorld(x, y);
    // Read-only touch: floor the pick disc at ≥44px on screen so small nodes stay
    // tappable, regardless of how far the tree is zoomed out.
    const radius = this.readOnly ? Math.max(PICK_RADIUS, TOUCH_HIT_RADIUS / this.camera.zoom) : PICK_RADIUS;
    return this.spatialGrid.nearest(world.x, world.y, radius);
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
