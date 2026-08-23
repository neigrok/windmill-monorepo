// A milestone is a whole branch (a root-child's subtree) or the crown (the whole tree), never a
// single step, and only when it crossed into complete between the two sets.

export const CROWN = '__crown__';

// A limb of one node is a step, not a branch — no milestone fires for it.
const MIN_BRANCH_STEPS = 2;

export function detectMilestones(tree, prevCompleted, nextCompleted) {
  if (!tree || tree.nodes.length === 0) return [];

  const total = tree.nodes.length;
  const allDone = (set) => tree.nodes.every((node) => set.has(node.id));
  if (total >= MIN_BRANCH_STEPS && allDone(nextCompleted) && !allDone(prevCompleted)) {
    return [{ id: CROWN, kind: 'crown', label: tree.title ?? '', done: total, total }];
  }

  const milestones = [];
  for (const rootChildId of rootChildIds(tree)) {
    const subtree = subtreeIds(tree, rootChildId);
    if (subtree.size < MIN_BRANCH_STEPS) continue;
    if (!isSubset(subtree, nextCompleted)) continue;
    if (isSubset(subtree, prevCompleted)) continue;
    const node = tree.nodesById.get(rootChildId);
    milestones.push({ id: rootChildId, kind: 'branch', label: node?.label ?? '', done: subtree.size, total: subtree.size });
  }
  return milestones;
}

// The graph is a DAG: a shared descendant counts in every limb it hangs from.
function rootChildIds(tree) {
  const ids = new Set();
  for (const root of tree.roots()) {
    for (const child of tree.childrenOf(root.id)) ids.add(child.id);
  }
  return ids;
}

function subtreeIds(tree, rootId) {
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    for (const child of tree.childrenOf(queue.shift())) {
      if (!seen.has(child.id)) { seen.add(child.id); queue.push(child.id); }
    }
  }
  return seen;
}

function isSubset(subset, superset) {
  for (const id of subset) if (!superset.has(id)) return false;
  return true;
}
