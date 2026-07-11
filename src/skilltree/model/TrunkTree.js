// Elects one "trunk" (primary) parent per node — a spanning arborescence over
// the DAG — and derives each node's sector: branch root, trunk depth, leaf
// weight. Same-kind parents win; ties go to the shallowest, then smallest id.
// A branch starts wherever the trunk crosses a color boundary or hangs off the
// center, so sectors are affinity runs (topological runs when uncolored).
// Pure — no WebGL, no React.

export class TrunkTree {
  constructor(tree) {
    this.primaryParentById = new Map();
    this.trunkDepthById = new Map();
    this.branchRootById = new Map();
    this.trunkChildrenById = new Map();
    this.leafCountById = new Map();

    const roots = tree.roots();
    this.centerNodeId = roots.length === 1 ? roots[0].id : null;

    const order = tree.topoOrder();
    for (const id of order) this.trunkChildrenById.set(id, []);

    for (const id of order) {
      const node = tree.nodesById.get(id);
      const parents = tree.parentsOf(id);
      if (parents.length === 0) {
        this.primaryParentById.set(id, null);
        this.trunkDepthById.set(id, 0);
        this.branchRootById.set(id, id);
        continue;
      }

      const sameKind = node.color === undefined ? [] : parents.filter((parent) => parent.color === node.color);
      const candidates = sameKind.length > 0 ? sameKind : parents;
      const elected = candidates.reduce((best, candidate) => {
        const depthGap = this.trunkDepthById.get(candidate.id) - this.trunkDepthById.get(best.id);
        if (depthGap < 0) return candidate;
        if (depthGap === 0 && candidate.id < best.id) return candidate;
        return best;
      });

      this.primaryParentById.set(id, elected.id);
      this.trunkDepthById.set(id, this.trunkDepthById.get(elected.id) + 1);
      // a branch starts where the trunk crosses a color boundary or hangs off the center
      const cutsBranch = elected.id === this.centerNodeId || elected.color !== node.color;
      this.branchRootById.set(id, cutsBranch ? id : this.branchRootById.get(elected.id));
      this.trunkChildrenById.get(elected.id).push(id);
    }

    for (const id of [...order].reverse()) {
      const children = this.trunkChildrenById.get(id);
      if (children.length === 0) {
        this.leafCountById.set(id, 1);
        continue;
      }
      this.leafCountById.set(id, children.reduce((sum, childId) => sum + this.leafCountById.get(childId), 0));
    }

    this.branchRootIds = order.filter((id) => this.branchRootById.get(id) === id);
  }

  centerId() {
    return this.centerNodeId;
  }

  branchRoots() {
    return this.branchRootIds;
  }

  primaryParentOf(id) {
    return this.lookupOrThrow(this.primaryParentById, id);
  }

  trunkChildrenOf(id) {
    return this.lookupOrThrow(this.trunkChildrenById, id);
  }

  branchOf(id) {
    return this.lookupOrThrow(this.branchRootById, id);
  }

  trunkDepthOf(id) {
    return this.lookupOrThrow(this.trunkDepthById, id);
  }

  leafCountOf(id) {
    return this.lookupOrThrow(this.leafCountById, id);
  }

  edgeKind(fromId, toId) {
    if (this.primaryParentOf(toId) === fromId) return 'trunk';
    if (this.branchOf(fromId) === this.branchOf(toId)) return 'in-branch';
    return 'cross-branch';
  }

  lookupOrThrow(map, id) {
    if (!map.has(id)) throw new Error(`Unknown node id "${id}"`);
    return map.get(id);
  }
}
