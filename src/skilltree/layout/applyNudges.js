// Lets a hand-authored tree override a handful of auto-layout coordinates
// (e.g. to straighten a diamond or de-clutter a cluster) without touching the
// rest of the layout. Pure: never mutates the Map it receives.
export function applyNudges(positions, tree) {
  const nudged = new Map(positions);
  tree.nodes.forEach((node) => {
    if (node.position) {
      nudged.set(node.id, node.position);
    }
  });
  return nudged;
}
