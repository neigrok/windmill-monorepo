// A milestone is the structural moment worth sharing (ceremony-moments canon): a whole BRANCH
// — a root-child's entire subtree turning to light — or the CROWN, the last step anywhere, the
// whole tree complete. Never a single step. detectMilestones returns the milestones that JUST
// crossed into complete between two completed sets; it is pure, so the offer conduct (owner-only,
// once-ever) lives in the shell where ownership and the per-device ledger are known.

export const CROWN = '__crown__';

// A limb of one node is just a step, not a branch — the offer never fires for it (the spec's
// "never a single step, however big it felt").
const MIN_BRANCH_STEPS = 2;

export function detectMilestones(tree, prevCompleted, nextCompleted) {
  if (!tree || tree.nodes.length === 0) return [];

  // Crown supersedes: completing the last step also completes its branch, but the whole tree is
  // the bigger picture, so it is the only milestone offered when it lands. A one-node tree is a
  // single step, not a tree to celebrate — it needs the same floor a branch does.
  const total = tree.nodes.length;
  const allDone = (set) => tree.nodes.every((node) => set.has(node.id));
  if (total >= MIN_BRANCH_STEPS && allDone(nextCompleted) && !allDone(prevCompleted)) {
    return [{ id: CROWN, kind: 'crown', label: tree.title ?? '', done: total, total }];
  }

  const milestones = [];
  for (const rootChildId of rootChildIds(tree)) {
    const subtree = subtreeIds(tree, rootChildId);
    if (subtree.size < MIN_BRANCH_STEPS) continue;
    if (!isSubset(subtree, nextCompleted)) continue; // the limb is not fully lit
    if (isSubset(subtree, prevCompleted)) continue;   // it was already lit before this step — not fresh
    const node = tree.nodesById.get(rootChildId);
    milestones.push({ id: rootChildId, kind: 'branch', label: node?.label ?? '', done: subtree.size, total: subtree.size });
  }
  return milestones;
}

// The direct children of every root — the branch roots. (The graph is a DAG: a diamond
// descendant is counted in every limb it hangs from, so a shared step can complete two limbs at
// once; the shell picks one to show and the ledger keeps each once-ever.)
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
