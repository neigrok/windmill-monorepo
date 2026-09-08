import { NODE_BODY_DIAMETER, WORKING_ZOOM } from '../model/geometry.js';
import { edgeKey } from './edgeKey.js';

export const OVERVIEW_BODY_DIAMETER = 20;

export function sceneHierarchy(nodes, edges) {
  const parentEdges = new Map();
  const children = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edge.kind !== 'trunk') continue;
    parentEdges.set(edge.to, edge);
    children.get(edge.from)?.push(edge.to);
  }
  const roots = nodes.filter((node) => !parentEdges.has(node.id)).map((node) => node.id);
  const depthById = new Map(roots.map((id) => [id, 0]));
  const queue = [...roots];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    for (const child of children.get(id) ?? []) {
      depthById.set(child, depthById.get(id) + 1);
      queue.push(child);
    }
  }
  const backboneKeys = new Set(edges.filter((edge) => edge.kind === 'trunk'
    && depthById.get(edge.from) <= 1 && children.get(edge.to)?.length > 0)
    .sort((a, b) => depthById.get(a.from) - depthById.get(b.from)).slice(0, 64)
    .map((edge) => edgeKey(edge.from, edge.to)));
  const anchors = new Set(roots);
  if (roots.length === 1) for (const id of children.get(roots[0]) ?? []) anchors.add(id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const branchIds = roots.length === 1 && children.get(roots[0])?.length ? children.get(roots[0]) : roots;
  const summaries = [];
  for (const id of branchIds) {
    const members = [id];
    let x = 0;
    let y = 0;
    for (let i = 0; i < members.length; i += 1) {
      const node = byId.get(members[i]);
      if (!node) continue;
      x += node.x;
      y += node.y;
      members.push(...(children.get(node.id) ?? []));
    }
    const node = byId.get(id);
    if (!node) continue;
    summaries.push({ id: `branch-summary:${id}`, sourceId: id, label: node.label, color: node.color,
      x: x / members.length, y: y / members.length, count: members.length, summary: true });
  }
  return { parentEdges, children, roots, anchors, summaries, backboneKeys };
}

export function spotlightEdges(id, hierarchy, edgesByNode, edges) {
  const keys = new Set();
  if (id == null) return keys;
  for (const index of edgesByNode.get(id) ?? []) {
    const edge = edges[index];
    keys.add(edgeKey(edge.from, edge.to));
  }
  const visited = new Set();
  for (let next = id; next != null && !visited.has(next);) {
    visited.add(next);
    const edge = hierarchy.parentEdges.get(next);
    if (!edge) break;
    keys.add(edgeKey(edge.from, edge.to));
    next = edge.from;
  }
  return keys;
}

export function edgeVisibility(edge, from, to, viewport, zoom, emphasized = false) {
  if (!from || !to) return 0;
  if (emphasized) return 2;
  if (edge.kind !== 'trunk') return 0;
  if (NODE_BODY_DIAMETER * zoom < OVERVIEW_BODY_DIAMETER) return edge.overview ? 1 : 0;
  const pad = NODE_BODY_DIAMETER;
  const inside = (node) => node.x >= viewport.minX - pad && node.x <= viewport.maxX + pad
    && node.y >= viewport.minY - pad && node.y <= viewport.maxY + pad;
  return inside(from) && inside(to) ? 1 : 0;
}

export function defaultFocusId(nodes, hierarchy, viewport = { viewportWidth: 1440, viewportHeight: 900 }) {
  const root = hierarchy.roots.map((id) => nodes.get(id)).find(Boolean);
  if (!root) return null;
  const insets = viewport.insets ?? {};
  const halfWidth = (viewport.viewportWidth - (insets.left ?? 0) - (insets.right ?? 0)) * 0.4 / WORKING_ZOOM;
  const halfHeight = (viewport.viewportHeight - (insets.top ?? 0) - (insets.bottom ?? 0)) * 0.4 / WORKING_ZOOM;
  const hasNeighborhood = (id) => {
    const node = nodes.get(id);
    return node && (hierarchy.children.get(id) ?? []).some((childId) => {
      const child = nodes.get(childId);
      return child && Math.abs(child.x - node.x) + NODE_BODY_DIAMETER < halfWidth
        && Math.abs(child.y - node.y) + NODE_BODY_DIAMETER < halfHeight;
    });
  };
  if (hasNeighborhood(root.id)) return root.id;
  const branches = [...hierarchy.summaries].sort((a, b) => b.count - a.count);
  return branches.find((branch) => hasNeighborhood(branch.sourceId))?.sourceId
    ?? branches.find((branch) => branch.count > 1)?.sourceId ?? root.id;
}
