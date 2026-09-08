// Same-parent reorder follows authored order across ordered radial rows; angles within one row follow that order.
import { keyBetween } from '../../sync/fractionalIndex.js';
import { RADIAL_ROW_SPREAD, RADIAL_ROW_GAP } from '../../model/geometry.js';

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

export function circularInsertionIndex(angles, dropAngle) {
  const m = angles.length;
  if (m === 0) return 0;
  const wrapGap = m === 1 ? TAU : norm(angles[0] - angles[m - 1]);
  const seam = norm(angles[m - 1] + wrapGap / 2);
  const dropFromSeam = norm(dropAngle - seam);
  let index = 0;
  for (let i = 0; i < m; i++) if (norm(angles[i] - seam) < dropFromSeam) index++;
  return index;
}

export function reorderSlot(siblings, dropPoint) {
  if (siblings.length === 0) return null;
  const rows = [];
  for (let index = 0; index < siblings.length; index += 1) {
    const sibling = siblings[index];
    const radius = Math.hypot(sibling.x, sibling.y);
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.radius - radius) < (RADIAL_ROW_SPREAD + RADIAL_ROW_GAP) / 2) {
      last.radius = (last.radius * last.nodes.length + radius) / (last.nodes.length + 1);
      last.nodes.push(sibling);
    } else rows.push({ radius, start: index, nodes: [sibling] });
  }
  const dropRadius = Math.hypot(dropPoint.x, dropPoint.y);
  const row = rows.reduce((nearest, candidate) => Math.abs(candidate.radius - dropRadius) < Math.abs(nearest.radius - dropRadius) ? candidate : nearest);
  const angles = row.nodes.map((node) => Math.atan2(node.y, node.x));
  const slot = circularInsertionIndex(angles, Math.atan2(dropPoint.y, dropPoint.x));
  const firstGap = angles.length > 1 ? Math.min(0.3, norm(angles[1] - angles[0]) / 2) : 0.3;
  const lastGap = angles.length > 1 ? Math.min(0.3, norm(angles.at(-1) - angles.at(-2)) / 2) : 0.3;
  const angle = slot === 0 ? angles[0] - firstGap : slot === angles.length ? angles.at(-1) + lastGap
    : angles[slot - 1] + norm(angles[slot] - angles[slot - 1]) / 2;
  const left = row.nodes[Math.max(0, slot - 1)];
  const right = row.nodes[Math.min(slot, row.nodes.length - 1)];
  const radius = (Math.hypot(left.x, left.y) + Math.hypot(right.x, right.y)) / 2;
  return { index: row.start + slot, radius, angle, x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

export function reorderPlan(siblings, dropPoint) {
  const slot = reorderSlot(siblings, dropPoint);
  if (!slot) return null;
  let left = slot.index > 0 ? siblings[slot.index - 1].order : null;
  let right = slot.index < siblings.length ? siblings[slot.index].order : null;
  if (left && left === right) {
    let after = slot.index;
    while (after < siblings.length && siblings[after].order === left) after++;
    right = after < siblings.length ? siblings[after].order : null;
  }
  return { ...slot, key: keyBetween(left || null, right || null) };
}
