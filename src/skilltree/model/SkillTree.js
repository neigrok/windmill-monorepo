// The tree entity: validates the DAG once at construction, then answers every
// graph question (ranks, ancestry, render projection) from indices built here.
// Pure — no three.js, no React.

import { NODE_SIZE } from '../theme.js';

function hashToUnit(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export class SkillTree {
  constructor(treeData) {
    this.treeId = treeData.id;
    this.treeTitle = treeData.title;
    this.allNodes = treeData.nodes;

    this.nodesById = new Map();
    for (const node of this.allNodes) {
      if (this.nodesById.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
      this.nodesById.set(node.id, node);
    }

    for (const node of this.allNodes) {
      for (const prereqId of node.prerequisites) {
        if (!this.nodesById.has(prereqId)) {
          throw new Error(`Node "${node.id}" lists unknown prerequisite "${prereqId}"`);
        }
      }
    }

    this.allEdges = this.allNodes.flatMap((node) =>
      node.prerequisites.map((prereqId) => ({ from: prereqId, to: node.id }))
    );

    this.childrenIndex = new Map(this.allNodes.map((node) => [node.id, []]));
    for (const edge of this.allEdges) this.childrenIndex.get(edge.from).push(this.nodesById.get(edge.to));

    this.orderedIds = this.sortTopologically();
    this.rankById = this.computeRanks();
  }

  get id() { return this.treeId; }
  get title() { return this.treeTitle; }
  get nodes() { return this.allNodes; }
  get edges() { return this.allEdges; }

  roots() {
    return this.allNodes.filter((node) => node.prerequisites.length === 0);
  }

  parentsOf(id) {
    return this.nodeOrThrow(id).prerequisites.map((prereqId) => this.nodesById.get(prereqId));
  }

  childrenOf(id) {
    this.nodeOrThrow(id);
    return this.childrenIndex.get(id);
  }

  ancestorsOf(id) {
    const node = this.nodeOrThrow(id);
    const seen = new Set();
    const ordered = [];
    const queue = [...node.prerequisites];

    while (queue.length > 0) {
      const parentId = queue.shift();
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      ordered.push(this.nodesById.get(parentId));
      queue.push(...this.nodesById.get(parentId).prerequisites);
    }

    return ordered;
  }

  topoOrder() {
    return this.orderedIds;
  }

  ranks() {
    return this.rankById;
  }

  toRenderModel(positions, states) {
    const renderNodes = this.allNodes.map((node) => {
      const position = positions.get(node.id);
      if (!position) throw new Error(`Missing position for node "${node.id}"`);
      return {
        id: node.id,
        label: node.label,
        icon: node.icon,
        x: position.x,
        y: position.y,
        layer: this.rankById.get(node.id) % 3,
        state: states.get(node.id) ?? 'locked',
        glowSeed: hashToUnit(node.id),
      };
    });

    const renderEdges = this.allEdges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      active: states.get(edge.from) === 'complete',
    }));

    const xs = renderNodes.map((node) => node.x);
    const ys = renderNodes.map((node) => node.y);
    const bounds = {
      minX: Math.min(...xs) - NODE_SIZE,
      minY: Math.min(...ys) - NODE_SIZE,
      maxX: Math.max(...xs) + NODE_SIZE,
      maxY: Math.max(...ys) + NODE_SIZE,
    };

    return { nodes: renderNodes, edges: renderEdges, bounds };
  }

  nodeOrThrow(id) {
    const node = this.nodesById.get(id);
    if (!node) throw new Error(`Unknown node id "${id}"`);
    return node;
  }

  sortTopologically() {
    const inDegree = new Map(this.allNodes.map((node) => [node.id, node.prerequisites.length]));
    const queue = this.allNodes.filter((node) => node.prerequisites.length === 0).map((node) => node.id);
    const ordered = [];

    while (queue.length > 0) {
      const id = queue.shift();
      ordered.push(id);
      for (const child of this.childrenIndex.get(id)) {
        const remaining = inDegree.get(child.id) - 1;
        inDegree.set(child.id, remaining);
        if (remaining === 0) queue.push(child.id);
      }
    }

    if (ordered.length !== this.allNodes.length) {
      const stuck = this.allNodes.map((node) => node.id).filter((id) => !ordered.includes(id));
      throw new Error(`Tree "${this.treeId}" has a cycle among: ${stuck.join(', ')}`);
    }

    return ordered;
  }

  computeRanks() {
    const rankById = new Map();
    for (const id of this.orderedIds) {
      const parentRanks = this.nodesById.get(id).prerequisites.map((prereqId) => rankById.get(prereqId));
      rankById.set(id, parentRanks.length === 0 ? 0 : Math.max(...parentRanks) + 1);
    }
    return rankById;
  }
}
