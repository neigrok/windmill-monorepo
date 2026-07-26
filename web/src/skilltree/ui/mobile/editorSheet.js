// The mobile editor's pure copy + surface gating, kept out of the JSX so node:test can
// pin the pluralized delete cost, the progress toggle, and the one-at-a-time surface order.

export function deleteCostLine(childCount) {
  if (childCount <= 0) return 'Removes this step';
  if (childCount === 1) return 'Removes this step · 1 branch resplices';
  return `Removes this step · ${childCount} branches resplice`;
}

// The verb rail's progress toggle. A locked step offers nothing; a completed one offers
// the reversal (touch has no chip menu, so the button IS the un-do); everything else marks
// done. The root is included — a single-root tree can't unlock a child until its root is
// complete, so blocking root completion would freeze all progress from a phone.
export function progressVerb(state) {
  if (state === 'complete') return 'uncomplete';
  if (state === 'locked') return null;
  return 'complete';
}

// One surface at a time (M1/M7): the four mobile editing surfaces never stack. Multi-select's
// bulk bar wins, then the connect aim bar, then the remove-link bar, then the selection editor,
// else nothing. Phone docks the winner to the bottom edge, tablet into the panel column — both
// read the order from here so they can't drift, and the panel keys its cross-fade on the result.
export function activeSurface({ multiMode, aim, removing, selectedNode }) {
  if (multiMode) return 'bulk';
  if (aim) return 'aim';
  if (removing) return 'remove';
  if (selectedNode) return 'editor';
  return 'empty';
}
