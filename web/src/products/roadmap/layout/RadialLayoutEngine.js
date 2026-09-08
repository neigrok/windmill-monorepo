import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import {
  NODE_BODY_DIAMETER, WORKING_ZOOM, LABEL_MAX_WIDTH,
  LABEL_LINE_HEIGHT, LABEL_GAP, LABEL_CLEARANCE,
} from '../model/geometry.js';

const FULL_CIRCLE = 2 * Math.PI;
const EVENNESS = 0.15;
const STEP = 170 / WORKING_ZOOM;
const CELL = (LABEL_MAX_WIDTH + LABEL_CLEARANCE) / WORKING_ZOOM;

export class RadialLayoutEngine extends LayoutEngine {
  layout(tree) {
    const trunk = tree.trunk;
    const roots = [...tree.roots()].sort(cmpOrder).map(node => node.id);
    const queue = [{ children: roots, start: 0, end: FULL_CIRCLE, radius: -STEP }];
    const footprints = new FootprintGrid();
    const positions = new Map();

    // Breadth-first placement gives parents space before any of their descendants.
    for (let index = 0; index < queue.length; index++) {
      const group = queue[index];
      const totalLeaves = group.children.reduce((sum, id) => sum + trunk.leafCountOf(id), 0);
      let cursor = group.start;
      for (const id of group.children) {
        const share = (1 - EVENNESS) * trunk.leafCountOf(id) / totalLeaves + EVENNESS / group.children.length;
        const end = cursor + (group.end - group.start) * share;
        const node = tree.nodesById.get(id);
        const bodyRadius = NODE_BODY_DIAMETER * (node.prerequisites.length === 0 ? 1.55 : 1) / 2;
        const minimumRadius = Math.max(group.radius + STEP, roots.length > 1 ? STEP : 0);
        const angle = (cursor + end) / 2;
        const radius = footprints.reserve(angle, minimumRadius, bodyRadius);
        positions.set(id, radius === 0 ? { x: 0, y: 0 } : { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
        const children = trunk.trunkChildrenOf(id);
        if (children.length > 0) queue.push({ children, start: cursor, end, radius });
        cursor = end;
      }
    }
    return positions;
  }
}

class FootprintGrid {
  constructor() {
    this.cells = new Map();
  }

  reserve(angle, minimumRadius, bodyRadius) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const halfWidth = CELL / 2;
    const top = bodyRadius + LABEL_CLEARANCE / (2 * WORKING_ZOOM);
    const bottom = bodyRadius + (LABEL_GAP + 2 * LABEL_LINE_HEIGHT + LABEL_CLEARANCE / 2) / WORKING_ZOOM;
    let radius = minimumRadius;
    let bounds;
    for (;;) {
      const x = radius * dx;
      const y = radius * dy;
      bounds = { minX: x - halfWidth, maxX: x + halfWidth, minY: y - top, maxY: y + bottom };
      let nextRadius = radius;
      for (let cellX = Math.floor(bounds.minX / CELL); cellX <= Math.floor(bounds.maxX / CELL); cellX++) {
        for (let cellY = Math.floor(bounds.minY / CELL); cellY <= Math.floor(bounds.maxY / CELL); cellY++) {
          for (const occupied of this.cells.get(`${cellX},${cellY}`) ?? []) {
            if (bounds.maxX <= occupied.minX || bounds.minX >= occupied.maxX || bounds.maxY <= occupied.minY || bounds.minY >= occupied.maxY) continue;
            // Advance only this node to the first exit from each intersecting footprint.
            const exitX = Math.abs(dx) < 1e-10 ? Infinity : (dx > 0 ? occupied.maxX + halfWidth : occupied.minX - halfWidth) / dx;
            const exitY = Math.abs(dy) < 1e-10 ? Infinity : (dy > 0 ? occupied.maxY + top : occupied.minY - bottom) / dy;
            nextRadius = Math.max(nextRadius, Math.min(exitX, exitY) + 0.001);
          }
        }
      }
      if (nextRadius === radius) break;
      radius = nextRadius;
    }
    for (let cellX = Math.floor(bounds.minX / CELL); cellX <= Math.floor(bounds.maxX / CELL); cellX++) {
      for (let cellY = Math.floor(bounds.minY / CELL); cellY <= Math.floor(bounds.maxY / CELL); cellY++) {
        const key = `${cellX},${cellY}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(bounds);
      }
    }
    return radius;
  }
}
