// One instanced draw for every fruit. A base quad drawn N times; per-instance
// attributes carry position/state/glow/icon. The fruit body is procedural (disc
// + gradient + ring), the glow pulses from uTime — no per-node JS per frame.
import { createProgram, uniformLocations } from './glcore.js';
import { FRUIT, NODE_STATES, NODE_SIZE } from '../theme.js';

const QUAD_PADDING = 1.8;
const GLOW_SPEED = (2 * Math.PI) / 2.4;

const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;
layout(location=1) in vec2 aOffset;
layout(location=2) in float aState;
layout(location=3) in float aGlowSeed;
layout(location=4) in float aSelected;
layout(location=5) in float aIconCell;
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uNodeSize;
uniform float uPadding;
out vec2 vUv;
out float vState;
out float vGlowSeed;
out float vSelected;
out float vIconCell;
void main() {
  vUv = aQuad + 0.5;
  vState = aState;
  vGlowSeed = aGlowSeed;
  vSelected = aSelected;
  vIconCell = aIconCell;
  float size = uNodeSize * (1.0 + aSelected * 0.14) * uPadding;
  vec2 world = aOffset + aQuad * size;
  vec2 screen = (world - uCamera) * uZoom;
  vec2 clip = vec2(screen.x / (uResolution.x * 0.5), -screen.y / (uResolution.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
in float vState;
in float vGlowSeed;
in float vSelected;
in float vIconCell;
uniform float uPadding;
uniform float uTime;
uniform float uGlowSpeed;
uniform float uMotion;
uniform vec4 uGlowColor[4];
uniform vec3 uFruitInner[4];
uniform vec3 uFruitOuter[4];
uniform vec3 uFruitRing[4];
uniform sampler2D uIconAtlas;
uniform float uIconCols;
uniform float uIconRows;
uniform float uIconOpacity;
uniform vec3 uIconColor[4];
out vec4 fragColor;
const float TAU = 6.28318530718;
const float EDGE = 0.84;
void main() {
  vec2 nodeUv = (vUv - 0.5) * uPadding + 0.5;
  vec2 centered = (nodeUv - 0.5) * 2.0;
  float dist = length(centered);
  int st = int(vState + 0.5);

  vec4 glow = uGlowColor[st];
  float pulse = 0.65 + 0.35 * uMotion * sin(uTime * uGlowSpeed + vGlowSeed * TAU);
  float glowFalloff = smoothstep(1.05, 0.1, dist);
  float glowAlpha = glow.a * pulse * glowFalloff * (1.0 + vSelected * 0.6);

  float bodyMask = 1.0 - smoothstep(EDGE - 0.02, EDGE + 0.015, dist);
  float grad = clamp(dist / EDGE, 0.0, 1.0);
  vec3 fruit = mix(uFruitInner[st], uFruitOuter[st], grad * grad);
  float hl = smoothstep(0.85, 0.0, length(centered - vec2(-0.3, -0.3)));
  fruit += hl * 0.10;
  float ring = smoothstep(EDGE - 0.08, EDGE - 0.03, dist) * (1.0 - smoothstep(EDGE - 0.02, EDGE + 0.005, dist));
  fruit = mix(fruit, uFruitRing[st], ring);
  vec3 body = fruit * (1.0 + vSelected * 0.25);

  float iconMask = 0.0;
  if (bodyMask > 0.01 && vIconCell >= 0.0) {
    float icol = mod(vIconCell, uIconCols);
    float irow = floor(vIconCell / uIconCols);
    vec2 iconUv = (vec2(icol, irow) + nodeUv) / vec2(uIconCols, uIconRows);
    iconMask = texture(uIconAtlas, iconUv).a;
  }
  body = mix(body, uIconColor[st], iconMask * uIconOpacity);

  vec3 color = body + glow.rgb * glowAlpha;
  float alpha = max(bodyMask, glowAlpha);
  if (alpha < 0.01) discard;
  fragColor = vec4(color, alpha);
}`;

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function glowVec(glow) {
  if (!glow) return [0, 0, 0, 0];
  const m = glow.match(/[\d.]+/g).map(Number);
  return [m[0] / 255, m[1] / 255, m[2] / 255, m[3]];
}

function flatStates(mapFn) {
  return new Float32Array(NODE_STATES.flatMap(mapFn));
}

const QUAD = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);

export class NodeBatch {
  constructor(gl) {
    this.gl = gl;
    this.count = 0;
    this.idToIndex = new Map();
    this.selectedIndex = -1;

    this.program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    this.u = uniformLocations(gl, this.program, [
      'uResolution', 'uCamera', 'uZoom', 'uNodeSize', 'uPadding', 'uTime', 'uGlowSpeed', 'uMotion',
      'uGlowColor', 'uFruitInner', 'uFruitOuter', 'uFruitRing',
      'uIconAtlas', 'uIconCols', 'uIconRows', 'uIconOpacity', 'uIconColor',
    ]);

    this.glowColors = flatStates((s) => glowVec(FRUIT[s].glow));
    this.fruitInner = flatStates((s) => hexRgb(FRUIT[s].inner));
    this.fruitOuter = flatStates((s) => hexRgb(FRUIT[s].outer));
    this.fruitRing = flatStates((s) => hexRgb(FRUIT[s].ring));
    this.iconColors = flatStates((s) => hexRgb(FRUIT[s].icon));

    this.iconTexture = null;
    this.iconCols = 1;
    this.iconRows = 1;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quadBuffer = this.attribBuffer(0, 2, QUAD, 0, gl.STATIC_DRAW);
    this.offsetBuffer = this.attribBuffer(1, 2, null, 1, gl.DYNAMIC_DRAW);
    this.stateBuffer = this.attribBuffer(2, 1, null, 1, gl.DYNAMIC_DRAW);
    this.glowSeedBuffer = this.attribBuffer(3, 1, null, 1, gl.DYNAMIC_DRAW);
    this.selectedBuffer = this.attribBuffer(4, 1, null, 1, gl.DYNAMIC_DRAW);
    this.iconCellBuffer = this.attribBuffer(5, 1, null, 1, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
  }

  attribBuffer(location, size, data, divisor, usage) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (data) gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, divisor);
    return buffer;
  }

  setIconAtlas(texture, cols, rows) {
    this.iconTexture = texture;
    this.iconCols = cols;
    this.iconRows = rows;
  }

  setInstances(renderNodes, iconAtlas) {
    const gl = this.gl;
    const count = renderNodes.length;
    this.count = count;
    this.idToIndex = new Map();
    this.selectedIndex = -1;

    const offsets = new Float32Array(count * 2);
    this.states = new Float32Array(count);
    const glowSeeds = new Float32Array(count);
    this.selected = new Float32Array(count);
    const iconCells = new Float32Array(count);

    renderNodes.forEach((node, i) => {
      this.idToIndex.set(node.id, i);
      offsets[i * 2] = node.x;
      offsets[i * 2 + 1] = node.y;
      this.states[i] = NODE_STATES.indexOf(node.state);
      glowSeeds[i] = node.glowSeed;
      iconCells[i] = iconAtlas ? iconAtlas.cellFor(node.icon) : -1;
    });

    this.upload(this.offsetBuffer, offsets);
    this.upload(this.stateBuffer, this.states);
    this.upload(this.glowSeedBuffer, glowSeeds);
    this.upload(this.selectedBuffer, this.selected);
    this.upload(this.iconCellBuffer, iconCells);
  }

  upload(buffer, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  setStates(statesMap) {
    if (!this.states) return;
    let changed = false;
    for (const [id, state] of statesMap) {
      const i = this.idToIndex.get(id);
      if (i === undefined) continue;
      const value = NODE_STATES.indexOf(state);
      if (this.states[i] === value) continue;
      this.states[i] = value;
      changed = true;
    }
    if (changed) this.upload(this.stateBuffer, this.states);
  }

  setSelected(id) {
    if (!this.selected) return;
    if (this.selectedIndex >= 0) this.selected[this.selectedIndex] = 0;
    const i = id == null ? -1 : this.idToIndex.get(id) ?? -1;
    this.selectedIndex = i;
    if (i >= 0) this.selected[i] = 1;
    this.upload(this.selectedBuffer, this.selected);
  }

  draw(camera, timeSeconds, motion, iconOpacity) {
    const gl = this.gl;
    if (this.count === 0) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(this.u.uResolution, camera.viewportWidth, camera.viewportHeight);
    gl.uniform2f(this.u.uCamera, camera.x, camera.y);
    gl.uniform1f(this.u.uZoom, camera.zoom);
    gl.uniform1f(this.u.uNodeSize, NODE_SIZE);
    gl.uniform1f(this.u.uPadding, QUAD_PADDING);
    gl.uniform1f(this.u.uTime, timeSeconds);
    gl.uniform1f(this.u.uGlowSpeed, GLOW_SPEED);
    gl.uniform1f(this.u.uMotion, motion);
    gl.uniform4fv(this.u.uGlowColor, this.glowColors);
    gl.uniform3fv(this.u.uFruitInner, this.fruitInner);
    gl.uniform3fv(this.u.uFruitOuter, this.fruitOuter);
    gl.uniform3fv(this.u.uFruitRing, this.fruitRing);
    gl.uniform3fv(this.u.uIconColor, this.iconColors);
    gl.uniform1f(this.u.uIconCols, this.iconCols);
    gl.uniform1f(this.u.uIconRows, this.iconRows);
    gl.uniform1f(this.u.uIconOpacity, this.iconTexture ? iconOpacity : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.iconTexture);
    gl.uniform1i(this.u.uIconAtlas, 0);

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    [this.quadBuffer, this.offsetBuffer, this.stateBuffer, this.glowSeedBuffer, this.selectedBuffer, this.iconCellBuffer]
      .forEach((b) => gl.deleteBuffer(b));
  }
}
