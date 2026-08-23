// Pure math for the angular-reorder gesture: the cursor’s angle-from-origin picks the gap a dragged node lands in. `angles` MUST be the siblings in sort order.
import { keyBetween } from '../../sync/fractionalIndex.js';

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

// siblings: same-parent siblings EXCLUDING the dragged node, in sort order, each with its world position and order key. An equal-key run is stepped over (keyBetween throws on a == b), and '' — an unordered node — is an open bound, not a key.
export function reorderPlan(siblings, dropPoint) {
  if (siblings.length === 0) return null;
  const angles = siblings.map((s) => Math.atan2(s.y, s.x));
  const index = circularInsertionIndex(angles, Math.atan2(dropPoint.y, dropPoint.x));

  let left = index > 0 ? siblings[index - 1].order : null;
  let right = index < siblings.length ? siblings[index].order : null;
  if (left && left === right) {
    let after = index;
    while (after < siblings.length && siblings[after].order === left) after++;
    right = after < siblings.length ? siblings[after].order : null;
  }
  const bound = (order) => (order ? order : null);
  return { index, key: keyBetween(bound(left), bound(right)) };
}
