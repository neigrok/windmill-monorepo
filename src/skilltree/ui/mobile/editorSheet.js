// The phone editor sheet's pure copy + gating, kept out of the JSX so node:test can
// pin the pluralized delete cost and the progress toggle.

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
