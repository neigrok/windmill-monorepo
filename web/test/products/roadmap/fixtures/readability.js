// The readability numbers every layout engine is judged on, at the desktop working zoom on a 1440x848 canvas — one
// implementation for the engine tests and scripts/benchmark-roadmap.mjs, so a pinned bar and a benchmark never drift.

import { footprintOf, footprintRect } from '../../../../src/products/roadmap/model/footprint.js';
import { BODY_WU, NODE_SIZE, WORKING_ZOOM } from '../../../../src/products/roadmap/theme.js';

export const WINDOW = { width: 1440, height: 848 };
export const FIT_PADDING = 0.9;

export const px = (wu) => wu * WORKING_ZOOM;

export const quantile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
};

// Two runs of one engine over one tree are the same picture only if this string matches.
export const serialise = (positions) => JSON.stringify([...positions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

// Whether `b` falls inside the working window centred on `a`.
export const inWindow = (a, b) => Math.abs(px(a.x - b.x)) <= WINDOW.width / 2 && Math.abs(px(a.y - b.y)) <= WINDOW.height / 2;

// Each node's reserved box at its seat, ordered left to right.
export function footprintRects(tree, positions) {
  return tree.nodes
    .map((node) => ({ id: node.id, ...footprintRect(positions.get(node.id).x, positions.get(node.id).y, footprintOf(node.label, { root: node.prerequisites.length === 0 })) }))
    .sort((a, b) => a.minX - b.minX);
}

// Every pair of nodes whose reserved boxes cross, as `a × b`; a readable picture has none.
export function footprintOverlaps(tree, positions) {
  const rects = footprintRects(tree, positions);
  const pairs = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length && rects[j].minX < rects[i].maxX; j += 1) {
      if (rects[j].minY < rects[i].maxY && rects[j].maxY > rects[i].minY) pairs.push(`${rects[i].id} × ${rects[j].id}`);
    }
  }
  return pairs;
}

// Screen px from each node to its trunk parent.
export function trunkLinksPx(tree, positions) {
  return tree.nodes
    .filter((node) => tree.trunk.primaryParentOf(node.id) !== null)
    .map((node) => {
      const parent = positions.get(tree.trunk.primaryParentOf(node.id));
      const child = positions.get(node.id);
      return px(Math.hypot(parent.x - child.x, parent.y - child.y));
    });
}

// Screen px from each node to the nearest other node.
export function nearestNeighboursPx(positions) {
  const points = [...positions.values()];
  return points.map((point, i) => {
    let best = Infinity;
    for (let j = 0; j < points.length; j += 1) {
      if (j === i) continue;
      best = Math.min(best, (points[j].x - point.x) ** 2 + (points[j].y - point.y) ** 2);
    }
    return px(Math.sqrt(best));
  });
}

// The share of each node's trunk kin that share its working window, averaged over the nodes that have kin.
export function familyInView(tree, positions) {
  const shares = tree.nodes.map((node) => {
    const parentId = tree.trunk.primaryParentOf(node.id);
    const kin = [...(parentId === null ? [] : [parentId]), ...tree.trunk.trunkChildrenOf(node.id)];
    if (kin.length === 0) return null;
    return kin.filter((id) => inWindow(positions.get(id), positions.get(node.id))).length / kin.length;
  }).filter((share) => share !== null);
  return shares.reduce((sum, share) => sum + share, 0) / Math.max(1, shares.length);
}

// The world box the whole tree spans, a body of air on every side.
export function boundsOf(positions) {
  const xs = [...positions.values()].map((point) => point.x);
  const ys = [...positions.values()].map((point) => point.y);
  return { width: Math.max(...xs) - Math.min(...xs) + NODE_SIZE * 2, height: Math.max(...ys) - Math.min(...ys) + NODE_SIZE * 2 };
}

export function fitZoom(positions) {
  const bounds = boundsOf(positions);
  return Math.min(Math.min(WINDOW.width / bounds.width, WINDOW.height / bounds.height) * FIT_PADDING, WORKING_ZOOM);
}

// How wide an ordinary body reads when the whole tree is fitted to the canvas.
export function fitBodyPx(positions) {
  return BODY_WU * fitZoom(positions);
}

// How many nodes share the working window centred on `id`.
export function countAround(positions, id) {
  if (!positions.has(id)) return null;
  const centre = positions.get(id);
  return [...positions.values()].filter((point) => inWindow(point, centre)).length;
}
