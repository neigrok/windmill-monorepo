// Pure diagnostics over a SkillTree: counts, cross-branch coupling, redundant
// (transitively implied) edges, and a single 0..100 health score.

const REDUNDANCY_NODE_LIMIT = 1500;

export class TreeHealth {
  static assess(tree) {
    const nodeCount = tree.nodes.length;
    const edgeCount = tree.edges.length;
    const crossBranch = tree.edges.filter((edge) => tree.trunk.edgeKind(edge.from, edge.to) === 'cross-branch').length;
    const redundant = nodeCount > REDUNDANCY_NODE_LIMIT ? 0 : TreeHealth.countRedundantEdges(tree);
    const avgInDegree = Math.round((edgeCount / Math.max(1, nodeCount)) * 100) / 100;

    const crossFrac = edgeCount ? crossBranch / edgeCount : 0;
    const redFrac = edgeCount ? redundant / edgeCount : 0;
    const score = Math.round(Math.max(0, Math.min(100, 100 * (1 - 0.6 * crossFrac - 0.4 * redFrac))));

    return { nodeCount, edgeCount, crossBranch, redundant, avgInDegree, score };
  }

  static countRedundantEdges(tree) {
    const descendantsById = new Map();
    for (const id of [...tree.topoOrder()].reverse()) {
      const descendants = new Set();
      for (const child of tree.childrenOf(id)) {
        descendants.add(child.id);
        for (const descendantId of descendantsById.get(child.id)) descendants.add(descendantId);
      }
      descendantsById.set(id, descendants);
    }

    // an edge is redundant when its target is already reachable through a sibling child
    let redundant = 0;
    for (const edge of tree.edges) {
      const implied = tree.childrenOf(edge.from).some((child) => child.id !== edge.to && descendantsById.get(child.id).has(edge.to));
      if (implied) redundant += 1;
    }
    return redundant;
  }
}
