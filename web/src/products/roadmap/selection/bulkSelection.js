export function isGrouped(size) {
  return size >= 2;
}

export function markDoneTargets(selectedIds, completed) {
  return [...selectedIds].filter((id) => !completed.has(id));
}

// The one kind a whole selection shares, or null when it is mixed.
export function sharedKind(colors) {
  if (colors.length === 0) return null;
  const first = colors[0];
  for (const color of colors) if (color !== first) return null;
  return first;
}
