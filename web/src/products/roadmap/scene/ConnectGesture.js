// Dragging a branch end onto a node: start() pulls a new edge from a rim port, startReconnect() re-aims one end of an existing one; the node under the cursor rings by verdict — valid, cyclic, or valid-but-costly.
import { NODE_SIZE } from '../theme.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = NODE_SIZE * 0.42;

export class ConnectGesture {
  constructor(canvas, container, { camera, pick, onConnect, onReconnect, onFadeNodes, onRestoreNodes }) {
    this.canvas = canvas;
    this.camera = camera;
    this.pick = pick;
    this.onConnect = onConnect;
    this.onReconnect = onReconnect;
    this.onFadeNodes = onFadeNodes;
    this.onRestoreNodes = onRestoreNodes;
    this.nodesById = new Map();
    this.parents = new Map();
    this.active = null;

    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'st-connect');
    this.path = document.createElementNS(SVGNS, 'path');
    this.path.setAttribute('class', 'st-connect-ghost');
    this.svg.appendChild(this.path);
    container.appendChild(this.svg);

    this.ring = document.createElement('div');
    this.ring.className = 'st-connect-ring';
    container.appendChild(this.ring);

    this.tip = document.createElement('div');
    this.tip.className = 'st-connect-tip';
    container.appendChild(this.tip);
  }

  setModel(nodesById, parents) {
    this.nodesById = nodesById;
    this.parents = parents;
  }

  // The hit becomes the child, so the loop-closers are the source’s ancestors.
  start(sourceId, event) {
    if (!sourceId || !this.nodesById.has(sourceId)) return;
    this.begin(event, {
      mode: 'create',
      anchorId: sourceId,
      parents: this.parents,
      cycleNodes: this.reachable(sourceId, this.parents),
      sourceDescendants: this.reachable(sourceId, this.childrenMap(this.parents)),
      resolve: (hit) => ({ from: sourceId, to: hit }),
    });
  }

  // Re-aim one end, the other pinned; the loop-closers are walked on the graph with the old edge already removed.
  startReconnect(edge, movingEnd, event) {
    if (!this.nodesById.has(edge.from) || !this.nodesById.has(edge.to)) return;
    const parents = this.parentsWithout(edge.from, edge.to);
    this.begin(event, {
      mode: 'reconnect',
      edge,
      anchorId: movingEnd === 'from' ? edge.to : edge.from,
      parents,
      cycleNodes: movingEnd === 'from'
        ? this.reachable(edge.to, this.childrenMap(parents))
        : this.reachable(edge.from, parents),
      resolve: movingEnd === 'from'
        ? (hit) => ({ from: hit, to: edge.to })
        : (hit) => ({ from: edge.from, to: hit }),
    });
  }

  begin(event, active) {
    event.stopPropagation();
    this.captureEl = event.target;
    this.captureEl.setPointerCapture(event.pointerId);
    this.captureEl.addEventListener('pointermove', this.onMove);
    this.captureEl.addEventListener('pointerup', this.onUp);
    this.active = { ...active, pointerId: event.pointerId, result: null };
    if (this.onFadeNodes) this.onFadeNodes(active.cycleNodes);
    this.svg.classList.add('st-connect--on');
    this.onMove(event);
  }

  onMove = (event) => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    const cam = this.camera;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const anchor = this.nodesById.get(this.active.anchorId);
    const ax = (anchor.x - cam.x) * cam.zoom + cam.viewportWidth / 2;
    const ay = (anchor.y - cam.y) * cam.zoom + cam.viewportHeight / 2;

    const hit = this.pick(px, py);
    const { from, to } = hit ? this.active.resolve(hit) : { from: null, to: null };
    const eff = this.active.parents;
    const cyclic = hit && from !== to && this.active.cycleNodes.has(hit);
    const connected = hit && from !== to && (eff.get(to) || []).includes(from);
    const valid = hit && from !== to && !cyclic && !connected;

    let ex = px;
    let ey = py;
    if (hit) {
      const node = this.nodesById.get(hit);
      ex = (node.x - cam.x) * cam.zoom + cam.viewportWidth / 2;
      ey = (node.y - cam.y) * cam.zoom + cam.viewportHeight / 2;
      const rim = NODE_RADIUS * cam.zoom;
      if (cyclic) {
        this.showRing(ex, ey, rim, 'invalid');
        this.showTip(ex, ey, rim, 'This would create a loop');
      } else if (valid) {
        const sameBranch = this.nodesById.get(from).branch === this.nodesById.get(to).branch;
        const redundant = this.active.mode === 'create' && this.active.sourceDescendants && this.active.sourceDescendants.has(to);
        const crossBranch = !sameBranch;
        if (redundant || crossBranch) {
          this.showRing(ex, ey, rim, 'cost');
          this.showTip(ex, ey, rim, redundant ? 'Already implied' : 'Links across areas');
        } else {
          this.showRing(ex, ey, rim, 'valid');
          this.hideTip();
        }
      } else {
        this.showRing(ex, ey, rim, 'invalid');
        this.hideTip();
      }
    } else {
      this.hideRing();
      this.hideTip();
    }
    this.active.result = valid ? { from, to } : null;
    this.path.setAttribute('d', this.curve(ax, ay, ex, ey));
  };

  onUp = (event) => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    if (this.captureEl.hasPointerCapture(event.pointerId)) this.captureEl.releasePointerCapture(event.pointerId);
    this.captureEl.removeEventListener('pointermove', this.onMove);
    this.captureEl.removeEventListener('pointerup', this.onUp);
    const { mode, edge, result } = this.active;
    this.active = null;
    this.svg.classList.remove('st-connect--on');
    this.hideRing();
    this.hideTip();
    if (this.onRestoreNodes) this.onRestoreNodes();
    if (!result) return;
    if (mode === 'create') { if (this.onConnect) this.onConnect(result.from, result.to); return; }
    if (result.from === edge.from && result.to === edge.to) return; // dropped back on its own end
    if (this.onReconnect) this.onReconnect(edge.from, edge.to, result.from, result.to);
  };

  // The parents map with one edge removed, so a reconnect never counts the moving edge against itself.
  parentsWithout(from, to) {
    const clone = new Map();
    for (const [id, list] of this.parents) clone.set(id, id === to ? list.filter((p) => p !== from) : list);
    return clone;
  }

  // Nodes reachable from id along the adjacency map, id itself excluded.
  reachable(id, adjacency) {
    const result = new Set();
    const stack = [...(adjacency.get(id) || [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (result.has(next)) continue;
      result.add(next);
      stack.push(...(adjacency.get(next) || []));
    }
    return result;
  }

  childrenMap(parents) {
    const children = new Map();
    for (const [child, list] of parents) {
      for (const parent of list) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(child);
      }
    }
    return children;
  }

  curve(sx, sy, ex, ey) {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const bend = 0.09 * len;
    const cx = (sx + ex) / 2 - (dy / len) * bend;
    const cy = (sy + ey) / 2 + (dx / len) * bend;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  }

  showRing(x, y, rim, kind) {
    const diameter = (rim + 7) * 2;
    this.ring.className = `st-connect-ring st-connect-ring--${kind} st-connect-ring--on`;
    this.ring.style.width = `${diameter}px`;
    this.ring.style.height = `${diameter}px`;
    this.ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  hideRing() { this.ring.classList.remove('st-connect-ring--on'); }

  showTip(x, y, rim, message) {
    this.tip.textContent = message;
    this.tip.classList.add('st-connect-tip--on');
    this.tip.style.transform = `translate(${x}px, ${y + rim + 12}px) translate(-50%, 0)`;
  }

  hideTip() { this.tip.classList.remove('st-connect-tip--on'); }
}
