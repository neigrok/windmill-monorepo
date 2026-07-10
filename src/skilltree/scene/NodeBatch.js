// One instanced draw for every fruit. A base quad drawn N times; per-instance
// attributes carry position/color/tier/glow/icon. Color picks the kind hue; the
// tier picks the treatment, mirroring the design's dag-clean-colors states:
//   unavailable → same hue at low opacity, muted ring, no glow
//   available   → flat saturated fill + kind ring, glow on hover
//   activated   → same + an outer ring and a breathing glow halo
// The body is procedural; no per-node JS runs per frame.
import { createProgram, uniformLocations } from './glcore.js';
import { NODE_COLORS, NODE_COLOR_NAMES, nodeTier, BACKGROUND, NODE_SIZE } from '../theme.js';

const QUAD_PADDING = 1.9;
const GLOW_SPEED = (2 * Math.PI) / 2.6;
const NC = NODE_COLOR_NAMES.length;

const VERTEX_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aQuad;
layout(location=1) in vec2 aOffset;
layout(location=2) in float aColor;
layout(location=3) in float aGlowSeed;
layout(location=4) in float aSelected;
layout(location=5) in float aIconCell;
layout(location=6) in float aTier;
layout(location=7) in float aForm;
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uNodeSize;
uniform float uPadding;
out vec2 vUv;
out float vColor;
out float vTier;
out float vGlowSeed;
out float vSelected;
out float vIconCell;
out float vForm;
void main() {
  vUv = aQuad + 0.5;
  vColor = aColor;
  vTier = aTier;
  vGlowSeed = aGlowSeed;
  vSelected = aSelected;
  vIconCell = aIconCell;
  vForm = aForm;
  float size = uNodeSize * (1.0 + aSelected * 0.14) * uPadding;
  vec2 world = aOffset + aQuad * size;
  vec2 screen = (world - uCamera) * uZoom;
  vec2 clip = vec2(screen.x / (uResolution.x * 0.5), -screen.y / (uResolution.y * 0.5));
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
in float vColor;
in float vTier;
in float vGlowSeed;
in float vSelected;
in float vIconCell;
in float vForm;
uniform float uPadding;
uniform float uTime;
uniform float uGlowSpeed;
uniform float uMotion;
uniform vec4 uGlow[${NC}];
uniform vec3 uBase[${NC}];
uniform vec3 uRing[${NC}];
uniform vec3 uSoft[${NC}];
uniform vec3 uCanvas;
uniform sampler2D uIconAtlas;
uniform float uIconCols;
uniform float uIconRows;
uniform float uIconOpacity;
out vec4 fragColor;
const float TAU = 6.28318530718;
const float EDGE = 0.84;
const float OUTER_R = 1.16;   // outer-ring radius (activated), in centered space
const float OUTER_W = 0.07;
void main() {
  vec2 nodeUv = (vUv - 0.5) * uPadding + 0.5;
  vec2 centered = (nodeUv - 0.5) * 2.0;
  float dist = length(centered);
  int ci = int(vColor + 0.5);
  int tier = int(vTier + 0.5); // 0 unavailable, 1 available, 2 activated

  vec3 base = uBase[ci];
  vec3 ring = uRing[ci];
  vec3 soft = uSoft[ci];
  vec4 glow = uGlow[ci];

  float bodyMask = 1.0 - smoothstep(EDGE - 0.02, EDGE + 0.015, dist);
  float ringBand = smoothstep(EDGE - 0.12, EDGE - 0.05, dist) * (1.0 - smoothstep(EDGE - 0.02, EDGE + 0.005, dist));

  // ---- fill / ring / glyph per tier ----
  vec3 fill, ringColor, glyphColor;
  if (tier == 0) {
    fill = mix(uCanvas, base, 0.22);
    ringColor = mix(uCanvas, base, 0.42);
    glyphColor = mix(uCanvas, base, 0.55);
  } else {
    fill = base;
    ringColor = ring;
    glyphColor = soft;
  }

  float iconMask = 0.0;
  if (bodyMask > 0.01 && vIconCell >= 0.0) {
    float icol = mod(vIconCell, uIconCols);
    float irow = floor(vIconCell / uIconCols);
    vec2 iconUv = (vec2(icol, irow) + nodeUv) / vec2(uIconCols, uIconRows);
    iconMask = texture(uIconAtlas, iconUv).a;
  }

  vec3 body = mix(fill, ringColor, ringBand);
  body = mix(body, glyphColor, iconMask * uIconOpacity);
  body *= (1.0 + vSelected * 0.20);

  // ---- glow: activated breathes; available lights on hover; unavailable never ----
  float pulse = 0.6 + 0.4 * uMotion * sin(uTime * uGlowSpeed + vGlowSeed * TAU);
  float strength = 0.0;
  if (tier == 2) strength = pulse;
  if (tier >= 1) strength = max(strength, vSelected);
  float glowFalloff = smoothstep(1.6, 0.1, dist);
  float glowAmt = glow.a * strength * glowFalloff * 1.7;

  // ---- outer ring (activated only) ----
  float outerBand = 1.0 - smoothstep(0.0, OUTER_W, abs(dist - OUTER_R));
  float outerA = (tier == 2 ? 1.0 : 0.0) * outerBand * 0.6;

  vec3 color = body * bodyMask + glow.rgb * glowAmt;
  color = color * (1.0 - outerA) + base * outerA;
  float alpha = max(max(bodyMask, glowAmt), outerA);

  // ---- structural form: a dashed ring on buds (nascent) and unlinked strays ----
  int form = int(vForm + 0.5); // 0 linked, 1 bud, 2 unlinked
  if (form >= 1) {
    float ang = atan(centered.y, centered.x);
    float dashOn = step(fract((ang / TAU) * 14.0), 0.55);
    float ringBand = 1.0 - smoothstep(0.05, 0.085, abs(dist - 0.99));
    vec3 dashColor = form == 2 ? mix(uCanvas, ring, 0.5) : ring;
    float dashA = ringBand * dashOn * 0.85;
    if (form == 2) color = mix(uCanvas, color, 0.9); // detached reads a touch lighter
    color = color * (1.0 - dashA) + dashColor * dashA;
    alpha = max(alpha, dashA);
  }

  if (alpha < 0.01) discard;
  fragColor = vec4(color, alpha);
}`;

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function glowVec(glow) {
  const m = glow.match(/[\d.]+/g).map(Number);
  return [m[0] / 255, m[1] / 255, m[2] / 255, m[3]];
}

function colorFlat(mapFn) {
  return new Float32Array(NODE_COLOR_NAMES.flatMap(mapFn));
}

function colorIndex(name) {
  const i = NODE_COLOR_NAMES.indexOf(name);
  return i < 0 ? 0 : i;
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
      'uGlow', 'uBase', 'uRing', 'uSoft', 'uCanvas',
      'uIconAtlas', 'uIconCols', 'uIconRows', 'uIconOpacity',
    ]);

    this.glowColors = colorFlat((c) => glowVec(NODE_COLORS[c].glow));
    this.baseColors = colorFlat((c) => hexRgb(NODE_COLORS[c].base));
    this.ringColors = colorFlat((c) => hexRgb(NODE_COLORS[c].ring));
    this.softColors = colorFlat((c) => hexRgb(NODE_COLORS[c].soft));
    this.canvas = hexRgb(BACKGROUND.canvas);

    this.iconTexture = null;
    this.iconCols = 1;
    this.iconRows = 1;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.quadBuffer = this.attribBuffer(0, 2, QUAD, 0, gl.STATIC_DRAW);
    this.offsetBuffer = this.attribBuffer(1, 2, null, 1, gl.DYNAMIC_DRAW);
    this.colorBuffer = this.attribBuffer(2, 1, null, 1, gl.DYNAMIC_DRAW);
    this.glowSeedBuffer = this.attribBuffer(3, 1, null, 1, gl.DYNAMIC_DRAW);
    this.selectedBuffer = this.attribBuffer(4, 1, null, 1, gl.DYNAMIC_DRAW);
    this.iconCellBuffer = this.attribBuffer(5, 1, null, 1, gl.DYNAMIC_DRAW);
    this.tierBuffer = this.attribBuffer(6, 1, null, 1, gl.DYNAMIC_DRAW);
    this.formBuffer = this.attribBuffer(7, 1, null, 1, gl.DYNAMIC_DRAW);

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
    const count = renderNodes.length;
    this.count = count;
    this.idToIndex = new Map();
    this.selectedIndex = -1;

    this.offsets = new Float32Array(count * 2);
    const colors = new Float32Array(count);
    const glowSeeds = new Float32Array(count);
    this.selected = new Float32Array(count);
    const iconCells = new Float32Array(count);
    this.tiers = new Float32Array(count);
    const forms = new Float32Array(count);

    renderNodes.forEach((node, i) => {
      this.idToIndex.set(node.id, i);
      this.offsets[i * 2] = node.x;
      this.offsets[i * 2 + 1] = node.y;
      colors[i] = colorIndex(node.color);
      glowSeeds[i] = node.glowSeed;
      iconCells[i] = iconAtlas ? iconAtlas.cellFor(node.icon) : -1;
      this.tiers[i] = nodeTier(node.state);
      forms[i] = node.form ?? 0;
    });

    this.upload(this.offsetBuffer, this.offsets);
    this.upload(this.colorBuffer, colors);
    this.upload(this.glowSeedBuffer, glowSeeds);
    this.upload(this.selectedBuffer, this.selected);
    this.upload(this.iconCellBuffer, iconCells);
    this.upload(this.tierBuffer, this.tiers);
    this.upload(this.formBuffer, forms);
  }

  upload(buffer, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  moveInstance(id, x, y) {
    if (!this.offsets) return;
    const i = this.idToIndex.get(id);
    if (i === undefined) return;
    this.offsets[i * 2] = x;
    this.offsets[i * 2 + 1] = y;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 2 * 4, this.offsets, i * 2, 2);
  }

  setStates(statesMap) {
    if (!this.tiers) return;
    let changed = false;
    for (const [id, state] of statesMap) {
      const i = this.idToIndex.get(id);
      if (i === undefined) continue;
      const value = nodeTier(state);
      if (this.tiers[i] === value) continue;
      this.tiers[i] = value;
      changed = true;
    }
    if (changed) this.upload(this.tierBuffer, this.tiers);
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
    gl.uniform4fv(this.u.uGlow, this.glowColors);
    gl.uniform3fv(this.u.uBase, this.baseColors);
    gl.uniform3fv(this.u.uRing, this.ringColors);
    gl.uniform3fv(this.u.uSoft, this.softColors);
    gl.uniform3fv(this.u.uCanvas, this.canvas);
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
    [this.quadBuffer, this.offsetBuffer, this.colorBuffer, this.glowSeedBuffer, this.selectedBuffer, this.iconCellBuffer, this.tierBuffer, this.formBuffer]
      .forEach((b) => gl.deleteBuffer(b));
  }
}
