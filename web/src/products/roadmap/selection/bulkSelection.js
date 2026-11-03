import { DEFAULT_NODE_COLOR, NODE_COLOR_NAMES } from '../theme.js';
import { kindOptionsForHues } from '../model/Legend.js';

export function isGrouped(size) {
  return size >= 2;
}

export function markDoneTargets(selectedIds, completed) {
  return [...selectedIds].filter((id) => !completed.has(id));
}

// The one kind a whole selection wears, or null when it is mixed, empty or holds a step the tree no longer has.
export function sharedKind(tree, ids) {
  if (!tree || ids.length === 0) return null;
  const steps = ids.map((id) => tree.nodesById.get(id));
  if (steps.some((step) => !step)) return null;
  const kind = steps[0].color ?? DEFAULT_NODE_COLOR;
  return steps.every((step) => (step.color ?? DEFAULT_NODE_COLOR) === kind) ? kind : null;
}

// What every bulk bar offers and rings: the whole palette, named by the legend where it can be, and the kind the selection shares.
export function bulkKindChoice(tree, ids, legend) {
  return { kinds: kindOptionsForHues(NODE_COLOR_NAMES, legend), shared: sharedKind(tree, ids) };
}
