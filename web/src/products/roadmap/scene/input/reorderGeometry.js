// Pure math for the angular-reorder gesture: siblings sweep an arc about a centre — the world origin under a ring
// layout, their parent's seat under a bubble — and the cursor's angle about that centre picks the gap the dragged
// node lands in. `angles` and `siblings` MUST be the siblings in sort order.
import { keyBetween } from '../../sync/fractionalIndex.js';

const TAU = Math.PI * 2;
const ORIGIN = { x: 0, y: 0 };
// The end slots of a closed ring holding a single sibling, which has no gap of its own to halve.
const LONE_SLOT = 0.3;
// How far past an open fan's end seat a drop still reads as that end; further round is off the fan.
const END_SLACK = Math.PI / 8;

const norm = (a) => ((a % TAU) + TAU) % TAU;
// A seat on the arc: `radius` out from the centre at that angle.
export function seatOn(centre, radius, angle) {
  return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
}

// How many siblings the drop has swept past, counting from the seam the order starts at.
function indexFromSeam(angles, dropAngle, seam) {
  const dropFromSeam = norm(dropAngle - seam);
  let index = 0;
  for (const angle of angles) if (norm(angle - seam) < dropFromSeam) index++;
  return index;
}

export function circularInsertionIndex(angles, dropAngle) {
  if (angles.length === 0) return 0;
  return indexFromSeam(angles, dropAngle, closedRing(angles).seam);
}

// The siblings close the circle: every angle drops into a gap, and an end slot borrows half the wrap gap.
function closedRing(angles) {
  const m = angles.length;
  const wrapGap = m === 1 ? TAU : norm(angles[0] - angles[m - 1]);
  const seam = norm(angles[m - 1] + wrapGap / 2);
  return { seam, middle: seam + Math.PI, halfWidth: Math.PI, slack: m === 1 ? LONE_SLOT : wrapGap / 2 };
}

// The siblings and the dragged node's own seat sweep an open fan, its order starting at the seam behind it. The fan
// takes the near side of the wrap gap when the dragged node sat at an end, and an end slot sits a step further out.
function openFan(angles, homeAngle) {
  const span = norm(angles[angles.length - 1] - angles[0]);
  const home = norm(homeAngle - angles[0]);
  let head = 0;
  let tail = span;
  if (home > span) {
    if (home - span <= TAU - home) tail = home;
    else head = home - TAU;
  }
  const halfWidth = (tail - head) / 2;
  const middle = angles[0] + (head + tail) / 2;
  return { seam: middle + Math.PI, middle, halfWidth, slack: Math.min(END_SLACK, Math.PI - halfWidth) };
}

// The middle of the gap the node drops into; at an end of the arc the slot sits `slack` past the last seat.
function slotAngle(angles, index, slack) {
  const m = angles.length;
  if (index === 0) return norm(angles[0] - slack);
  if (index === m) return norm(angles[m - 1] + slack);
  return norm(angles[index - 1] + norm(angles[index] - angles[index - 1]) / 2);
}

// siblings: same-parent siblings EXCLUDING the dragged node, in sort order, each with its world position and order
// key. An equal-key run is stepped over (keyBetween throws on a == b), and '' — an unordered node — is an open
// bound, not a key. `centre` is what the siblings sweep around: the world origin under a ring layout, the parent's
// seat under a bubble. `homeAngle` — the dragged node's own seat about that centre — opens the fan: a drop more
// than a step past either end belongs to no gap, so the plan is null and the drag writes nothing. Left out, the
// siblings close the circle and every angle drops into a gap.
export function reorderPlan(siblings, dropPoint, { centre = ORIGIN, homeAngle = null } = {}) {
  if (siblings.length === 0) return null;
  const angles = siblings.map((s) => Math.atan2(s.y - centre.y, s.x - centre.x));
  const dropAngle = Math.atan2(dropPoint.y - centre.y, dropPoint.x - centre.x);
  const arc = homeAngle === null ? closedRing(angles) : openFan(angles, homeAngle);
  const fromMiddle = norm(dropAngle - arc.middle);
  const distance = Math.min(fromMiddle, TAU - fromMiddle);
  if (distance > arc.halfWidth + arc.slack) return null;

  let index = indexFromSeam(angles, dropAngle, arc.seam);
  while (index < siblings.length) {
    const order = siblings[index].order;
    if (order && (index === 0 || order !== siblings[index - 1].order)) break;
    index++;
  }
  const left = index > 0 ? siblings[index - 1].order : null;
  const right = index < siblings.length ? siblings[index].order : null;
  return { index, slotAngle: slotAngle(angles, index, arc.slack), key: keyBetween(left || null, right || null) };
}
