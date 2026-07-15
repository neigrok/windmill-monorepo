// The one place gesture semantics execute on the client: each editing gesture becomes a
// list of stamped writes — a partial subgraph — computed against the current lattice, all
// sharing one HLC stamp so the gesture is atomic on the wire. This retires editing/edits.js:
// the splice, fan-out, and reduction logic lives here now, over the lattice instead of over
// TreeData, and there is exactly one encoding of it.

import { hlcText } from './lattice.js';

function node(id, at, fields) {
  const entry = { id };
  const s = hlcText(at);
  if (fields.created) entry.createdAt = s;
  if (fields.deleted) entry.deletedAt = s;
  if ('label' in fields) { entry.label = fields.label; entry.labelAt = s; }
  if ('icon' in fields) { entry.icon = fields.icon; entry.iconAt = s; }
  if ('color' in fields) { entry.color = fields.color; entry.colorAt = s; }
  if ('position' in fields) { entry.position = fields.position; entry.positionAt = s; }
  if ('status' in fields) { entry.status = fields.status; entry.statusAt = s; }
  return entry;
}

const addEdge = (from, to, at) => ({ from, to, addedAt: hlcText(at) });
const removeEdge = (from, to, at) => ({ from, to, removedAt: hlcText(at) });

function kind(id, at, fields) {
  const entry = { id };
  const s = hlcText(at);
  if (fields.created) entry.createdAt = s;
  if (fields.deleted) entry.deletedAt = s;
  if ('hue' in fields) { entry.hue = fields.hue; entry.hueAt = s; }
  if ('label' in fields) { entry.label = fields.label; entry.labelAt = s; }
  if ('description' in fields) { entry.description = fields.description; entry.descriptionAt = s; }
  if ('rank' in fields) { entry.rank = fields.rank; entry.rankAt = s; }
  return entry;
}

// Redundant edges: a direct parent that another parent already reaches transitively. Mirrors
// LooseGraph::redundantEdges / editing/edits.js transitiveReduction, over the projection.
function redundantEdges(data) {
  const prereqsOf = new Map(data.nodes.map((n) => [n.id, n.prerequisites]));
  const memo = new Map();
  const ancestorsOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const ancestors = new Set();
    memo.set(id, ancestors);
    for (const parent of prereqsOf.get(id) ?? []) {
      ancestors.add(parent);
      for (const up of ancestorsOf(parent)) ancestors.add(up);
    }
    return ancestors;
  };
  const redundant = [];
  for (const n of data.nodes) {
    for (const from of n.prerequisites) {
      if (n.prerequisites.some((other) => other !== from && ancestorsOf(other).has(from))) {
        redundant.push({ from, to: n.id });
      }
    }
  }
  return redundant;
}

// gesture: { kind, ...payload }. Returns { nodes, edges, kinds } — a partial subgraph. The
// caller stamps it with a frameId/actor and joins + sends it.
export function materialize(gesture, lattice, clock) {
  const at = clock.tick(Date.now());
  const data = lattice.toTreeData();
  const nodes = [];
  const edges = [];
  const kinds = [];
  const g = gesture;

  switch (g.kind) {
    case 'CreateNode': {
      nodes.push(node(g.id, at, { created: true, label: g.label ?? '', icon: g.icon ?? '', color: g.color ?? 'terracotta', position: g.x != null && g.y != null ? { x: g.x, y: g.y } : null }));
      if (g.parentId) edges.push(addEdge(g.parentId, g.id, at));
      break;
    }
    case 'ResurrectNode': nodes.push(node(g.id, at, { created: true })); break;  // re-add life only; the tombstoned fields survive
    case 'RenameNode': nodes.push(node(g.id, at, { label: g.label })); break;
    case 'SetNodeColor': nodes.push(node(g.id, at, { color: g.color })); break;
    case 'RepositionNode': nodes.push(node(g.id, at, { position: { x: g.x, y: g.y } })); break;
    case 'AddEdge': edges.push(addEdge(g.from, g.to, at)); break;
    case 'RemoveEdge': edges.push(removeEdge(g.from, g.to, at)); break;
    case 'ReconnectEdge':
      edges.push(removeEdge(g.oldFrom, g.oldTo, at));
      edges.push(addEdge(g.newFrom, g.newTo, at));
      break;
    case 'DeleteNode': {
      const target = data.nodes.find((n) => n.id === g.id);
      if (!target) break;
      nodes.push(node(g.id, at, { deleted: true }));
      const grandparents = target.prerequisites;
      for (const child of data.nodes) {
        if (!child.prerequisites.includes(g.id)) continue;
        const others = child.prerequisites.filter((p) => p !== g.id);
        if (others.length > 0) continue;  // the child keeps a live parent — nothing to re-tether
        for (const grand of new Set(grandparents)) {
          if (grand !== child.id) edges.push(addEdge(grand, child.id, at));  // splice the child up
        }
      }
      break;
    }
    case 'TransitiveReduction':
      for (const edge of redundantEdges(data)) edges.push(removeEdge(edge.from, edge.to, at));
      break;
    case 'RenameKind': kinds.push(kind(g.id, at, { label: g.label })); break;
    case 'DescribeKind': kinds.push(kind(g.id, at, { description: g.description })); break;
    case 'AddKind':
      kinds.push(kind(g.id, at, { created: true, hue: g.hue, rank: lattice.nextRank() }));
      break;
    case 'RemoveKind': kinds.push(kind(g.id, at, { deleted: true })); break;
    case 'ReorderKinds':
      g.order.forEach((id, i) => kinds.push(kind(id, at, { rank: i })));
      break;
    case 'RecolorKind': {
      const target = data.kinds.find((k) => k.id === g.id);
      const oldHue = target?.hue;
      kinds.push(kind(g.id, at, { hue: g.hue }));
      if (oldHue) for (const n of data.nodes) if (n.color === oldHue) nodes.push(node(n.id, at, { color: g.hue }));
      break;
    }
    default: break;
  }

  return { nodes, edges, kinds };
}
