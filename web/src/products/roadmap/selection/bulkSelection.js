// Pure predicates for the multi-selection power surface (brief #10). A set is one thing, not N
// single-selections: the grouped bark highlight (the shader suppresses scale + swaps to a bark ring)
// and the light action card both key off "two or more", so `isGrouped` is the one place that rule
// lives. A bulk "mark all done" completes only the members that aren't already complete, so re-marking
// a set never replays a completion a node already earned. Pure — a size or two sets in, data out; no
// scene, no React.

export function isGrouped(size) {
  return size >= 2;
}

export function markDoneTargets(selectedIds, completed) {
  return [...selectedIds].filter((id) => !completed.has(id));
}
