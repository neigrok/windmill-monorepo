// One instanced draw for every fruit. A base quad drawn N times; per-instance
// attributes carry position/color/tier/glow/icon. Color picks the kind hue; the
// tier picks the treatment, mirroring the design's dag-clean-colors states:
//   unavailable → same hue at low opacity, muted ring, no glow
//   available   → flat saturated fill + kind ring, glow on hover
//   activated   → same + an outer ring and a static halo (only the root breathes)
// The body is procedural; no per-node JS runs per frame.
import { createProgram, uniformLocations } from './glcore.js';
import { NODE_COLORS, NODE_COLOR_NAMES, nodeTier, BACKGROUND, NODE_SIZE } from '../theme.js';

const QUAD_PADDING = 1.9;
const NC = NODE_COLOR_NAMES.length;
const BLOOM_NONE = -1000; // sentinel: this node is not blooming

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
layout(location=8) in float aFaded;
layout(location=9) in float aEmphasis;
layout(location=10) in float aPulseStart;
layout(location=11) in vec4 aBloom;   // (start, fromTier, durSec, blossom)
uniform vec2 uResolution;
uniform vec2 uCamera;
uniform float uZoom;
uniform float uNodeSize;
uniform float uPadding;
uniform float uTime;
uniform float uMotion;
out vec2 vUv;
out float vColor;
out float vTier;
out float vGlowSeed;
out float vSelected;
out float vIconCell;
out float vForm;
out float vFaded;
out float vEmphasis;
out float vPulseStart;
out vec4 vBloom;
const float PI = 3.14159265;
const float BLOSSOM = 0.62;   // scale-settle window (s)
void main() {
  vUv = aQuad + 0.5;
  vColor = aColor;
  vTier = aTier;
  vGlowSeed = aGlowSeed;
  vSelected = aSelected;
  vIconCell = aIconCell;
  vForm = aForm;
  vFaded = aFaded;
  vEmphasis = aEmphasis;
  vPulseStart = aPulseStart;
  vBloom = aBloom;
  // scale settle: a finite 1->peak->1 bump while a node blooms (motion only)
  float settle = 1.0;
  if (uMotion > 0.5 && aBloom.x > -900.0) {
    float st = (uTime - aBloom.x) / BLOSSOM;
    if (st >= 0.0 && st < 1.0) {
      float peak = int(aTier + 0.5) == 2 ? 1.10 : 1.05; // full vs wake (boosted for legibility)
      settle = 1.0 + (peak - 1.0) * sin(st * PI);
    }
  }
  float size = uNodeSize * (1.0 + aSelected * 0.14 + aEmphasis * 0.55) * settle * uPadding;
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
in float vFaded;
in float vEmphasis;
in float vPulseStart;
in vec4 vBloom;
uniform float uPadding;
uniform float uTime;
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
const float OUTER_R = 1.16;      // outer-ring radius (activated), in centered space
const float OUTER_W = 0.07;
const float BLOSSOM = 0.62;      // halo-overshoot window (s)
const float HALO_STEADY = 0.6;   // static activated halo ~= a .28 (the old mid-breath)
const float HALO_OVERSHOOT = 1.2; // blossom halo peak (boosted for legibility)
const float CROWN_PERIOD = 2.4;  // crown breath period (s) -- the only infinite loop
const float PULSE_DUR = 2.8;     // arrival-pulse window (s)
const float PULSE_CYCLE = 1.4;   // one crest per cycle -> two crests, slightly slower
const float PULSE_CREST1 = 1.5;  // first crest (boosted for legibility)
const float PULSE_CREST2 = 1.15; // second crest (decaying)
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

  // ---- fill / ring / glyph: a litness lerp, cross-faded fromTier->toTier on bloom ----
  // Litness 0 = muted (unavailable), 1 = full (available/activated share a palette).
  // A bloom eases litness from the tier the node left to the tier it woke into.
  float toLit = tier == 0 ? 0.0 : 1.0;
  float lit = toLit;
  if (vBloom.x > -900.0) {
    float dur = uMotion > 0.5 ? vBloom.z : 0.15; // reduced motion: 150ms fade only
    float t = clamp((uTime - vBloom.x) / max(dur, 0.001), 0.0, 1.0);
    float p = t * t * (3.0 - 2.0 * t); // ease-standard ~= cubic-bezier(0.4,0,0.2,1)
    float fromLit = int(vBloom.y + 0.5) == 0 ? 0.0 : 1.0;
    lit = mix(fromLit, toLit, p);
  }
  vec3 fill = mix(mix(uCanvas, base, 0.22), base, lit);
  vec3 ringColor = mix(mix(uCanvas, base, 0.42), ring, lit);
  vec3 glyphColor = mix(mix(uCanvas, base, 0.55), soft, lit);

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

  // ---- glow: the root crown breathes; every other activated node wears a STATIC halo ----
  float crownWave = uMotion > 0.5 ? 0.5 + 0.5 * sin(uTime * (TAU / CROWN_PERIOD)) : 0.5;
  float haloRadiusMul = 1.0;
  float strength = 0.0;
  if (tier == 2) {
    strength = HALO_STEADY; // no oscillation -- a still a .28 halo
    // blossom overshoot: a finite lift 0->overshoot->steady, starting +80ms after ignite
    if (vBloom.w > 0.5 && vBloom.x > -900.0 && uMotion > 0.5) {
      float bt = (uTime - vBloom.x - 0.08) / BLOSSOM;
      if (bt < 0.0) strength = 0.0;
      else if (bt < 1.0) {
        float up = smoothstep(0.0, 0.55, bt);   // rise to overshoot at 55%
        float down = smoothstep(0.55, 1.0, bt); // settle overshoot->steady
        strength = HALO_OVERSHOOT * up - (HALO_OVERSHOOT - HALO_STEADY) * down;
        haloRadiusMul = 1.0 + 0.45 * (up - down); // radius swell at the peak (boosted)
      }
    }
  }
  if (vEmphasis > 0.5) strength = mix(0.471, 0.729, crownWave); // crown halo a .22<->.34
  if (tier >= 1) strength = max(strength, vSelected);
  // arrival pulse: a finite double-bump when an event lands (any tier), 2400ms with two
  // decaying crests (a .42->.34) -- felt on the graph first (design F). Gated by motion.
  float pt = uTime - vPulseStart;
  if (vPulseStart > -900.0 && pt >= 0.0 && pt < PULSE_DUR) {
    float amp = mix(PULSE_CREST1, PULSE_CREST2, (pt - PULSE_CYCLE * 0.5) / PULSE_CYCLE);
    float bump = 0.5 - 0.5 * cos(pt * (TAU / PULSE_CYCLE)); // two crests over 2400ms
    strength = max(strength, bump * amp * uMotion);
  }
  float glowFalloff = smoothstep(1.6 * haloRadiusMul, 0.1, dist);
  float glowAmt = glow.a * strength * glowFalloff * 1.7;
  if (vFaded > 0.5) glowAmt = 0.0; // a faded ghost carries no halo

  // ---- outer ring (activated only) ----
  float outerBand = 1.0 - smoothstep(0.0, OUTER_W, abs(dist - OUTER_R));
  float outerA = (tier == 2 ? 1.0 : 0.0) * outerBand * 0.6;

  vec3 color = body * bodyMask + glow.rgb * glowAmt;
  color = color * (1.0 - outerA) + base * outerA;
  float alpha = max(max(bodyMask, glowAmt), outerA);

  // ---- root crown: a bright ring plus a satellite ring, breathing in sync with the halo ----
  float crownR = 1.32 + (crownWave - 0.5) * 0.06; // radius +/-2px equiv
  float crownBand = 1.0 - smoothstep(0.0, 0.05, abs(dist - crownR));
  float crownA = crownBand * vEmphasis * mix(0.78, 0.92, crownWave);
  color = color * (1.0 - crownA) + mix(ring, vec3(1.0), 0.25) * crownA;
  alpha = max(alpha, crownA);
  float satR = 1.45 + (crownWave - 0.5) * 0.06; // ~8px beyond the crown, +/-2px
  float satBand = 1.0 - smoothstep(0.0, 0.035, abs(dist - satR));
  float satA = satBand * vEmphasis * mix(0.5, 0.85, crownWave);
  color = color * (1.0 - satA) + mix(ring, vec3(1.0), 0.4) * satA;
  alpha = max(alpha, satA);

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

  // ---- cycle dim: nodes a connect-drag can't target read as faint ghosts ----
  if (vFaded > 0.5) alpha *= 0.3;

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
      'uResolution', 'uCamera', 'uZoom', 'uNodeSize', 'uPadding', 'uTime', 'uMotion',
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
    this.fadedBuffer = this.attribBuffer(8, 1, null, 1, gl.DYNAMIC_DRAW);
    this.emphasisBuffer = this.attribBuffer(9, 1, null, 1, gl.DYNAMIC_DRAW);
    this.pulseBuffer = this.attribBuffer(10, 1, null, 1, gl.DYNAMIC_DRAW);
    this.bloomBuffer = this.attribBuffer(11, 4, null, 1, gl.DYNAMIC_DRAW);

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
    this.colors = new Float32Array(count);
    const colors = this.colors;
    const glowSeeds = new Float32Array(count);
    this.selected = new Float32Array(count);
    const iconCells = new Float32Array(count);
    this.tiers = new Float32Array(count);
    const forms = new Float32Array(count);
    this.faded = new Float32Array(count);
    const emphasis = new Float32Array(count);
    this.pulseStarts = new Float32Array(count).fill(-1000); // sentinel: no pulse
    this.bloom = new Float32Array(count * 4); // (start, fromTier, durSec, blossom) per node
    for (let i = 0; i < count; i++) this.bloom[i * 4] = BLOOM_NONE;

    renderNodes.forEach((node, i) => {
      this.idToIndex.set(node.id, i);
      this.offsets[i * 2] = node.x;
      this.offsets[i * 2 + 1] = node.y;
      colors[i] = colorIndex(node.color);
      glowSeeds[i] = node.glowSeed;
      iconCells[i] = iconAtlas ? iconAtlas.cellFor(node.icon) : -1;
      this.tiers[i] = nodeTier(node.state);
      forms[i] = node.form ?? 0;
      emphasis[i] = node.emphasis ?? 0;
    });

    this.upload(this.offsetBuffer, this.offsets);
    this.upload(this.colorBuffer, colors);
    this.upload(this.glowSeedBuffer, glowSeeds);
    this.upload(this.selectedBuffer, this.selected);
    this.upload(this.iconCellBuffer, iconCells);
    this.upload(this.tierBuffer, this.tiers);
    this.upload(this.formBuffer, forms);
    this.upload(this.fadedBuffer, this.faded);
    this.upload(this.emphasisBuffer, emphasis);
    this.upload(this.pulseBuffer, this.pulseStarts);
    this.upload(this.bloomBuffer, this.bloom);
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

  // Recolour one node in place — the live kind preview while a swatch is hovered.
  // No history; the model rebuild on commit (or restore on leave) supersedes it.
  setColor(id, name) {
    if (!this.colors) return;
    const i = this.idToIndex.get(id);
    if (i === undefined) return;
    this.colors[i] = colorIndex(name);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 4, this.colors, i, 1);
  }

  // Fire a one-shot arrival pulse on one node — stamps the current time into its
  // aPulseStart; the shader draws the decaying double-bump for the next 2400ms.
  pulse(id, atSeconds) {
    if (!this.pulseStarts) return;
    const i = this.idToIndex.get(id);
    if (i === undefined) return;
    this.pulseStarts[i] = atSeconds;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pulseBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 4, this.pulseStarts, i, 1);
  }

  // Ignite one node: the animated state-rise. Records the tier it's leaving, snaps
  // the resting tier to toTier, and stamps a bloom the shaders read for the next
  // ~500ms — a color cross-fade, a scale settle, and (on a full node) a halo bloom.
  igniteNode(id, atSeconds, toTier, opts = {}) {
    if (!this.bloom) return;
    const i = this.idToIndex.get(id);
    if (i === undefined) return;
    const durationMs = opts.durationMs ?? 280;
    const blossom = opts.blossom ?? (toTier === 2);
    const fromTier = this.tiers[i];
    this.tiers[i] = toTier;
    this.bloom[i * 4] = atSeconds;
    this.bloom[i * 4 + 1] = fromTier;
    this.bloom[i * 4 + 2] = durationMs / 1000;
    this.bloom[i * 4 + 3] = blossom ? 1 : 0;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tierBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 4, this.tiers, i, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bloomBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, i * 16, this.bloom, i * 4, 4);
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

  // Dim the nodes a connect-drag can't target (they'd create a cycle). A whole-
  // buffer upload, but it runs once per gesture — not per frame.
  setFaded(idSet) {
    if (!this.faded) return;
    for (const [id, i] of this.idToIndex) this.faded[i] = idSet.has(id) ? 1 : 0;
    this.upload(this.fadedBuffer, this.faded);
  }

  clearFaded() {
    if (!this.faded) return;
    this.faded.fill(0);
    this.upload(this.fadedBuffer, this.faded);
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
    [this.quadBuffer, this.offsetBuffer, this.colorBuffer, this.glowSeedBuffer, this.selectedBuffer, this.iconCellBuffer, this.tierBuffer, this.formBuffer, this.fadedBuffer, this.emphasisBuffer, this.pulseBuffer, this.bloomBuffer]
      .forEach((b) => gl.deleteBuffer(b));
  }
}
