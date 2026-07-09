// GLSL for NodeLayer's single InstancedMesh. Every fruit — body, ring and the
// pulsing glow — is drawn here from per-instance attributes plus uTime; there is
// no per-node JS in the animation loop. World space is Y-down (screen convention,
// matching the layout data), so both shaders and CameraController agree on it.

export const nodeVertexShader = /* glsl */ `
attribute vec3 aOffset;   // x, y, layer (0 = back)
attribute float aState;   // NODE_STATES index, 0..3
attribute float aScale;
attribute float aGlowSeed;
attribute float aSelected;

uniform float uNodeSize;
uniform float uPadding;   // quad is larger than the fruit so the glow has room to bloom
uniform float uLayerDepth;

varying vec2 vUv;
varying float vState;
varying float vGlowSeed;
varying float vSelected;

void main() {
  vUv = uv;
  vState = aState;
  vGlowSeed = aGlowSeed;
  vSelected = aSelected;

  float highlight = 1.0 + aSelected * 0.14;
  float size = uNodeSize * aScale * highlight * uPadding;

  // Instances are placed by hand (aOffset), not by instanceMatrix: this mesh only
  // ever needs translation + uniform scale, so a full 4x4 per instance is wasted
  // bandwidth. aOffset.z separates DAG ranks slightly so same-cell overlaps at
  // different layers still depth-sort correctly within this one draw call.
  vec3 worldPosition = vec3(aOffset.xy + position.xy * size, aOffset.z * uLayerDepth);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPosition, 1.0);
}
`;

export const nodeFragmentShader = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uAtlasCols;
uniform float uAtlasRows;
uniform float uPadding;
uniform float uTime;
uniform float uGlowSpeed;
uniform vec4 uGlowColor[4]; // rgb + intensity, indexed by NODE_STATES

varying vec2 vUv;
varying float vState;
varying float vGlowSeed;
varying float vSelected;

const float TAU = 6.28318530718;

void main() {
  // Undo the quad padding to find where we are relative to the actual fruit
  // (0..1 inside the body, outside that range we're only ever painting glow).
  vec2 nodeUv = (vUv - 0.5) * uPadding + 0.5;
  vec2 centered = (nodeUv - 0.5) * 2.0;
  float dist = length(centered);

  int stateIndex = int(vState + 0.5);
  vec4 glow = uGlowColor[stateIndex];
  float pulse = 0.65 + 0.35 * sin(uTime * uGlowSpeed + vGlowSeed * TAU);
  float glowFalloff = smoothstep(1.05, 0.1, dist);
  float glowAlpha = glow.a * pulse * glowFalloff * (1.0 + vSelected * 0.6);

  vec4 atlas = vec4(0.0);
  bool insideBody = nodeUv.x >= 0.0 && nodeUv.x <= 1.0 && nodeUv.y >= 0.0 && nodeUv.y <= 1.0;
  if (insideBody) {
    float col = mod(vState, uAtlasCols);
    float row = floor(vState / uAtlasCols);
    vec2 cellUv = (vec2(col, row) + nodeUv) / vec2(uAtlasCols, uAtlasRows);
    atlas = texture2D(uAtlas, cellUv);
  }

  vec3 body = atlas.rgb * (1.0 + vSelected * 0.25);
  vec3 color = body + glow.rgb * glowAlpha;
  float alpha = max(atlas.a, glowAlpha);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(color, alpha);
}
`;
