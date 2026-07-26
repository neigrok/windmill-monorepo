// The math behind the angular-reorder gesture (editing spec v2 §07), kept pure so it can be
// unit-tested without a scene. Every node sits on the depth-ring centred at the world origin, and
// a parent's siblings occupy an arc of that ring in their sort (== sweep) order. To reslot a node
// you arc it along its ring; the cursor's angle-from-origin picks the gap it lands in.
//
// The seam anchors the frame at the wrap gap between the sort-order last and first sibling — where
// the linear order breaks. For a partial wedge that gap is the empty rest-of-circle, so a drop
// before the first sibling reads as index 0 and after the last as index m; for a full root ring it
// falls just before the first root. Insertion counts the siblings the drop has swept past the seam.
// `angles` MUST be the siblings in sort order (the same order keyBetween's neighbours come from).
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

// siblings: the dragged node's same-parent siblings EXCLUDING itself, in sort order, each carrying
// its world position and order key. dropPoint is the cursor in world space. Returns the slot index
// and the fractional key to assign.
//
// Two neighbour keys must be a strictly ordered, valid pair for keyBetween. Two guards make that so:
//   • An equal REAL run (a concurrent-create collision — two siblings share a key) is stepped over,
//     so the node lands just past the run rather than splitting it (keyBetween would throw on a==b).
//   • An un-ordered neighbour ('' — the lattice default for migrated / MCP / doc-seeded nodes, which
//     sort by creation time) is not a real fractional key; keyBetween rejects it. Treat '' (and null)
//     as an OPEN bound. The minted key sorts after the whole empty run (empties sort first by
//     cmpOrder), which reads correctly at the empty/keyed boundary.
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
  const bound = (order) => (order ? order : null); // '' and null are both open bounds
  return { index, key: keyBetween(bound(left), bound(right)) };
}
