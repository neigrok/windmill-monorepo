// Radial tidy tree over the trunk arborescence: each node sits on the ring for
// its trunk depth, at the center of an angular wedge; wedges split among trunk
// children proportional to subtree leaf counts. Synchronous — no worker, no dagre.
//
// A ring's radius is not simply its depth times a constant. The angles are fixed by the shape
// of the tree, so the only room a crowded ring can gain is further out: twenty siblings on a
// fixed first ring end up owning less arc than a node is wide, which is exactly what clumping
// looks like. So each ring is pushed out until its closest pair of neighbours has room to
// breathe. Sparse rings never reach that bound and sit where they always did.
import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { NODE_SIZE } from '../theme.js';

const RING = NODE_SIZE * 2.8;     // the least a ring clears the one inside it
const MIN_ARC = NODE_SIZE * 1.7;  // the arc between neighbours on a ring, center to center
const FULL_CIRCLE = 2 * Math.PI;

export class RadialLayoutEngine extends LayoutEngine {
  layout(tree) {
    const trunk = tree.trunk;
    // a synthetic center (multi-root) pushes the real roots out to the first ring
    const depthOffset = trunk.centerId() !== null ? 0 : 1;
    const wedges = [];

    const claim = (id, angleStart, angleEnd) => {
      wedges.push({
        id,
        depth: trunk.trunkDepthOf(id) + depthOffset,
        angle: (angleStart + angleEnd) / 2,
      });

      const children = trunk.trunkChildrenOf(id);
      if (children.length === 0) return;

      const totalLeaves = children.reduce((sum, childId) => sum + trunk.leafCountOf(childId), 0);
      let cursor = angleStart;
      for (const childId of children) {
        const span = ((angleEnd - angleStart) * trunk.leafCountOf(childId)) / totalLeaves;
        claim(childId, cursor, cursor + span);
        cursor += span;
      }
    };

    const centerId = trunk.centerId();
    if (centerId !== null) {
      claim(centerId, 0, FULL_CIRCLE);
    } else {
      const roots = [...tree.roots()].sort(cmpOrder);
      const totalLeaves = roots.reduce((sum, root) => sum + trunk.leafCountOf(root.id), 0);
      let cursor = 0;
      for (const root of roots) {
        const span = (FULL_CIRCLE * trunk.leafCountOf(root.id)) / totalLeaves;
        claim(root.id, cursor, cursor + span);
        cursor += span;
      }
    }

    const radii = ringRadii(wedges);
    const positions = new Map();
    for (const { id, depth, angle } of wedges) {
      const radius = radii[depth];
      positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    return positions;
  }
}

// Radii inside out. A ring clears the one within it by RING, and is pushed further when its
// closest pair of neighbours would otherwise sit nearer than MIN_ARC: neighbours an angle g
// apart are r·g of arc apart, so r must reach MIN_ARC/g. Measured between NEIGHBOURS rather
// than across wedges on purpose — a one-leaf branch beside a hundred-leaf one owns a sliver of
// the circle but stands well clear of everything, and has no need of a wider ring.
function ringRadii(wedges) {
  const anglesByDepth = new Map();
  let deepest = 0;
  for (const { depth, angle } of wedges) {
    deepest = Math.max(deepest, depth);
    if (!anglesByDepth.has(depth)) anglesByDepth.set(depth, []);
    anglesByDepth.get(depth).push(angle);
  }

  const radii = [0];  // the center sits at the origin, alone
  for (let depth = 1; depth <= deepest; depth++) {
    const gap = tightestGap(anglesByDepth.get(depth) ?? []);
    const needed = gap > 0 ? MIN_ARC / gap : 0;
    radii.push(Math.max(radii[depth - 1] + RING, needed));
  }
  return radii;
}

// The smallest angle between neighbours once the ring is walked all the way round, wrap
// included. A ring holding one node has no neighbours to clear; two nodes at the very same
// angle cannot be parted by any radius, so both cases fall back to the ring's own minimum.
function tightestGap(angles) {
  if (angles.length < 2) return 0;
  const sorted = [...angles].sort((a, b) => a - b);
  let tightest = FULL_CIRCLE - (sorted[sorted.length - 1] - sorted[0]);
  for (let i = 1; i < sorted.length; i++) tightest = Math.min(tightest, sorted[i] - sorted[i - 1]);
  return tightest;
}
