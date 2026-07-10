// Calm edit affordances: bark-and-cream chrome that fades in on the hovered node
// and vanishes on leave (design editing-spec §00–§03). A plus chip sits on the
// node's outward rim — opposite its parents, where a child would grow — and a
// couple of ports dot the free rim, at the widest gaps between existing branches.
// Tools are neutral, data is coloured: this chrome never takes a kind hue.
//
// A scene overlay (not React): the hovered node's screen position changes every
// frame the camera moves, so it's repositioned from the render loop. Purely visual
// for now — the create/connect gestures wire into these in their own slices.
import { NODE_SIZE } from '../theme.js';

const NODE_RADIUS = NODE_SIZE * 0.42; // the disc's world radius (matches the shader edge)
const PLUS_GAP = 16;
const PORT_GAP = 5;
const PORT_COUNT = 2;

export class AffordanceLayer {
  constructor(canvas) {
    this.container = document.createElement('div');
    this.container.className = 'st-affordances';
    canvas.parentElement.appendChild(this.container);

    this.plus = document.createElement('div');
    this.plus.className = 'st-plus';
    this.plus.textContent = '+';
    this.container.appendChild(this.plus);

    this.ports = Array.from({ length: PORT_COUNT }, () => {
      const port = document.createElement('div');
      port.className = 'st-port';
      this.container.appendChild(port);
      return port;
    });

    this.nodesById = new Map();
    this.parents = new Map();
    this.neighbors = new Map();
    this.hoveredId = null;
  }

  setModel(renderModel) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.parents = new Map(renderModel.nodes.map((node) => [node.id, []]));
    this.neighbors = new Map(renderModel.nodes.map((node) => [node.id, []]));
    for (const edge of renderModel.edges) {
      this.parents.get(edge.to).push(edge.from);
      this.neighbors.get(edge.from).push(edge.to);
      this.neighbors.get(edge.to).push(edge.from);
    }
    this.setHovered(null);
  }

  setHovered(id) {
    this.hoveredId = this.nodesById.has(id) ? id : null;
    this.container.classList.toggle('st-affordances--on', this.hoveredId !== null);
  }

  update(camera) {
    const node = this.hoveredId ? this.nodesById.get(this.hoveredId) : null;
    if (!node) return;
    const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const rim = NODE_RADIUS * camera.zoom;

    const dirTo = (id) => { const o = this.nodesById.get(id); return Math.atan2(o.y - node.y, o.x - node.x); };
    const parentAngles = this.parents.get(node.id).map(dirTo);
    const neighborAngles = this.neighbors.get(node.id).map(dirTo);

    const outward = this.outwardAngle(parentAngles, neighborAngles);
    this.place(this.plus, sx, sy, outward, rim + PLUS_GAP);

    const slots = this.freeAngles([...neighborAngles, outward], this.ports.length);
    this.ports.forEach((port, i) => this.place(port, sx, sy, slots[i], rim + PORT_GAP));
  }

  // Away from the parents (toward where a child grows); the root fans toward its
  // children; an isolated node just points down (world is y-down).
  outwardAngle(parentAngles, neighborAngles) {
    if (parentAngles.length > 0) return circularMean(parentAngles) + Math.PI;
    if (neighborAngles.length > 0) return circularMean(neighborAngles);
    return Math.PI / 2;
  }

  // The midpoints of the widest angular gaps between occupied directions, so ports
  // land on free rim rather than on top of a branch or the plus.
  freeAngles(occupied, count) {
    if (occupied.length === 0) return [0, Math.PI].slice(0, count);
    const sorted = [...occupied].sort((a, b) => a - b);
    const gaps = sorted.map((angle, i) => {
      const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + Math.PI * 2;
      return { size: next - angle, mid: (angle + next) / 2 };
    });
    gaps.sort((a, b) => b.size - a.size);
    return gaps.slice(0, count).map((gap) => gap.mid);
  }

  place(element, sx, sy, angle, distance) {
    const x = sx + Math.cos(angle) * distance;
    const y = sy + Math.sin(angle) * distance;
    element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  dispose() {
    this.container.remove();
  }
}

function circularMean(angles) {
  let sin = 0;
  let cos = 0;
  for (const angle of angles) { sin += Math.sin(angle); cos += Math.cos(angle); }
  return Math.atan2(sin, cos);
}
