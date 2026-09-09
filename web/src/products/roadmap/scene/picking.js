// The pick rule, pure over the spatial grid and the camera: which step a point on the canvas takes, and when a point
// among steps too crowded to tell apart takes none.
import { NODE_SIZE } from '../theme.js';

const PICK_RADIUS = NODE_SIZE * 0.65;
// Screen-px hit floors in every mode, so a tiny body is still a target; capped at half the gap to the nearest neighbour.
export const POINTER_HIT_PX = 24;
export const TOUCH_HIT_PX = 44;

// The disc itself always takes the hit; beyond it the screen-px floor reaches out, but never past halfway to the
// nearest other node, so a crowded overview never answers a tap with an ambiguous pick — it reports `crowded` instead.
export function hitTest(grid, nodesById, camera, x, y, pointerType) {
  if (!grid) return { id: null, crowded: false };
  const world = camera.screenToWorld(x, y);
  const floorWu = (pointerType === 'touch' ? TOUCH_HIT_PX : POINTER_HIT_PX) / camera.zoom;
  const id = grid.nearest(world.x, world.y, Math.max(PICK_RADIUS, floorWu));
  if (id === null) return { id: null, crowded: false };
  const node = nodesById.get(id);
  const distance = Math.hypot(node.x - world.x, node.y - world.y);
  if (distance <= PICK_RADIUS) return { id, crowded: false };
  const reach = Math.min(floorWu, nearestNeighbourDistance(grid, nodesById, node, floorWu) / 2);
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
