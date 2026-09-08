import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import {
  NODE_BODY_DIAMETER, WORKING_ZOOM, LABEL_MAX_WIDTH,
  LABEL_LINE_HEIGHT, LABEL_GAP, LABEL_CLEARANCE,
  RADIAL_ROW_SPREAD, RADIAL_ROW_GAP,
} from '../model/geometry.js';

const FULL_CIRCLE = 2 * Math.PI;
const ROW_PITCH = RADIAL_ROW_GAP + RADIAL_ROW_SPREAD;
const GENERATION_PITCH = 320 / WORKING_ZOOM;
const NODE_PITCH = 208 / WORKING_ZOOM;
const SECTOR_GUTTER = 128 / WORKING_ZOOM;
const FOOTPRINT_WIDTH = (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / WORKING_ZOOM;
const FOOTPRINT_HEIGHT = NODE_BODY_DIAMETER + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE) / WORKING_ZOOM;
const ROW_NODE_DISTANCE = Math.max(NODE_PITCH, Math.hypot(FOOTPRINT_WIDTH, FOOTPRINT_HEIGHT));

function variation(id, channel) {
  let hash = 2166136261;
  for (const character of `${id}:${channel}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

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
    const singleSector = majorRoots.length === 1;

    for (let sector = 0; sector < majorRoots.length; sector++) {
      const majorId = majorRoots[sector];
      const phase = variation(majorId, 'bend') * FULL_CIRCLE;
      let band = [majorId];
      let radius = 240 / WORKING_ZOOM;
      let row = 0;

      while (band.length > 0) {
        const node = tree.nodesById.get(band[0]);
        const bodyRadius = NODE_BODY_DIAMETER * (node.prerequisites.length === 0 ? 1.55 : 1) / 2;
        const footprintBottom = bodyRadius + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE / 2) / WORKING_ZOOM;
        const boundaryDistance = Math.hypot(FOOTPRINT_WIDTH / 2, footprintBottom) + SECTOR_GUTTER / 2;
        if (!singleSector) radius = Math.max(radius, boundaryDistance / Math.sin(sectorWidth / 2) + RADIAL_ROW_SPREAD / 2);
        const nextBand = [];

        for (let offset = 0; offset < band.length;) {
          const innerRadius = radius - RADIAL_ROW_SPREAD / 2;
          const minimumAngle = 2 * Math.asin(ROW_NODE_DISTANCE / (2 * innerRadius));
          const margin = singleSector ? 0 : Math.asin(boundaryDistance / innerRadius);
          const usableAngle = sectorWidth - 2 * margin;
          const capacity = singleSector
            ? Math.max(1, Math.floor(FULL_CIRCLE / (minimumAngle * 1.12)))
            : Math.max(1, 1 + Math.floor(usableAngle / (minimumAngle * 1.12)));
          const count = Math.min(capacity, band.length - offset);
          const rowId = band[offset];
          const rowPhase = phase + row * 0.55;
          const bend = Math.sin(rowPhase);
          let angle = sector * sectorWidth + sectorWidth / 2 + bend * Math.min(usableAngle * 0.15, 80 / (WORKING_ZOOM * radius));
          let angleSurplus = 0;
          const weights = [];
          if (count > 1) {
            const gapCount = singleSector ? count : count - 1;
            const minimumSpan = gapCount * minimumAngle;
            const span = singleSector ? FULL_CIRCLE
              : minimumSpan + (usableAngle - minimumSpan) * (0.55 + 0.3 * variation(rowId, 'span'));
            angleSurplus = span - minimumSpan;
            angle = sector * sectorWidth + (singleSector ? minimumAngle / 2 + bend * minimumAngle * 0.2
              : margin + (usableAngle - span) * (0.5 + 0.35 * bend));
            for (let index = 0; index < gapCount; index++) weights.push(0.35 + 1.3 * variation(band[offset + index], 'gap'));
          }
          const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

          for (let index = 0; index < count; index++) {
            const id = band[offset + index];
            const parentId = trunk.primaryParentOf(id) ?? id;
            const wave = Math.sin(rowPhase + index * 1.25 + variation(parentId, 'branch') * 0.6);
            const nodeRadius = radius + (20 * wave + 16 * (variation(id, 'radius') - 0.5)) / WORKING_ZOOM;
            positions.set(id, { x: nodeRadius * Math.cos(angle), y: nodeRadius * Math.sin(angle) });
            nextBand.push(...trunk.trunkChildrenOf(id));
            if (index < count - 1) angle += minimumAngle + angleSurplus * weights[index] / weightTotal;
          }
          offset += count;
          row++;
          if (offset < band.length) radius += ROW_PITCH + 24 * variation(rowId, 'row') / WORKING_ZOOM;
        }
        band = nextBand;
        radius += GENERATION_PITCH + 32 * variation(band[0] ?? majorId, 'generation') / WORKING_ZOOM;
      }
    }
    return positions;
  }
}
