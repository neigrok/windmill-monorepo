// Every edge tessellated once into a bézier ribbon, merged into one buffer and drawn in a single call. setStates rewrites only the aActive / aGrowStart floats, never vertex positions.
import { createProgram, uniformLocations } from './glcore.js';
import { NODE_COLOR_NAMES, isDone, NODE_SIZE } from '../theme.js';
import { edgeKey } from './edgeKey.js';
import { sceneHierarchy, spotlightEdges, edgeVisibility } from './sceneHierarchy.js';

const SEGMENTS = 14;
const HALF_WIDTH = 1;
const BEND_FACTOR = 0.18;
const GROW_DURATION = 0.5;
const SOLO_SPEED = 400; // world-px/s
const MIN_TRAVEL = 0.28; // seconds
const MAX_TRAVEL = 0.62; // seconds
const ALREADY_GROWN = -1000;
const VERTS_PER_EDGE = (SEGMENTS + 1) * 2;
const NC = NODE_COLOR_NAMES.length;

// Matches NodeBatch's disc edge (0.84 of its half-size): edges stop at the rim, not the centre.
const NODE_RADIUS = NODE_SIZE * 0.42;

const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in float aAlongT;
layout(location=2) in float aActive;
layout(location=3) in float aGrowStart;
layout(location=4) in float aColor;
layout(location=5) in float aHover;
layout(location=7) in float aDim;
layout(location=8) in float aDuration;
layout(location=9) in float aLength;
layout(location=10) in float aHead;
layout(location=11) in float aSelected;
layout(location=12) in float aInSet;
layout(location=13) in vec2 aCenter;
layout(location=14) in float aVisibility;
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
out float vActive;
out float vAlongT;
out float vGrowStart;
out float vColor;
out float vHover;
out float vDim;
out float vDuration;
out float vLength;
out float vHead;
out float vSelected;
out float vInSet;
out float vVisibility;
void main() {
  vActive = aActive;
  vAlongT = aAlongT;
  vGrowStart = aGrowStart;
  vColor = aColor;
  vHover = aHover;
  vDim = aDim;
  vDuration = aDuration;
  vLength = aLength;
  vHead = aHead;
  vSelected = aSelected;
  vInSet = aInSet;
  vVisibility = aVisibility;
  float emphasis = max(max(aSelected, aHover), max(aInSet, step(1.5, aVisibility)));
  float halfWidth = mix(0.625, 1.0, emphasis);
  vec2 screen = (aCenter - uCamera) * uZoom + (aPos - aCenter) * halfWidth;
  vec2 clip = vec2(screen.x / (uResolution.x * 0.5), -screen.y / (uResolution.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in float vActive;
in float vAlongT;
in float vGrowStart;
in float vColor;
in float vHover;
in float vDim;
in float vDuration;
in float vLength;
in float vHead;
in float vSelected;
in float vInSet;
in float vVisibility;
uniform float uTime;
uniform float uGrowDuration;
uniform float uMotion;
uniform vec3 uColorInactive;
uniform vec3 uColorHot;
uniform vec3 uBarkCream;
uniform vec3 uEdgeColor[${NC}];
out vec4 fragColor;
void main() {
  if (vVisibility < 0.5) discard;
  vec3 hue = uEdgeColor[int(vColor + 0.5)];
  vec3 dim = mix(uColorInactive, hue, 0.6); // dormant branch: a muted tint of its kind

  float head = 0.0; // comet contribution (front core + trailing wake)
  if (uMotion > 0.5) {
    // travel beat: a parent->child reveal front trailed by a comet head + fading tail
    float dur = vDuration > 0.0 ? vDuration : uGrowDuration; // per-edge, length-derived
    float progress = clamp((uTime - vGrowStart) / dur, 0.0, 1.0);
    float tailFrac = 24.0 / max(vLength, 1.0); // 24 world-px wake, in vAlongT units
    float coreFrac = 10.0 / max(vLength, 1.0); // tight bright band on the front
    float dist = vAlongT - progress; // <0 behind the front, where the wake trails
    float onEdge = vActive * vHead * (1.0 - smoothstep(0.9, 1.0, progress)); // comet vanishes as the front lands
    float core = (1.0 - smoothstep(0.0, coreFrac, abs(dist))) * onEdge;
    float tail = (dist <= 0.0 ? exp(dist / tailFrac) : 0.0) * onEdge; // exp fade over ~24px
    head = max(core, tail);
  }

  float emphasis = max(max(vSelected, vHover), max(vInSet, step(1.5, vVisibility)));
  vec3 color = mix(dim, hue, emphasis);
  float alpha = mix(vDim > 0.5 ? 0.12 : 0.26, 0.86, emphasis);
  color = mix(color, uColorHot, vHover * 0.4);
  color = mix(color, uBarkCream, vInSet * 0.5);
  color += hue * head * 0.25;
  alpha = max(alpha, head * 0.85);
  fragColor = vec4(color, alpha);
}`;

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

// `sway` is the edge's own bow, in [-0.5, 0.5), hashed from the two node ids by bendOf. Never derive it from the endpoint coordinates, or a drag re-rolls the curve every frame.
function controlPoint(fx, fy, tx, ty, sway) {
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = sway * len * BEND_FACTOR;
  return { cx: (fx + tx) / 2 + nx * bend, cy: (fy + ty) / 2 + ny * bend };
}

export function bendOf(fromId, toId) {
  return (hashStr(`${fromId}-${toId}`) % 100) / 100 - 0.5;
}

// The curve parameter range that lies outside both endpoint discs, so the drawn ribbon meets each node’s boundary instead of running to its centre.
function trimRange(fx, fy, cx, cy, tx, ty) {
  const at = (t) => {
    const omt = 1 - t;
    return [omt * omt * fx + 2 * omt * t * cx + t * t * tx, omt * omt * fy + 2 * omt * t * cy + t * t * ty];
  };
  const STEPS = 64;
  let t0 = 0;
  for (let i = 1; i <= STEPS; i++) {
    const [x, y] = at(i / STEPS);
    if (Math.hypot(x - fx, y - fy) >= NODE_RADIUS) { t0 = i / STEPS; break; }
  }
  let t1 = 1;
  for (let i = STEPS - 1; i >= 0; i--) {
    const [x, y] = at(i / STEPS);
    if (Math.hypot(x - tx, y - ty) >= NODE_RADIUS) { t1 = i / STEPS; break; }
  }
  if (t0 >= t1) return [0, 1];
  return [t0, t1];
}

function colorIndex(name) {
  const i = NODE_COLOR_NAMES.indexOf(name);
  return i < 0 ? 0 : i;
}

function travelDuration(lengthWorld) {
  return Math.min(MAX_TRAVEL, Math.max(MIN_TRAVEL, lengthWorld / SOLO_SPEED));
}

// Only positions depend on the endpoints; the along/active/color attributes are constant under a move.
export function writeEdgePositions(positions, vertexStart, fx, fy, tx, ty, halfWidth, sway) {
  const { cx, cy } = controlPoint(fx, fy, tx, ty, sway);
  const [t0, t1] = trimRange(fx, fy, cx, cy, tx, ty);
  const span = t1 - t0;
  let length = 0;
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = t0 + span * (i / SEGMENTS);
    const omt = 1 - t;
    const px = omt * omt * fx + 2 * omt * t * cx + t * t * tx;
    const py = omt * omt * fy + 2 * omt * t * cy + t * t * ty;
    if (i > 0) length += Math.hypot(px - prevX, py - prevY);
    prevX = px;
    prevY = py;
    const dx = 2 * omt * (cx - fx) + 2 * t * (tx - cx);
    const dy = 2 * omt * (cy - fy) + 2 * t * (ty - cy);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const v = vertexStart + i * 2;
    positions[v * 2] = px + nx * halfWidth;
    positions[v * 2 + 1] = py + ny * halfWidth;
    positions[(v + 1) * 2] = px - nx * halfWidth;
    positions[(v + 1) * 2 + 1] = py - ny * halfWidth;
  }
  return length;
}

export class ConnectorBatch {
  constructor(gl, theme) {
    this.gl = gl;
    this.indexCount = 0;
    this.edges = [];

    this.program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    this.u = uniformLocations(gl, this.program, ['uResolution', 'uCamera', 'uZoom', 'uTime', 'uGrowDuration', 'uMotion', 'uColorInactive', 'uColorHot', 'uBarkCream', 'uEdgeColor']);
    this.setTheme(theme);
    this.hoveredEdge = -1;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuffer = this.attrib(0, 2, gl.STATIC_DRAW);
    this.alongBuffer = this.attrib(1, 1, gl.STATIC_DRAW);
    this.activeBuffer = this.attrib(2, 1, gl.DYNAMIC_DRAW);
    this.growBuffer = this.attrib(3, 1, gl.DYNAMIC_DRAW);
    this.colorBuffer = this.attrib(4, 1, gl.STATIC_DRAW);
    this.hoverBuffer = this.attrib(5, 1, gl.DYNAMIC_DRAW);
    this.dimBuffer = this.attrib(7, 1, gl.DYNAMIC_DRAW);
    this.durationBuffer = this.attrib(8, 1, gl.DYNAMIC_DRAW);
    this.lengthBuffer = this.attrib(9, 1, gl.DYNAMIC_DRAW);
    this.headBuffer = this.attrib(10, 1, gl.DYNAMIC_DRAW);
    this.selectedBuffer = this.attrib(11, 1, gl.DYNAMIC_DRAW);
    this.inSetBuffer = this.attrib(12, 1, gl.DYNAMIC_DRAW);
    this.centerBuffer = this.attrib(13, 2, gl.STATIC_DRAW);
    this.visibilityBuffer = this.attrib(14, 1, gl.DYNAMIC_DRAW);
    this.spotlit = null;
    this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(null);
  }

  attrib(location, size) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    return buffer;
  }

  setModel(renderModel) {
    const gl = this.gl;
    const nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    const edgeCount = renderModel.edges.length;
    const vertexTotal = edgeCount * VERTS_PER_EDGE;

    this.positions = new Float32Array(vertexTotal * 2);
    this.centers = new Float32Array(vertexTotal * 2);
    this.visibility = new Float32Array(vertexTotal);
    this.hierarchy = sceneHierarchy(renderModel.nodes, renderModel.edges);
    this.spotlightKeys = new Set();
    this.selectedKeys = new Set();
    this.selectedNodeIds = new Set();
    this.projectedEdgeKey = null;
    this.visibilityDirty = true;
    this.visibilityView = null;
    this.travelUntil = 0;
    const along = new Float32Array(vertexTotal);
    const colors = new Float32Array(vertexTotal);
    this.active = new Float32Array(vertexTotal);
    this.grow = new Float32Array(vertexTotal).fill(ALREADY_GROWN);
    this.hover = new Float32Array(vertexTotal);
    this.dim = new Float32Array(vertexTotal);
    this.duration = new Float32Array(vertexTotal); // per-edge travel seconds
    this.length = new Float32Array(vertexTotal); // per-edge world length
    this.head = new Float32Array(vertexTotal); // 1 on edges lit via travel(): enables the comet
    this.selected = new Float32Array(vertexTotal); // 1 on multi-selected edges
    this.inSet = new Float32Array(vertexTotal); // 1 when BOTH endpoints are in the node selection
    this.hoveredEdge = -1;
    this.spotlit = null;
    const indices = new Uint32Array(edgeCount * SEGMENTS * 6);

    this.nodePos = new Map(renderModel.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    this.edgesByNode = new Map();
    this.edgeIndex = new Map();

    this.edges = renderModel.edges.map((edge, e) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const vertexStart = e * VERTS_PER_EDGE;
      const active = isDone(from.state) ? 1 : 0;
      const colorIdx = colorIndex(from.color);
      const halfWidth = HALF_WIDTH;

      const sway = bendOf(edge.from, edge.to);
      const length = writeEdgePositions(this.positions, vertexStart, from.x, from.y, to.x, to.y, halfWidth, sway);
      const duration = travelDuration(length);
      this.writeCenters(vertexStart);
      for (let i = 0; i <= SEGMENTS; i++) {
        const v = vertexStart + i * 2;
        const local = i / SEGMENTS;
        along[v] = local; along[v + 1] = local;
        this.active[v] = active; this.active[v + 1] = active;
        colors[v] = colorIdx; colors[v + 1] = colorIdx;
        this.duration[v] = duration; this.duration[v + 1] = duration;
        this.length[v] = length; this.length[v + 1] = length;
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const a = vertexStart + i * 2;
        const o = (e * SEGMENTS + i) * 6;
        indices[o] = a; indices[o + 1] = a + 1; indices[o + 2] = a + 2;
        indices[o + 3] = a + 1; indices[o + 4] = a + 3; indices[o + 5] = a + 2;
      }
      for (const nid of [edge.from, edge.to]) {
        if (!this.edgesByNode.has(nid)) this.edgesByNode.set(nid, []);
        this.edgesByNode.get(nid).push(e);
      }
      this.edgeIndex.set(`${edge.from}→${edge.to}`, e);
      return { modelEdge: edge, overview: this.hierarchy.backboneKeys.has(edgeKey(edge.from, edge.to)), from: edge.from, to: edge.to, kind: edge.kind, key: edgeKey(edge.from, edge.to), active, vertexStart, halfWidth, length, duration, sway };
    });

    this.indexCount = indices.length;
    gl.bindVertexArray(this.vao);
    this.uploadStatic(this.posBuffer, this.positions);
    this.uploadStatic(this.centerBuffer, this.centers);
    this.uploadDynamic(this.visibilityBuffer, this.visibility);
    this.uploadStatic(this.alongBuffer, along);
    this.uploadStatic(this.colorBuffer, colors);
    this.uploadDynamic(this.activeBuffer, this.active);
    this.uploadDynamic(this.growBuffer, this.grow);
    this.uploadDynamic(this.hoverBuffer, this.hover);
    this.uploadDynamic(this.dimBuffer, this.dim);
    this.uploadDynamic(this.durationBuffer, this.duration);
    this.uploadDynamic(this.lengthBuffer, this.length);
    this.uploadDynamic(this.headBuffer, this.head);
    this.uploadDynamic(this.selectedBuffer, this.selected);
    this.uploadDynamic(this.inSetBuffer, this.inSet);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  writeCenters(start) {
    for (let v = start; v < start + VERTS_PER_EDGE; v += 2) {
      const x = (this.positions[v * 2] + this.positions[(v + 1) * 2]) / 2;
      const y = (this.positions[v * 2 + 1] + this.positions[(v + 1) * 2 + 1]) / 2;
      this.centers[v * 2] = x;
      this.centers[(v + 1) * 2] = x;
      this.centers[v * 2 + 1] = y;
      this.centers[(v + 1) * 2 + 1] = y;
    }
  }

  // Re-tessellate only the edges touching a moved node and re-upload their vertex ranges in place.
  moveNode(id, x, y) {
    const pos = this.nodePos.get(id);
    if (!pos) return;
    pos.x = x;
    pos.y = y;
    this.visibilityDirty = true;
    const indices = this.edgesByNode.get(id);
    if (!indices || indices.length === 0) return;
    const gl = this.gl;
    for (const e of indices) {
      const edge = this.edges[e];
      const from = this.nodePos.get(edge.from);
      const to = this.nodePos.get(edge.to);
      const length = writeEdgePositions(this.positions, edge.vertexStart, from.x, from.y, to.x, to.y, edge.halfWidth, edge.sway);
      this.writeCenters(edge.vertexStart);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.centerBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, edge.vertexStart * 2 * 4, this.centers, edge.vertexStart * 2, VERTS_PER_EDGE * 2);
      edge.length = length;
      edge.duration = travelDuration(length);
      const start = edge.vertexStart;
      this.length.fill(length, start, start + VERTS_PER_EDGE);
      this.duration.fill(edge.duration, start, start + VERTS_PER_EDGE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 2 * 4, this.positions, start * 2, VERTS_PER_EDGE * 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lengthBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, this.length, start, VERTS_PER_EDGE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.durationBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, this.duration, start, VERTS_PER_EDGE);
    }
  }

  uploadStatic(buffer, data) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); }
  uploadDynamic(buffer, data) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }

  setStates(statesMap, elapsedSeconds) {
    if (!this.active) return;
    let changed = false;
    for (const edge of this.edges) {
      const state = statesMap.get(edge.from);
      if (state === undefined) continue;
      const next = isDone(state) ? 1 : 0;
      if (next === edge.active) continue;
      edge.active = next;
      changed = true;
      for (let v = edge.vertexStart; v < edge.vertexStart + VERTS_PER_EDGE; v++) {
        this.active[v] = next;
        if (next === 1) this.grow[v] = elapsedSeconds;
      }
    }
    if (changed) {
      this.uploadDynamic(this.activeBuffer, this.active);
      this.uploadDynamic(this.growBuffer, this.grow);
    }
  }

  // Light one edge from atSeconds and fire its comet head down the ribbon parent->child; durationMs overrides the length-derived duration.
  travel(from, to, atSeconds, opts = {}) {
    if (!this.active) return;
    const e = this.edgeIndex.get(`${from}→${to}`);
    if (e === undefined) return;
    const edge = this.edges[e];
    const duration = opts.durationMs != null ? opts.durationMs / 1000 : travelDuration(edge.length);
    edge.active = 1;
    edge.duration = duration;
    edge.travelStart = atSeconds;
    edge.travelEnd = atSeconds + duration;
    this.travelUntil = Math.max(this.travelUntil, edge.travelEnd);
    this.visibilityDirty = true;
    const start = edge.vertexStart;
    for (let v = start; v < start + VERTS_PER_EDGE; v++) {
      this.active[v] = 1;
      this.grow[v] = atSeconds;
      this.duration[v] = duration;
      this.head[v] = 1;
    }
    const gl = this.gl;
    for (const [buffer, data] of [[this.activeBuffer, this.active], [this.growBuffer, this.grow], [this.durationBuffer, this.duration], [this.headBuffer, this.head]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, data, start, VERTS_PER_EDGE);
    }
  }

  // Length-derived travel time, in milliseconds.
  edgeDuration(from, to) {
    const e = this.edgeIndex.get(`${from}→${to}`);
    if (e === undefined) return 0;
    return travelDuration(this.edges[e].length) * 1000;
  }

  setHovered(edge) {
    if (!this.hover) return;
    const next = edge == null ? -1 : (this.edgeIndex.get(`${edge.from}→${edge.to}`) ?? -1);
    if (next === this.hoveredEdge) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hoverBuffer);
    for (const [e, value] of [[this.hoveredEdge, 0], [next, 1]]) {
      if (e < 0) continue;
      const start = this.edges[e].vertexStart;
      this.hover.fill(value, start, start + VERTS_PER_EDGE);
      gl.bufferSubData(gl.ARRAY_BUFFER, start * 4, this.hover, start, VERTS_PER_EDGE);
    }
    this.hoveredEdge = next;
  }

  setSpotlight(nodeId) {
    if (!this.dim || nodeId === this.spotlit) return;
    this.spotlit = nodeId;
    this.spotlightKeys = spotlightEdges(nodeId, this.hierarchy, this.edgesByNode, this.edges);
    for (const edge of this.edges) {
      const value = nodeId == null ? 0 : this.spotlightKeys.has(edge.key) ? -1 : 1;
      this.dim.fill(value, edge.vertexStart, edge.vertexStart + VERTS_PER_EDGE);
    }
    this.uploadDynamic(this.dimBuffer, this.dim);
    this.visibilityDirty = true;
  }

  setProjectedEdge(edge) {
    this.projectedEdgeKey = edge ? edgeKey(edge.from, edge.to) : null;
    this.visibilityDirty = true;
  }

  visibilityFor(edge, camera, timeSeconds = 0, viewport = camera.getViewport()) {
    const key = edge.key ?? edgeKey(edge.from, edge.to);
    const emphasized = this.spotlightKeys.has(key) || this.selectedKeys.has(key) || key === this.projectedEdgeKey
      || (this.selectedNodeIds.has(edge.from) && this.selectedNodeIds.has(edge.to))
      || (timeSeconds >= edge.travelStart && timeSeconds <= edge.travelEnd);
    return edgeVisibility(edge, this.nodePos.get(edge.from), this.nodePos.get(edge.to), viewport, camera.zoom, emphasized);
  }

  pickEdge(sx, sy, camera, timeSeconds, screenRadius) {
    const world = camera.screenToWorld(sx, sy);
    const viewport = camera.getViewport();
    let nearest = null;
    let distance = screenRadius / camera.zoom;
    for (const edge of this.edges) {
      if (!this.visibilityFor(edge, camera, timeSeconds, viewport)) continue;
      for (let vertex = edge.vertexStart; vertex < edge.vertexStart + VERTS_PER_EDGE - 2; vertex += 2) {
        const ax = this.centers[vertex * 2];
        const ay = this.centers[vertex * 2 + 1];
        const dx = this.centers[(vertex + 2) * 2] - ax;
        const dy = this.centers[(vertex + 2) * 2 + 1] - ay;
        const t = Math.max(0, Math.min(1, ((world.x - ax) * dx + (world.y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const next = Math.hypot(world.x - ax - t * dx, world.y - ay - t * dy);
        if (next >= distance) continue;
        distance = next;
        nearest = edge.modelEdge;
      }
    }
    return nearest;
  }

  updateVisibility(camera, timeSeconds) {
    const view = `${camera.x}|${camera.y}|${camera.zoom}|${camera.viewportWidth}|${camera.viewportHeight}`;
    if (!this.visibilityDirty && this.visibilityView === view && timeSeconds > this.travelUntil) return;
    const viewport = camera.getViewport();
    for (const edge of this.edges) {
      this.visibility.fill(this.visibilityFor(edge, camera, timeSeconds, viewport), edge.vertexStart, edge.vertexStart + VERTS_PER_EDGE);
    }
    this.uploadDynamic(this.visibilityBuffer, this.visibility);
    this.visibilityView = view;
    this.visibilityDirty = timeSeconds <= this.travelUntil;
  }

  // Every edge whose key is in the set reads aSelected=1.
  setSelectedEdges(keySet) {
    if (!this.selected) return;
    this.selectedKeys = new Set(keySet);
    this.visibilityDirty = true;
    for (const edge of this.edges) {
      const on = keySet.has(edgeKey(edge.from, edge.to)) ? 1 : 0;
      this.selected.fill(on, edge.vertexStart, edge.vertexStart + VERTS_PER_EDGE);
    }
    this.uploadDynamic(this.selectedBuffer, this.selected);
  }

  // Every edge with BOTH endpoints in the node selection reads aInSet=1.
  setInSetEdges(nodeIdSet) {
    if (!this.inSet) return;
    this.selectedNodeIds = new Set(nodeIdSet);
    this.visibilityDirty = true;
    for (const edge of this.edges) {
      const on = nodeIdSet.has(edge.from) && nodeIdSet.has(edge.to) ? 1 : 0;
      this.inSet.fill(on, edge.vertexStart, edge.vertexStart + VERTS_PER_EDGE);
    }
    this.uploadDynamic(this.inSetBuffer, this.inSet);
  }

  draw(camera, timeSeconds, motion) {
    const gl = this.gl;
    if (this.indexCount === 0) return;
    this.updateVisibility(camera, timeSeconds);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uResolution, camera.viewportWidth, camera.viewportHeight);
    gl.uniform2f(this.u.uCamera, camera.x, camera.y);
    gl.uniform1f(this.u.uZoom, camera.zoom);
    gl.uniform1f(this.u.uTime, timeSeconds);
    gl.uniform1f(this.u.uGrowDuration, GROW_DURATION);
    gl.uniform1f(this.u.uMotion, motion);
    gl.uniform3fv(this.u.uColorInactive, this.colorInactive);
    gl.uniform3fv(this.u.uColorHot, this.colorHot);
    gl.uniform3fv(this.u.uBarkCream, this.barkCream);
    gl.uniform3fv(this.u.uEdgeColor, this.edgeColors);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  // Colours are uniforms, re-sent every draw, so a theme change needs no buffer rewrite.
  setTheme(theme) {
    this.colorInactive = hexRgb(theme.CONNECTOR.inactive);
    this.colorHot = hexRgb(theme.CONNECTOR.active);
    this.barkCream = hexRgb(theme.BARK_CREAM);
    this.edgeColors = new Float32Array(NODE_COLOR_NAMES.flatMap((c) => hexRgb(theme.NODE_COLORS[c].base)));
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    [this.posBuffer, this.alongBuffer, this.activeBuffer, this.growBuffer, this.colorBuffer, this.hoverBuffer, this.dimBuffer, this.durationBuffer, this.lengthBuffer, this.headBuffer, this.selectedBuffer, this.inSetBuffer, this.centerBuffer, this.visibilityBuffer, this.indexBuffer].forEach((b) => gl.deleteBuffer(b));
  }
}
