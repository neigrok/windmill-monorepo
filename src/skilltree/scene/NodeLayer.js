import * as THREE from 'three';
import { FRUIT, NODE_STATES, NODE_SIZE } from '../theme.js';
import { nodeVertexShader, nodeFragmentShader } from './shaders/nodeShader.js';

// One InstancedMesh (a unit quad) draws every fruit in a single call. Per-instance
// InstancedBufferAttributes carry everything the shader needs to place, color and
// pulse each node; setInstances/setStates/setSelected only ever touch these typed
// arrays and flip needsUpdate — geometry itself never changes after construction.
const QUAD_PADDING = 1.8; // quad is larger than the fruit so glow can bloom past the ring
const LAYER_DEPTH = 2; // world-unit z separation between DAG rank bands (see shader comment)
const GLOW_PERIOD_SECONDS = 2.4; // mirrors --duration-glow in motion.css
const GLOW_SPEED = (2 * Math.PI) / GLOW_PERIOD_SECONDS;

function unitQuadGeometry() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function glowColorForState(state) {
  const glow = FRUIT[state].glow;
  if (!glow) return new THREE.Vector4(0, 0, 0, 0);

  const [r, g, b, a] = glow
    .slice(glow.indexOf('(') + 1, glow.indexOf(')'))
    .split(',')
    .map(Number);
  const color = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  return new THREE.Vector4(color.r, color.g, color.b, a);
}

export class NodeLayer {
  constructor(atlas) {
    this.atlas = atlas;
    this.idToIndex = new Map();
    this.selectedIndex = -1;
    this.capacity = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: nodeVertexShader,
      fragmentShader: nodeFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uTime: { value: 0 },
        uMotion: { value: 1 },
        uAtlas: { value: atlas.texture },
        uAtlasCols: { value: atlas.cols },
        uAtlasRows: { value: atlas.rows },
        uNodeSize: { value: NODE_SIZE },
        uPadding: { value: QUAD_PADDING },
        uLayerDepth: { value: LAYER_DEPTH },
        uGlowSpeed: { value: GLOW_SPEED },
        uGlowColor: { value: NODE_STATES.map(glowColorForState) },
      },
    });

    // A single InstancedMesh lives for the lifetime of the layer. setInstances
    // swaps in a freshly-sized geometry (that's the one-time "rebuild", allowed
    // only from setModel); setStates/setSelected afterwards only ever mutate the
    // typed arrays already attached to it.
    this.mesh = new THREE.InstancedMesh(unitQuadGeometry(), this.material, 0);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  setInstances(renderNodes) {
    const count = renderNodes.length;
    this.capacity = count;
    this.idToIndex = new Map();
    this.selectedIndex = -1;

    const offsets = new Float32Array(count * 3);
    const states = new Float32Array(count);
    const scales = new Float32Array(count);
    const glowSeeds = new Float32Array(count);
    const selected = new Float32Array(count);

    renderNodes.forEach((node, index) => {
      this.idToIndex.set(node.id, index);
      offsets[index * 3 + 0] = node.x;
      offsets[index * 3 + 1] = node.y;
      offsets[index * 3 + 2] = node.layer;
      states[index] = NODE_STATES.indexOf(node.state);
      scales[index] = 1;
      glowSeeds[index] = node.glowSeed;
      selected[index] = 0;
    });

    const geometry = unitQuadGeometry();
    geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
    geometry.setAttribute('aState', new THREE.InstancedBufferAttribute(states, 1));
    geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    geometry.setAttribute('aGlowSeed', new THREE.InstancedBufferAttribute(glowSeeds, 1));
    geometry.setAttribute('aSelected', new THREE.InstancedBufferAttribute(selected, 1));

    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.count = count;
  }

  setStates(statesMap) {
    const attribute = this.mesh.geometry.attributes.aState;
    if (!attribute) return;

    let changed = false;
    for (const [id, state] of statesMap) {
      const index = this.idToIndex.get(id);
      if (index === undefined) continue;
      const value = NODE_STATES.indexOf(state);
      if (attribute.array[index] === value) continue;
      attribute.array[index] = value;
      changed = true;
    }

    if (changed) attribute.needsUpdate = true;
  }

  setSelected(id) {
    const attribute = this.mesh.geometry.attributes.aSelected;
    if (!attribute) return;

    if (this.selectedIndex >= 0) attribute.array[this.selectedIndex] = 0;
    const index = id === null || id === undefined ? -1 : this.idToIndex.get(id);
    this.selectedIndex = index === undefined ? -1 : index;
    if (this.selectedIndex >= 0) attribute.array[this.selectedIndex] = 1;

    attribute.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
