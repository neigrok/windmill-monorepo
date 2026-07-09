// Every edge tessellated once into a bézier ribbon, merged into one buffer and
// drawn in a single call. Activation replays as a GPU color sweep from the
// completed prerequisite to the newly-available node; setStates only rewrites
// the aActive / aGrowStart floats, never vertex positions.
import { createProgram, uniformLocations } from './glcore.js';
import { CONNECTOR } from '../theme.js';

const SEGMENTS = 14;
const WIDTH = 4;
const BEND_FACTOR = 0.18;
const GROW_DURATION = 0.5;
const ALREADY_GROWN = -1000;
const VERTS_PER_EDGE = (SEGMENTS + 1) * 2;

const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in float aAlongT;
layout(location=2) in float aActive;
layout(location=3) in float aGrowStart;
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
out float vActive;
out float vAlongT;
out float vGrowStart;
void main() {
  vActive = aActive;
  vAlongT = aAlongT;
  vGrowStart = aGrowStart;
  vec2 screen = (aPos - uCamera) * uZoom;
  vec2 clip = vec2(screen.x / (uResolution.x * 0.5), -screen.y / (uResolution.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in float vActive;
in float vAlongT;
in float vGrowStart;
uniform float uTime;
uniform float uGrowDuration;
uniform float uMotion;
uniform vec3 uColorInactive;
uniform vec3 uColorActive;
out vec4 fragColor;
void main() {
  float swept = clamp((uTime - vGrowStart) / uGrowDuration, 0.0, 1.0);
  float progress = mix(1.0, swept, uMotion);
  float revealed = 1.0 - smoothstep(progress - 0.08, progress, vAlongT);
  float lit = vActive * revealed;
  vec3 color = mix(uColorInactive, uColorActive, lit);
  float alpha = mix(0.55, 0.95, lit);
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

export class ConnectorBatch {
  constructor(gl) {
    this.gl = gl;
    this.indexCount = 0;
    this.edges = [];

    this.program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    this.u = uniformLocations(gl, this.program, ['uResolution', 'uCamera', 'uZoom', 'uTime', 'uGrowDuration', 'uMotion', 'uColorInactive', 'uColorActive']);
    this.colorInactive = hexRgb(CONNECTOR.inactive);
    this.colorActive = hexRgb(CONNECTOR.active);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.posBuffer = this.attrib(0, 2, gl.STATIC_DRAW);
    this.alongBuffer = this.attrib(1, 1, gl.STATIC_DRAW);
    this.activeBuffer = this.attrib(2, 1, gl.DYNAMIC_DRAW);
    this.growBuffer = this.attrib(3, 1, gl.DYNAMIC_DRAW);
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

    const positions = new Float32Array(vertexTotal * 2);
    const along = new Float32Array(vertexTotal);
    this.active = new Float32Array(vertexTotal);
    this.grow = new Float32Array(vertexTotal).fill(ALREADY_GROWN);
    const indices = new Uint32Array(edgeCount * SEGMENTS * 6);

    this.edges = renderModel.edges.map((edge, e) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const vertexStart = e * VERTS_PER_EDGE;
      const { cx, cy } = controlPoint(from.x, from.y, to.x, to.y);
      const halfWidth = WIDTH / 2;
      const isActive = edge.active ? 1 : 0;

      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        const omt = 1 - t;
        const px = omt * omt * from.x + 2 * omt * t * cx + t * t * to.x;
        const py = omt * omt * from.y + 2 * omt * t * cy + t * t * to.y;
        const dx = 2 * omt * (cx - from.x) + 2 * t * (to.x - cx);
        const dy = 2 * omt * (cy - from.y) + 2 * t * (to.y - cy);
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const v = vertexStart + i * 2;
        positions[v * 2] = px + nx * halfWidth;
        positions[v * 2 + 1] = py + ny * halfWidth;
        positions[(v + 1) * 2] = px - nx * halfWidth;
        positions[(v + 1) * 2 + 1] = py - ny * halfWidth;
        along[v] = t;
        along[v + 1] = t;
        this.active[v] = isActive;
        this.active[v + 1] = isActive;
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const a = vertexStart + i * 2;
        const o = (e * SEGMENTS + i) * 6;
        indices[o] = a; indices[o + 1] = a + 1; indices[o + 2] = a + 2;
        indices[o + 3] = a + 1; indices[o + 4] = a + 3; indices[o + 5] = a + 2;
      }
      return { from: edge.from, active: isActive, vertexStart };
    });

    this.indexCount = indices.length;
    gl.bindVertexArray(this.vao);
    this.uploadStatic(this.posBuffer, positions);
    this.uploadStatic(this.alongBuffer, along);
    this.uploadDynamic(this.activeBuffer, this.active);
    this.uploadDynamic(this.growBuffer, this.grow);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  uploadStatic(buffer, data) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); }
  uploadDynamic(buffer, data) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW); }

  setStates(statesMap, elapsedSeconds) {
    if (!this.active) return;
    let changed = false;
    for (const edge of this.edges) {
      const next = statesMap.get(edge.from) === 'complete' ? 1 : 0;
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
    gl.uniform3fv(this.u.uColorActive, this.colorActive);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    [this.posBuffer, this.alongBuffer, this.activeBuffer, this.growBuffer, this.indexBuffer].forEach((b) => gl.deleteBuffer(b));
  }
}
