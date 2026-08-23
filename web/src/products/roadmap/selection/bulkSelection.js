export function isGrouped(size) {
  return size >= 2;
}

export function markDoneTargets(selectedIds, completed) {
  return [...selectedIds].filter((id) => !completed.has(id));
}
