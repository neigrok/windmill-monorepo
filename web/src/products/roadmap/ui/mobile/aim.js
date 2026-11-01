// Tap-then-tap legality: which nodes a tap may NOT land on, and which way the edge it creates points.
// A cycle or a duplicate edge is illegal; multiple parents are fine.

export function illegalTargets(tree, sourceId, direction) {
  const illegal = new Set([sourceId]);
  if (direction === 'needs') {
    for (const descendant of tree.descendantsOf(sourceId)) illegal.add(descendant.id);
    for (const parent of tree.parentsOf(sourceId)) illegal.add(parent.id);
    return illegal;
  }
  for (const ancestor of tree.ancestorsOf(sourceId)) illegal.add(ancestor.id);
  for (const child of tree.childrenOf(sourceId)) illegal.add(child.id);
  return illegal;
}

export function edgeFor(sourceId, targetId, direction) {
  if (direction === 'needs') return { from: targetId, to: sourceId };
  return { from: sourceId, to: targetId };
}
