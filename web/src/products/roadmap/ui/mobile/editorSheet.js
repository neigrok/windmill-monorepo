export function deleteCostLine(childCount) {
  if (childCount <= 0) return 'Removes this step';
  if (childCount === 1) return 'Removes this step · 1 branch resplices';
  return `Removes this step · ${childCount} branches resplice`;
}

// A locked step offers nothing; a completed one offers the reversal; everything else marks done.
// The root is included: blocking root completion would freeze all progress from a phone.
export function progressVerb(state) {
  if (state === 'complete') return 'uncomplete';
  if (state === 'locked') return null;
  return 'complete';
}

// One surface at a time: bulk bar, then aim bar, then remove-link bar, then the selection editor.
export function activeSurface({ multiMode, aim, removing, selectedNode }) {
  if (multiMode) return 'bulk';
  if (aim) return 'aim';
  if (removing) return 'remove';
  if (selectedNode) return 'editor';
  return 'empty';
}
