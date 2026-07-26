// The bulk bar's pure predicate (M5): which single kind, if any, the whole node selection
// shares. The recolor row rings that kind so a same-kind set reads its category at a glance;
// a mixed-kind set shares nothing and rings no swatch until you pick one. Pure — an array of
// hues in, a hue or null out; no scene, no React.

export function sharedKind(colors) {
  if (colors.length === 0) return null;
  const first = colors[0];
  for (const color of colors) if (color !== first) return null;
  return first;
}
