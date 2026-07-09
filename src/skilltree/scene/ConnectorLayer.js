import * as THREE from 'three';
import { CONNECTOR } from '../theme.js';
import { connectorVertexShader, connectorFragmentShader } from './shaders/connectorShader.js';

// Every edge is tessellated once into a quadratic-bézier ribbon and merged into
// a single BufferGeometry — one mesh, one draw call for the whole board. setModel
// is the only place geometry is (re)built; setStates only rewrites the aActive /
// aGrowStart floats already sitting in the buffers, replaying activation as a
// GPU color sweep instead of touching a single vertex position.
const SEGMENTS = 14;
const WIDTH = 4;
const BEND_FACTOR = 0.18; // same gentle perpendicular bend as DOM SkillConnector
const CONNECTOR_Z = -4; // behind every node layer band (see NodeLayer's uLayerDepth)
const GROW_DURATION = 0.5; // seconds; echoes --duration-slow in motion.css
const ALREADY_GROWN = -1000; // sentinel growStart so initial edges render fully revealed

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

function bezierControlPoint(fx, fy, tx, ty) {
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const seed = hashStr(`${fx},${fy}-${tx},${ty}`);
  const bend = ((seed % 100) / 100 - 0.5) * len * BEND_FACTOR;
  return { cx: (fx + tx) / 2 + nx * bend, cy: (fy + ty) / 2 + ny * bend };
}

function ribbonVertexCount() {
  return (SEGMENTS + 1) * 2;
}

function writeRibbon(edge, from, to, buffers, vertexStart) {
  const { cx, cy } = bezierControlPoint(from.x, from.y, to.x, to.y);
  const halfWidth = WIDTH / 2;
  const active = edge.active ? 1 : 0;

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

    const vertex = vertexStart + i * 2;
    buffers.position.set([px + nx * halfWidth, py + ny * halfWidth, CONNECTOR_Z], vertex * 3);
    buffers.position.set([px - nx * halfWidth, py - ny * halfWidth, CONNECTOR_Z], (vertex + 1) * 3);
    buffers.aAlongT[vertex] = t;
    buffers.aAlongT[vertex + 1] = t;
    buffers.aActive[vertex] = active;
    buffers.aActive[vertex + 1] = active;
    buffers.aGrowStart[vertex] = ALREADY_GROWN;
    buffers.aGrowStart[vertex + 1] = ALREADY_GROWN;
  }

  for (let i = 0; i < SEGMENTS; i++) {
    const a = vertexStart + i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    buffers.indices.push(a, b, c, b, d, c);
  }
}

export class ConnectorLayer {
  constructor() {
    this.edges = [];

    this.material = new THREE.ShaderMaterial({
      vertexShader: connectorVertexShader,
      fragmentShader: connectorFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uGrowDuration: { value: GROW_DURATION },
        uColorInactive: { value: new THREE.Color(CONNECTOR.inactive) },
        uColorActive: { value: new THREE.Color(CONNECTOR.active) },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  setModel(renderModel) {
    const nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    const perVertex = ribbonVertexCount();
    const vertexTotal = renderModel.edges.length * perVertex;

    const buffers = {
      position: new Float32Array(vertexTotal * 3),
      aAlongT: new Float32Array(vertexTotal),
      aActive: new Float32Array(vertexTotal),
      aGrowStart: new Float32Array(vertexTotal),
      indices: [],
    };

    this.edges = renderModel.edges.map((edge, index) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      const vertexStart = index * perVertex;
      writeRibbon(edge, from, to, buffers, vertexStart);
      return { from: edge.from, to: edge.to, active: edge.active, vertexStart, vertexCount: perVertex };
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.position, 3));
    geometry.setAttribute('aAlongT', new THREE.BufferAttribute(buffers.aAlongT, 1));
    geometry.setAttribute('aActive', new THREE.BufferAttribute(buffers.aActive, 1));
    geometry.setAttribute('aGrowStart', new THREE.BufferAttribute(buffers.aGrowStart, 1));
    geometry.setIndex(buffers.indices);

    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  setStates(statesMap, elapsedSeconds) {
    const geometry = this.mesh.geometry;
    const aActive = geometry.attributes.aActive;
    const aGrowStart = geometry.attributes.aGrowStart;
    if (!aActive || !aGrowStart) return;

    let changed = false;
    for (const edge of this.edges) {
      const nextActive = statesMap.get(edge.from) === 'complete' ? 1 : 0;
      if (nextActive === edge.active) continue;

      edge.active = nextActive;
      changed = true;
      for (let vertex = edge.vertexStart; vertex < edge.vertexStart + edge.vertexCount; vertex++) {
        aActive.array[vertex] = nextActive;
        if (nextActive === 1) aGrowStart.array[vertex] = elapsedSeconds;
      }
    }

    if (changed) {
      aActive.needsUpdate = true;
      aGrowStart.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
