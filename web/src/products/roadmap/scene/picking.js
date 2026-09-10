// The pick rule, pure over the spatial grid and the camera: which step a point on the canvas takes, and when a point
// among steps too crowded to tell apart takes none.
import { NODE_SIZE, BODY_WU, ROOT_BODY_SCALE, SELECTED_SCALE, MIN_BODY_PX, MIN_ROOT_BODY_PX } from '../theme.js';

const PICK_RADIUS = NODE_SIZE * 0.65;
// Screen-px hit floors in every mode, so a tiny body is still a target; capped at half the gap to the nearest neighbour.
export const POINTER_HIT_PX = 24;
export const TOUCH_HIT_PX = 44;

// The disc itself always takes the hit; beyond it the screen-px floor reaches out, but never past halfway to the
// nearest other node, so a crowded overview never answers a tap with an ambiguous pick — it reports `crowded` instead.
export function hitTest(grid, nodesById, camera, x, y, pointerType, selectedId = null) {
  if (!grid) return { id: null, crowded: false };
  const world = camera.screenToWorld(x, y);
  const floorWu = (pointerType === 'touch' ? TOUCH_HIT_PX : POINTER_HIT_PX) / camera.zoom;
  const largestBodyRadius = Math.max(BODY_WU * (ROOT_BODY_SCALE + SELECTED_SCALE - 1) / 2, MIN_ROOT_BODY_PX / (2 * camera.zoom));
  let bodyId = null;
  let bodyDistance = Infinity;
  for (const id of grid.within(world.x - largestBodyRadius, world.y - largestBodyRadius, world.x + largestBodyRadius, world.y + largestBodyRadius)) {
    const node = nodesById.get(id);
    const scale = 1 + (node.emphasis > 0 ? ROOT_BODY_SCALE - 1 : 0) + (id === selectedId ? SELECTED_SCALE - 1 : 0);
    const radius = Math.max(BODY_WU * scale / 2, (node.emphasis > 0 ? MIN_ROOT_BODY_PX : MIN_BODY_PX) / (2 * camera.zoom));
    const distance = Math.hypot(node.x - world.x, node.y - world.y);
    if (distance > radius || distance > bodyDistance) continue;
    bodyId = id;
    bodyDistance = distance;
  }
  if (bodyId !== null) return { id: bodyId, crowded: false };

  const targetRadius = Math.max(PICK_RADIUS, floorWu);
  const id = grid.nearest(world.x, world.y, targetRadius);
  if (id === null) return { id: null, crowded: false };
  const node = nodesById.get(id);
  const distance = Math.hypot(node.x - world.x, node.y - world.y);
  const reach = Math.min(targetRadius, nearestNeighbourDistance(grid, nodesById, node, targetRadius * 2) / 2);
  if (distance <= reach) return { id, crowded: false };
  return { id: null, crowded: true };
}

// Distance to the closest other node within `radius`, else `Infinity`.
export function nearestNeighbourDistance(grid, nodesById, node, radius) {
  let closest = Infinity;
  for (const otherId of grid.within(node.x - radius, node.y - radius, node.x + radius, node.y + radius)) {
    if (otherId === node.id) continue;
    const other = nodesById.get(otherId);
    closest = Math.min(closest, Math.hypot(other.x - node.x, other.y - node.y));
  }
  return closest;
}
