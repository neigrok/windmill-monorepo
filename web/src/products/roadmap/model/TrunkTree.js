// Elects one trunk parent per node, then derives each node's branch root, trunk depth and
// leaf weight.

// Sibling order is lexicographic over (order, createdAt, id); an empty `order` sorts first.
const ZERO_STAMP = { ms: 0, counter: 0, actor: '' };

export function cmpOrder(a, b) {
  const orderA = a.order ?? '';
  const orderB = b.order ?? '';
  if (orderA !== orderB) return orderA < orderB ? -1 : 1;
  // A missing createdAt compares as the zero stamp; skipping it makes the compare non-transitive.
  const stampA = a.createdAt ?? ZERO_STAMP;
  const stampB = b.createdAt ?? ZERO_STAMP;
  if (stampA.ms !== stampB.ms) return stampA.ms < stampB.ms ? -1 : 1;
  if (stampA.counter !== stampB.counter) return stampA.counter < stampB.counter ? -1 : 1;
  if (stampA.actor !== stampB.actor) return stampA.actor < stampB.actor ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
      const cutsBranch = elected.id === this.centerNodeId || elected.color !== node.color;
      this.branchRootById.set(id, cutsBranch ? id : this.branchRootById.get(elected.id));
      this.trunkChildrenById.get(elected.id).push(id);
    }

    for (const children of this.trunkChildrenById.values()) {
      children.sort((x, y) => cmpOrder(tree.nodesById.get(x), tree.nodesById.get(y)));
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
