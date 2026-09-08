import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import {
  NODE_BODY_DIAMETER, WORKING_ZOOM, LABEL_MAX_WIDTH,
  LABEL_LINE_HEIGHT, LABEL_GAP, LABEL_CLEARANCE,
} from '../model/geometry.js';

const FULL_CIRCLE = 2 * Math.PI;
const ROW_PITCH = 240 / WORKING_ZOOM;
const GENERATION_GAP = 320 / WORKING_ZOOM;
const NODE_PITCH = 208 / WORKING_ZOOM;
const SECTOR_GUTTER = 128 / WORKING_ZOOM;
const FOOTPRINT_WIDTH = (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / WORKING_ZOOM;
const FOOTPRINT_HEIGHT = NODE_BODY_DIAMETER + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE) / WORKING_ZOOM;
const ROW_NODE_DISTANCE = Math.max(NODE_PITCH, Math.hypot(FOOTPRINT_WIDTH, FOOTPRINT_HEIGHT));

export class RadialLayoutEngine extends LayoutEngine {
  layout(tree) {
    const trunk = tree.trunk;
    const roots = [...tree.roots()].sort(cmpOrder).map(node => node.id);
    const positions = new Map();
    if (roots.length === 0) return positions;

    const centerId = roots.length === 1 ? roots[0] : null;
    if (centerId !== null) positions.set(centerId, { x: 0, y: 0 });
    const majorRoots = centerId === null ? roots : trunk.trunkChildrenOf(centerId);
    const sectorWidth = FULL_CIRCLE / majorRoots.length;

    for (let sector = 0; sector < majorRoots.length; sector++) {
      let band = [majorRoots[sector]];
      let radius = ROW_PITCH;

      while (band.length > 0) {
        const node = tree.nodesById.get(band[0]);
        const bodyRadius = NODE_BODY_DIAMETER * (node.prerequisites.length === 0 ? 1.55 : 1) / 2;
        const footprintBottom = bodyRadius + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE / 2) / WORKING_ZOOM;
        const boundaryDistance = Math.hypot(FOOTPRINT_WIDTH / 2, footprintBottom) + SECTOR_GUTTER / 2;
        if (majorRoots.length > 1) radius = Math.max(radius, boundaryDistance / Math.sin(sectorWidth / 2));
        const nextBand = [];

        for (let offset = 0; offset < band.length;) {
          const minimumAngle = 2 * Math.asin(ROW_NODE_DISTANCE / (2 * radius));
          const margin = majorRoots.length === 1 ? 0 : Math.asin(boundaryDistance / radius);
          const usableAngle = sectorWidth - 2 * margin;
          const capacity = majorRoots.length === 1
            ? Math.max(1, Math.floor(FULL_CIRCLE / minimumAngle))
            : Math.max(1, 1 + Math.floor(usableAngle / minimumAngle));
          const count = Math.min(capacity, band.length - offset);
          let startAngle = sector * sectorWidth + sectorWidth / 2;
          let angleStep = 0;
          if (count > 1) {
            angleStep = majorRoots.length === 1 ? FULL_CIRCLE / count : usableAngle / (count - 1);
            startAngle = sector * sectorWidth + (majorRoots.length === 1 ? angleStep / 2 : margin);
          }

          for (let index = 0; index < count; index++) {
            const id = band[offset + index];
            const angle = startAngle + index * angleStep;
            positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
            nextBand.push(...trunk.trunkChildrenOf(id));
          }
          offset += count;
          if (offset < band.length) radius += ROW_PITCH;
        }
        band = nextBand;
        radius += GENERATION_GAP;
      }
    }
    return positions;
  }
}
