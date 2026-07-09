// GLSL for ConnectorLayer's single merged BufferGeometry (one ribbon mesh for
// every edge). Geometry — the bézier tessellation — is built once in setModel;
// state changes only flip aActive/aGrowStart, so activation replays here as a
// color sweep travelling from the completed prerequisite to the newly-available
// node, entirely on the GPU.

export const connectorVertexShader = /* glsl */ `
attribute float aActive;
attribute float aAlongT;
attribute float aGrowStart;

varying float vActive;
varying float vAlongT;
varying float vGrowStart;

void main() {
  vActive = aActive;
  vAlongT = aAlongT;
  vGrowStart = aGrowStart;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const connectorFragmentShader = /* glsl */ `
uniform float uTime;
uniform float uGrowDuration;
uniform float uMotion; // 1 = animate growth, 0 = prefers-reduced-motion (snap to grown)
uniform vec3 uColorInactive;
uniform vec3 uColorActive;

varying float vActive;
varying float vAlongT;
varying float vGrowStart;

void main() {
  float swept = clamp((uTime - vGrowStart) / uGrowDuration, 0.0, 1.0);
  float progress = mix(1.0, swept, uMotion);
  float revealed = 1.0 - smoothstep(progress - 0.08, progress, vAlongT);
  float lit = vActive * revealed;

  vec3 color = mix(uColorInactive, uColorActive, lit);
  float alpha = mix(0.55, 0.95, lit);
  gl_FragColor = vec4(color, alpha);
}
`;
