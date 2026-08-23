// Radial tidy tree over the trunk arborescence: each node sits on the ring for its trunk depth, at the centre of an angular wedge; wedges split among trunk children proportional to subtree leaf counts.
import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { NODE_SIZE } from '../theme.js';

const RING = NODE_SIZE * 2.8; // the least the first ring clears the center
const MIN_ARC = NODE_SIZE * 1.7; // center to center
const FULL_CIRCLE = 2 * Math.PI;

// How much of a child's slice comes from an equal share rather than from its leaf count.
const EVENNESS = 0.15;

// Fraction each ring past the first widens its clearance by, per depth.
const RING_GROWTH = 0.05;

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
        const span = (angleEnd - angleStart) * shareOf(trunk.leafCountOf(childId), totalLeaves, children.length);
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
        const span = FULL_CIRCLE * shareOf(trunk.leafCountOf(root.id), totalLeaves, roots.length);
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

// Shares sum to one, so the wedge is always fully spent.
function shareOf(leaves, totalLeaves, siblings) {
  return (1 - EVENNESS) * (leaves / totalLeaves) + EVENNESS * (1 / siblings);
}

// Radii inside out: a ring clears the one within it by RING, and is pushed further when neighbours an angle g apart need MIN_ARC of arc between them.
function ringRadii(wedges) {
  const anglesByDepth = new Map();
  let deepest = 0;
  for (const { depth, angle } of wedges) {
    deepest = Math.max(deepest, depth);
    if (!anglesByDepth.has(depth)) anglesByDepth.set(depth, []);
    anglesByDepth.get(depth).push(angle);
  }

  const radii = [0];
  for (let depth = 1; depth <= deepest; depth++) {
    const gap = tightestGap(anglesByDepth.get(depth) ?? []);
    const needed = gap > 0 ? MIN_ARC / gap : 0;
    const clearance = RING * (1 + RING_GROWTH * (depth - 1));
    radii.push(Math.max(radii[depth - 1] + clearance, needed));
  }
  return radii;
}

// Smallest angle between neighbours around the ring, wrap included; 0 when no radius can part them.
function tightestGap(angles) {
  if (angles.length < 2) return 0;
  const sorted = [...angles].sort((a, b) => a - b);
  let tightest = FULL_CIRCLE - (sorted[sorted.length - 1] - sorted[0]);
  for (let i = 1; i < sorted.length; i++) tightest = Math.min(tightest, sorted[i] - sorted[i - 1]);
  return tightest;
}
