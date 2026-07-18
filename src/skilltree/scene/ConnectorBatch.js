// Every edge tessellated once into a bézier ribbon, merged into one buffer and
// drawn in a single call. A branch inherits its source node (design SkillConnector):
// once the source is done it lights up in that node's kind hue with a GPU color
// sweep and a glow; while the source is not-done it's a thin muted line.
// setStates only rewrites the aActive / aGrowStart floats, never vertex positions;
// hue is baked once and never changes.
import { createProgram, uniformLocations } from './glcore.js';
import { NODE_COLORS, NODE_COLOR_NAMES, isDone, CONNECTOR, NODE_SIZE } from '../theme.js';
import { edgeKey } from './edgeKey.js';

const SEGMENTS = 14;
const WIDTH = 4;
const KIND_HALF_WIDTH = { trunk: 2.6, 'in-branch': 1.6, 'cross-branch': 1.3 };
const KIND_CODE = { trunk: 0, 'in-branch': 1, 'cross-branch': 2 };
const BEND_FACTOR = 0.18;
const GROW_DURATION = 0.5;
const SOLO_SPEED = 400; // world-px/s the travel front covers a solo edge (slowed so it reads)
const MIN_TRAVEL = 0.28; // seconds — floor so short edges still read as motion
const MAX_TRAVEL = 0.62; // seconds — ceiling so long trunks don't drag
const ALREADY_GROWN = -1000;
const VERTS_PER_EDGE = (SEGMENTS + 1) * 2;
const NC = NODE_COLOR_NAMES.length;
const HOVER_COLOR = '#B29F7B'; // the hot hue a hovered branch deepens to

// A node's disc renders out to EDGE (0.84) of its half-size in NodeBatch, so its
// world radius is 0.84 * NODE_SIZE/2. Ending edges here (rather than at the node
// centre) keeps them out from under the translucent dim body.
const NODE_RADIUS = NODE_SIZE * 0.42;

const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in float aAlongT;
layout(location=2) in float aActive;
layout(location=3) in float aGrowStart;
layout(location=4) in float aColor;
layout(location=5) in float aHover;
layout(location=6) in float aKind;
layout(location=7) in float aDim;
layout(location=8) in float aDuration;
layout(location=9) in float aLength;
layout(location=10) in float aHead;
layout(location=11) in float aSelected;
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
out float vActive;
out float vAlongT;
out float vGrowStart;
out float vColor;
out float vHover;
out float vKind;
out float vDim;
out float vDuration;
out float vLength;
out float vHead;
out float vSelected;
void main() {
  vActive = aActive;
  vAlongT = aAlongT;
  vGrowStart = aGrowStart;
  vColor = aColor;
  vHover = aHover;
  vKind = aKind;
  vDim = aDim;
  vDuration = aDuration;
  vLength = aLength;
  vHead = aHead;
  vSelected = aSelected;
  vec2 screen = (aPos - uCamera) * uZoom;
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
in float vKind;
in float vDim;
in float vDuration;
in float vLength;
in float vHead;
in float vSelected;
uniform float uTime;
uniform float uGrowDuration;
uniform float uMotion;
uniform vec3 uColorInactive;
uniform vec3 uColorHot;
uniform vec3 uEdgeColor[${NC}];
out vec4 fragColor;
void main() {
  vec3 hue = uEdgeColor[int(vColor + 0.5)];
  vec3 dim = mix(uColorInactive, hue, 0.6); // dormant branch: a muted tint of its kind

  float lit;
  float head = 0.0; // comet contribution (front core + trailing wake)
  float core = 0.0; // the bright front band alone
  if (uMotion < 0.5) {
    // reduced motion: the whole edge cross-fades dim->lit over 150ms — no sweep, no comet
    lit = vActive * clamp((uTime - vGrowStart) / 0.15, 0.0, 1.0);
  } else {
    // travel beat: a parent->child reveal front trailed by a comet head + fading tail
    float dur = vDuration > 0.0 ? vDuration : uGrowDuration; // per-edge, length-derived
    float progress = clamp((uTime - vGrowStart) / dur, 0.0, 1.0);
    lit = vActive * (1.0 - smoothstep(progress - 0.08, progress, vAlongT)); // wakes behind the front
    float tailFrac = 24.0 / max(vLength, 1.0); // 24 world-px wake, in vAlongT units
    float coreFrac = 10.0 / max(vLength, 1.0); // tight bright band on the front
    float dist = vAlongT - progress; // <0 behind the front, where the wake trails
    float onEdge = vActive * vHead * (1.0 - smoothstep(0.9, 1.0, progress)); // comet vanishes as the front lands
    core = (1.0 - smoothstep(0.0, coreFrac, abs(dist))) * onEdge;
    float tail = (dist <= 0.0 ? exp(dist / tailFrac) : 0.0) * onEdge; // exp fade over ~24px
    head = max(core, tail);
  }

  vec3 color = mix(dim, hue, lit) + hue * lit * 0.16; // +0.16 static glow on the woken body
  color += hue * head * 0.6; // comet: additive kind-hue highlight, ~2x brighter at the front
  color = mix(color, vec3(1.0), core * 0.3); // hottest white at the very front
  float alpha = mix(0.6, 0.95, lit);
  alpha = max(alpha, head * 0.9);
  float deemph = vKind < 0.5 ? 1.0 : (vKind < 1.5 ? 0.7 : 0.4); // non-trunk edges recede
  color = mix(color, dim, (1.0 - deemph) * 0.6);
  alpha *= deemph;
  color = mix(color, uColorHot, vHover); // hover deepens the line to the hot hue
  alpha = mix(alpha, 0.95, vHover);
  color = mix(color, dim, vDim * 0.5); // spotlight: branches off the focused node recede
  alpha *= 1.0 - vDim * 0.72;
  // selected (desktop multi-select): the branch reads picked — a soft brighten toward white
  // plus an additive lift in its own kind hue, brought to near-full opacity so even a dormant
  // edge stands out. Last say, so a selected edge is never dimmed; distinct from hover's deepen.
  color = mix(color, vec3(1.0), vSelected * 0.20);
  color += hue * vSelected * 0.28;
  alpha = max(alpha, vSelected * 0.9);
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

function controlPoint(fx, fy, tx, ty) {
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = ((hashStr(`${fx},${fy}-${tx},${ty}`) % 100) / 100 - 0.5) * len * BEND_FACTOR;
  return { cx: (fx + tx) / 2 + nx * bend, cy: (fy + ty) / 2 + ny * bend };
}

// The curve parameter range that lies outside both endpoint discs, so the drawn
// ribbon meets each node's boundary instead of running to its centre. Scans the
// bézier (setModel runs once) for the first/last t past NODE_RADIUS.
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

// Solo travel time for one edge: its front covers SOLO_SPEED world-px/s, clamped so
// even short edges register as motion and long trunks never drag. Seconds.
function travelDuration(lengthWorld) {
  return Math.min(MAX_TRAVEL, Math.max(MIN_TRAVEL, lengthWorld / SOLO_SPEED));
}

// Tessellate one edge's bézier ribbon into `positions` at its vertex range. Only
// the positions depend on the endpoints, so both setModel (bulk) and moveNode
// (a single node's incident edges) go through here; the along/active/color
// attributes are constant under a move and written once.
function writeEdgePositions(positions, vertexStart, fx, fy, tx, ty, halfWidth) {
  const { cx, cy } = controlPoint(fx, fy, tx, ty);
  const [t0, t1] = trimRange(fx, fy, cx, cy, tx, ty);
  const span = t1 - t0;
  let length = 0; // centerline polyline length — drives per-edge travel duration
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
  constructor(gl) {
    this.gl = gl;
    this.indexCount = 0;
    this.edges = [];

    this.program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    this.u = uniformLocations(gl, this.program, ['uResolution', 'uCamera', 'uZoom', 'uTime', 'uGrowDuration', 'uMotion', 'uColorInactive', 'uColorHot', 'uEdgeColor']);
    this.colorInactive = hexRgb(CONNECTOR.inactive);
    this.colorHot = hexRgb(HOVER_COLOR);
    this.edgeColors = new Float32Array(NODE_COLOR_NAMES.flatMap((c) => hexRgb(NODE_COLORS[c].base)));
    this.hoveredEdge = -1;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuffer = this.attrib(0, 2, gl.STATIC_DRAW);
    this.alongBuffer = this.attrib(1, 1, gl.STATIC_DRAW);
    this.activeBuffer = this.attrib(2, 1, gl.DYNAMIC_DRAW);
    this.growBuffer = this.attrib(3, 1, gl.DYNAMIC_DRAW);
    this.colorBuffer = this.attrib(4, 1, gl.STATIC_DRAW);
    this.hoverBuffer = this.attrib(5, 1, gl.DYNAMIC_DRAW);
    this.kindBuffer = this.attrib(6, 1);
    this.dimBuffer = this.attrib(7, 1, gl.DYNAMIC_DRAW);
    this.durationBuffer = this.attrib(8, 1, gl.DYNAMIC_DRAW);
    this.lengthBuffer = this.attrib(9, 1, gl.DYNAMIC_DRAW);
    this.headBuffer = this.attrib(10, 1, gl.DYNAMIC_DRAW);
    this.selectedBuffer = this.attrib(11, 1, gl.DYNAMIC_DRAW);
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
    const along = new Float32Array(vertexTotal);
    const colors = new Float32Array(vertexTotal);
    const kinds = new Float32Array(vertexTotal);
    this.active = new Float32Array(vertexTotal);
    this.grow = new Float32Array(vertexTotal).fill(ALREADY_GROWN);
    this.hover = new Float32Array(vertexTotal);
    this.dim = new Float32Array(vertexTotal);
    this.duration = new Float32Array(vertexTotal); // per-edge, length-derived travel seconds
    this.length = new Float32Array(vertexTotal); // per-edge world length, for the wake px->t
    this.head = new Float32Array(vertexTotal); // 1 only on edges lit via travel() — enables the comet
    this.selected = new Float32Array(vertexTotal); // 1 on desktop multi-selected edges (setSelectedEdges)
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
      const halfWidth = KIND_HALF_WIDTH[edge.kind] ?? KIND_HALF_WIDTH.trunk;
      const code = KIND_CODE[edge.kind] ?? 0;

      const length = writeEdgePositions(this.positions, vertexStart, from.x, from.y, to.x, to.y, halfWidth);
      const duration = travelDuration(length);
      for (let i = 0; i <= SEGMENTS; i++) {
        const v = vertexStart + i * 2;
        const local = i / SEGMENTS;
        along[v] = local; along[v + 1] = local;
        this.active[v] = active; this.active[v + 1] = active;
        colors[v] = colorIdx; colors[v + 1] = colorIdx;
        kinds[v] = code; kinds[v + 1] = code;
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
      return { from: edge.from, to: edge.to, active, vertexStart, halfWidth, length, duration };
    });

    this.indexCount = indices.length;
    gl.bindVertexArray(this.vao);
    this.uploadStatic(this.posBuffer, this.positions);
    this.uploadStatic(this.alongBuffer, along);
    this.uploadStatic(this.colorBuffer, colors);
    this.uploadStatic(this.kindBuffer, kinds);
    this.uploadDynamic(this.activeBuffer, this.active);
    this.uploadDynamic(this.growBuffer, this.grow);
    this.uploadDynamic(this.hoverBuffer, this.hover);
    this.uploadDynamic(this.dimBuffer, this.dim);
    this.uploadDynamic(this.durationBuffer, this.duration);
    this.uploadDynamic(this.lengthBuffer, this.length);
    this.uploadDynamic(this.headBuffer, this.head);
    this.uploadDynamic(this.selectedBuffer, this.selected);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  // Re-tessellate just the edges touching a moved node and re-upload their vertex
  // ranges in place — no full rebuild, so it stays cheap under a live drag.
  moveNode(id, x, y) {
    const pos = this.nodePos.get(id);
    if (!pos) return;
    pos.x = x;
    pos.y = y;
    const indices = this.edgesByNode.get(id);
    if (!indices || indices.length === 0) return;
    const gl = this.gl;
    for (const e of indices) {
      const edge = this.edges[e];
      const from = this.nodePos.get(edge.from);
      const to = this.nodePos.get(edge.to);
      const length = writeEdgePositions(this.positions, edge.vertexStart, from.x, from.y, to.x, to.y, edge.halfWidth);
      edge.length = length;
      edge.duration = travelDuration(length); // the move changed the edge's length, so retime it
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

  // The animated wake the ceremony orchestrator drives: light one edge from atSeconds
  // and fire its comet head down the ribbon parent->child. Unlike setStates, this arms
  // the head flag so the front reads as a travelling highlight. durationMs overrides the
  // length-derived clamp when the orchestrator wants a specific beat.
  travel(from, to, atSeconds, opts = {}) {
    if (!this.active) return;
    const e = this.edgeIndex.get(`${from}→${to}`);
    if (e === undefined) return;
    const edge = this.edges[e];
    const duration = opts.durationMs != null ? opts.durationMs / 1000 : travelDuration(edge.length);
    edge.active = 1;
    edge.duration = duration;
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

  // Length-derived travel time in milliseconds, so the orchestrator can ignite the
  // child at HANDOFF (0.85) of the edge's travel.
  edgeDuration(from, to) {
    const e = this.edgeIndex.get(`${from}→${to}`);
    if (e === undefined) return 0;
    return travelDuration(this.edges[e].length) * 1000;
  }

  // The transient hover deepen: a per-vertex flag paints one edge's ribbon hot,
  // leaving the baked kind hue and the activation sweep untouched underneath.
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

  // Spotlight one node's branches: every edge not incident to it recedes (design
  // A — a hovered feed row lights its node + branches, the rest dims). Whole-
  // buffer upload, once per hover-change, so it stays off the render loop.
  setSpotlight(nodeId) {
    if (!this.dim) return;
    if (nodeId === this.spotlit) return;
    if (nodeId == null) {
      this.dim.fill(0);
    } else {
      const lit = new Set(this.edgesByNode.get(nodeId) ?? []);
      for (let e = 0; e < this.edges.length; e++) {
        const start = this.edges[e].vertexStart;
        this.dim.fill(lit.has(e) ? 0 : 1, start, start + VERTS_PER_EDGE);
      }
    }
    this.spotlit = nodeId;
    this.uploadDynamic(this.dimBuffer, this.dim);
  }

  // Highlight the desktop multi-selection: every edge whose key is in the set reads aSelected=1,
  // every other 0 — one whole-buffer sweep + upload, mirroring setSpotlight's per-vertex `dim`.
  // Called once per selection change (never per frame), so the sweep stays off the render loop.
  setSelectedEdges(keySet) {
    if (!this.selected) return;
    for (const edge of this.edges) {
      const on = keySet.has(edgeKey(edge.from, edge.to)) ? 1 : 0;
      this.selected.fill(on, edge.vertexStart, edge.vertexStart + VERTS_PER_EDGE);
    }
    this.uploadDynamic(this.selectedBuffer, this.selected);
  }

  draw(camera, timeSeconds, motion) {
    const gl = this.gl;
    if (this.indexCount === 0) return;
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
    gl.uniform3fv(this.u.uEdgeColor, this.edgeColors);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    [this.posBuffer, this.alongBuffer, this.activeBuffer, this.growBuffer, this.colorBuffer, this.hoverBuffer, this.kindBuffer, this.dimBuffer, this.durationBuffer, this.lengthBuffer, this.headBuffer, this.selectedBuffer, this.indexBuffer].forEach((b) => gl.deleteBuffer(b));
  }
}
