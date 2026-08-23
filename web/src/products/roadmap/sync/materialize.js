// Each editing gesture becomes a list of stamped writes — a partial subgraph — computed against
// the current lattice, all sharing one HLC stamp so the gesture is atomic on the wire.

import { hlcText } from './lattice.js';
import { keyBetween, nKeysBetween } from './fractionalIndex.js';

function node(id, at, fields) {
  const entry = { id };
  const s = hlcText(at);
  if (fields.created) entry.createdAt = s;
  if (fields.deleted) entry.deletedAt = s;
  if ('label' in fields) { entry.label = fields.label; entry.labelAt = s; }
  if ('icon' in fields) { entry.icon = fields.icon; entry.iconAt = s; }
  if ('color' in fields) { entry.color = fields.color; entry.colorAt = s; }
  if ('order' in fields) { entry.order = fields.order; entry.orderAt = s; }
  if ('position' in fields) { entry.position = fields.position; entry.positionAt = s; }
  if ('status' in fields) { entry.status = fields.status; entry.statusAt = s; }
  if ('description' in fields) { entry.description = fields.description; entry.descriptionAt = s; }
  if ('links' in fields) { entry.links = fields.links; entry.linksAt = s; }
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

// gesture: { kind, ...payload } → { nodes, edges, kinds }, a partial subgraph the caller stamps
// with a frameId/actor, then joins and sends.
export function materialize(gesture, lattice, clock) {
  const at = clock.tick(Date.now());
  const data = lattice.toTreeData();
  const nodes = [];
  const edges = [];
  const kinds = [];
  const g = gesture;

  switch (g.kind) {
    case 'CreateNode': {
      // Slot the new node after its last-ordered sibling, so a create appends rather than renumbers.
      const parentId = g.parentId ?? null;
      const siblings = data.nodes.filter((n) => (parentId ? n.prerequisites.includes(parentId) : n.prerequisites.length === 0));
      let lastOrder = null;
      for (const sibling of siblings) if (sibling.order && (lastOrder === null || sibling.order > lastOrder)) lastOrder = sibling.order;
      const order = keyBetween(lastOrder, null);
      nodes.push(node(g.id, at, { created: true, label: g.label ?? '', icon: g.icon ?? '', color: g.color ?? 'terracotta', order, position: g.x != null && g.y != null ? { x: g.x, y: g.y } : null, ...(g.description ? { description: g.description } : {}), ...(g.links?.length ? { links: g.links } : {}) }));
      if (g.parentId) edges.push(addEdge(g.parentId, g.id, at));
      break;
    }
    // The whole pasted subgraph lands as one gesture: one stamp, one persist, one undo entry.
    case 'ImportSubgraph': {
      // Seed order so a graft appends after the parent's children; an empty order sorts first.
      const primaryParent = new Map();
      for (const e of g.edges) if (!primaryParent.has(e.to)) primaryParent.set(e.to, e.from);
      const needKeys = new Map();
      for (const n of g.nodes) {
        if (n.order) continue;
        const parentId = primaryParent.get(n.id) ?? '';
        if (!needKeys.has(parentId)) needKeys.set(parentId, []);
        needKeys.get(parentId).push(n.id);
      }
      const seeded = new Map();
      for (const [parentId, ids] of needKeys) {
        const siblings = data.nodes.filter((nd) => (parentId ? nd.prerequisites.includes(parentId) : nd.prerequisites.length === 0));
        let lastOrder = null;
        for (const sibling of siblings) if (sibling.order && (lastOrder === null || sibling.order > lastOrder)) lastOrder = sibling.order;
        nKeysBetween(lastOrder, null, ids.length).forEach((key, i) => seeded.set(ids[i], key));
      }
      for (const n of g.nodes) {
        nodes.push(node(n.id, at, {
          created: true,
          label: n.label ?? '',
          icon: n.icon ?? '',
          color: n.color ?? 'terracotta',
          position: n.position ?? null,
          order: n.order ?? seeded.get(n.id) ?? '',
          ...(n.status ? { status: n.status } : {}),
          ...(n.description ? { description: n.description } : {}),
          ...(n.links?.length ? { links: n.links } : {}),
        }));
      }
      for (const e of g.edges) edges.push(addEdge(e.from, e.to, at));
      const baseRank = lattice.nextRank();
      (g.kinds ?? []).forEach((k, i) => kinds.push(kind(k.id, at, {
        created: true, hue: k.hue, label: k.label ?? '', description: k.description ?? '', rank: baseRank + i,
      })));
      break;
    }
    case 'ResurrectNode': nodes.push(node(g.id, at, { created: true })); break;  // life only; the tombstoned fields survive
    case 'RenameNode': nodes.push(node(g.id, at, { label: g.label })); break;
    case 'DescribeNode': nodes.push(node(g.id, at, { description: g.description })); break;
    case 'SetNodeColor': nodes.push(node(g.id, at, { color: g.color })); break;
    case 'SetNodeOrder': nodes.push(node(g.id, at, { order: g.order })); break;  // one register write; siblings re-sort, none renumber
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
        if (others.length > 0) continue;  // the child keeps a live parent
        for (const grand of new Set(grandparents)) {
          if (grand !== child.id) edges.push(addEdge(grand, child.id, at));  // splice the child up
        }
      }
      break;
    }
    // A surviving child that loses all its parents is spliced up to its nearest live ancestors.
    case 'BulkDelete': {
      const doomed = new Set(g.nodeIds);
      const byId = new Map(data.nodes.map((n) => [n.id, n]));
      for (const id of g.nodeIds) if (byId.has(id)) nodes.push(node(id, at, { deleted: true }));
      for (const child of data.nodes) {
        if (doomed.has(child.id)) continue;
        if (!child.prerequisites.some((p) => doomed.has(p))) continue; // no doomed parent
        if (child.prerequisites.some((p) => !doomed.has(p))) continue; // keeps a live parent
        const survivors = new Set();
        const seen = new Set();
        const stack = child.prerequisites.filter((p) => doomed.has(p));
        while (stack.length > 0) {
          const p = stack.pop();
          if (seen.has(p)) continue;
          seen.add(p);
          for (const grand of byId.get(p)?.prerequisites ?? []) {
            if (doomed.has(grand)) stack.push(grand); // keep climbing through doomed ancestors
            else survivors.add(grand);                // the nearest live ground on this path
          }
        }
        for (const grand of survivors) if (grand !== child.id) edges.push(addEdge(grand, child.id, at));
      }
      for (const e of g.edges ?? []) {
        if (doomed.has(e.from) || doomed.has(e.to)) continue; // dies with the tombstone anyway
        edges.push(removeEdge(e.from, e.to, at));
      }
      break;
    }
    case 'BulkRecolor': {
      const present = new Set(data.nodes.map((n) => n.id));
      for (const id of g.nodeIds) if (present.has(id)) nodes.push(node(id, at, { color: g.color }));
      break;
    }
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
