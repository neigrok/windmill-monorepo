import { DEFAULT_NODE_COLOR } from '../theme.js';
import { kindChoices } from './Legend.js';
import { takesMark } from './UnlockRules.js';

export function isGrouped(size) {
  return size >= 2;
}

// The selected steps a bulk Mark done marks: the unmarked ones that take a hand mark.
export function markDoneTargets(tree, selectedIds, completed) {
  return [...selectedIds].filter((id) => !completed.has(id) && takesMark(tree.nodesById.get(id)));
}

// The one kind a whole selection wears, or null when it is mixed, empty or holds a step the tree no longer has.
export function sharedKind(tree, ids) {
  if (!tree || ids.length === 0) return null;
  const steps = ids.map((id) => tree.nodesById.get(id));
  if (steps.some((step) => !step)) return null;
  const kind = steps[0].color ?? DEFAULT_NODE_COLOR;
  return steps.every((step) => (step.color ?? DEFAULT_NODE_COLOR) === kind) ? kind : null;
}

// What every bulk bar offers and rings: the six kind choices and the kind the selection shares.
export function bulkKindChoice(tree, ids, legend) {
  return { kinds: kindChoices(legend), shared: sharedKind(tree, ids) };
}
