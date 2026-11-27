// Tap-then-tap legality: which nodes a tap may NOT land on, and which way the edge it creates points.
// A link that closes a loop, as the domain reads its loops, or repeats one the source already has is illegal; multiple
// parents are fine.

import { domainReading, readEffects } from '../../model/domainReads.js';

export function illegalTargets(tree, sourceId, direction) {
  const effects = readEffects(tree, [sourceId]);
  if (direction === 'needs') return new Set([...effects.loops.requires, ...domainReading(tree).graph.followed(sourceId).map((followed) => followed.id)]);
  return new Set([...effects.loops.opens, ...effects.follow]);
}

export function edgeFor(sourceId, targetId, direction) {
  if (direction === 'needs') return { from: targetId, to: sourceId };
  return { from: sourceId, to: targetId };
}
