// Radial tidy tree over the trunk arborescence: each node sits on the ring for
// its trunk depth, at the center of an angular wedge; wedges split among trunk
// children proportional to subtree leaf counts. Synchronous — no worker, no dagre.
import { LayoutEngine } from '../model/ports.js';
import { NODE_SIZE } from '../theme.js';

const RING = NODE_SIZE * 2.8;
const FULL_CIRCLE = 2 * Math.PI;

export class RadialLayoutEngine extends LayoutEngine {
  layout(tree) {
    const trunk = tree.trunk;
    // a synthetic center (multi-root) pushes the real roots out to the first ring
    const depthOffset = trunk.centerId() !== null ? 0 : 1;
    const positions = new Map();

    const place = (id, angleStart, angleEnd) => {
      const angle = (angleStart + angleEnd) / 2;
      const radius = (trunk.trunkDepthOf(id) + depthOffset) * RING;
      positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });

      const children = trunk.trunkChildrenOf(id);
      if (children.length === 0) return;

      const totalLeaves = children.reduce((sum, childId) => sum + trunk.leafCountOf(childId), 0);
      let cursor = angleStart;
      for (const childId of children) {
        const span = ((angleEnd - angleStart) * trunk.leafCountOf(childId)) / totalLeaves;
        place(childId, cursor, cursor + span);
        cursor += span;
      }
    };

    const centerId = trunk.centerId();
    if (centerId !== null) {
      place(centerId, 0, FULL_CIRCLE);
      return positions;
    }

    const roots = [...tree.roots()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const totalLeaves = roots.reduce((sum, root) => sum + trunk.leafCountOf(root.id), 0);
    let cursor = 0;
    for (const root of roots) {
      const span = (FULL_CIRCLE * trunk.leafCountOf(root.id)) / totalLeaves;
      place(root.id, cursor, cursor + span);
      cursor += span;
    }
    return positions;
  }
}
