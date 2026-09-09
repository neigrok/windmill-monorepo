// A radial mind map: every branch is a tidy tree (Buchheim/Walker) laid along its own axis, the branches take the twelve
// compass directions by size, and each sits as near the hub as the branches larger than it allow. Captions stay
// horizontal whatever the axis: a node's axis-aligned footprint is projected onto its branch's frame before the tidy pass.

import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { footprintOf, footprintRect } from '../model/footprint.js';
import { BODY_WU, WORKING_ZOOM } from '../theme.js';

const WU_PER_PX = 1 / WORKING_ZOOM;
const SIBLING_GAP = 12 * WU_PER_PX; // between neighbouring footprints along the side axis
const SIBLING_PITCH_MIN = 2 * BODY_WU; // siblings never sit closer than two bodies, centre to centre
const DEPTH_GAP = 32 * WU_PER_PX; // the corridor between one level's outer edge and the next level's inner edge
const BRANCH_GAP = 24 * WU_PER_PX; // between neighbouring branches' footprints, and between a branch and the hub
const RADIUS_STEP = 32; // a branch's distance from the hub moves in these steps, so a small edit leaves it where it is
const SLIDE_STEP = 1024; // the first, coarsest step a branch slides in by; halved down to RADIUS_STEP
const EAST = frameOf(0);
const FULL_CIRCLE = 2 * Math.PI;
// Twelve directions in the order branches take them by size: east, west, south, north, then the diagonals nearest
// the vertical, then those nearest the horizontal.
const DIRECTIONS = [0, 6, 3, 9, 2, 10, 4, 8, 1, 11, 5, 7].map((slot) => (slot * FULL_CIRCLE) / 12);

export default class MindmapLayoutEngine extends LayoutEngine {
  static reorder = 'none';

  layout(tree) {
    const trunk = tree.trunk;
    const footprints = new Map(tree.nodes.map((node) => [
      node.id,
      footprintRect(0, 0, footprintOf(node.label, { root: node.prerequisites.length === 0 })),
    ]));
    const { hubIds, headIds } = hubAndHeads(tree);
    const positions = hubColumn(hubIds, footprints);
    if (headIds.length === 0) return positions;

    const angles = branchAngles(headIds.length);
    const branches = headIds.map((id, rank) => new TidyBranch(id, trunk, footprints, frameOf(angles[rank])));
    const hubBoxes = hubIds.map((id) => reservedBox(EAST, positions.get(id), extentOf(footprints.get(id))));
    const radii = branchRadii(branches, hubBoxes);
    branches.forEach((branch, i) => {
      for (const [id, seat] of branch.seats) positions.set(id, worldPoint(branch.frame, radii[i], seat));
    });
    return positions;
  }
}

// What sits in the hub and what heads a branch round it. A lone root is the hub and its trunk children head the
// branches; among several roots, those without children sit in the hub and the rest head a branch each. Heads are
// ordered largest subtree first; ties keep the roots' own order.
function hubAndHeads(tree) {
  const trunk = tree.trunk;
  const roots = [...tree.roots()].sort(cmpOrder).map((root) => root.id);
  const centre = trunk.centerId();
  const hubIds = centre === null ? roots.filter((id) => trunk.trunkChildrenOf(id).length === 0) : [centre];
  const heads = centre === null ? roots.filter((id) => trunk.trunkChildrenOf(id).length > 0) : trunk.trunkChildrenOf(centre);
  const headIds = heads
    .map((id, index) => ({ id, index, size: subtreeSize(id, trunk) }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .map((head) => head.id);
  return { hubIds, headIds };
}

function subtreeSize(id, trunk) {
  return 1 + trunk.trunkChildrenOf(id).reduce((sum, childId) => sum + subtreeSize(childId, trunk), 0);
}

// The hub's occupants in a column down the origin, one footprint under the other, the span of their discs centred on
// the origin — so a lone occupant sits exactly there.
function hubColumn(hubIds, footprints) {
  const centres = [];
  let y = 0;
  for (const id of hubIds) {
    const rect = footprints.get(id);
    if (centres.length > 0) y += centres[centres.length - 1].rect.maxY + SIBLING_GAP - rect.minY;
    centres.push({ id, rect, y });
  }
  return new Map(centres.map(({ id, y: centre }) => [id, { x: 0, y: centre - y / 2 }]));
}

// Up to twelve branches take the fixed directions by size; more than that share the circle evenly, the largest at
// east and the rest alternating sides so the second largest faces west.
function branchAngles(count) {
  if (count <= DIRECTIONS.length) return DIRECTIONS.slice(0, count);
  const angles = new Array(count);
  let clockwise = 0;
  let counter = count;
  for (let rank = 0; rank < count; rank++) {
    const slot = rank % 2 === 0 ? clockwise++ : --counter;
    angles[rank] = (slot * FULL_CIRCLE) / count;
  }
  return angles;
}

// The frame of a branch whose axis points along `angle` (y down, so a positive angle turns clockwise from east):
// `axis` runs outward through the levels, `side` across the siblings — mirrored to point down, or right on a
// vertical axis, so siblings read top to bottom on both halves and left to right above and below the hub.
function frameOf(angle) {
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const side = { x: -axis.y, y: axis.x };
  const flipped = side.y < -1e-9 || (Math.abs(side.y) <= 1e-9 && side.x < 0);
  return { angle, axis, side: flipped ? { x: -side.x, y: -side.y } : side };
}

// A footprint as an extent in the east frame: what the hub column reserves for a stray.
function extentOf(rect) {
  return { uMin: rect.minX, uMax: rect.maxX, vMin: rect.minY, vMax: rect.maxY };
}

function projectedExtent(rect, frame) {
  const extent = { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity };
  for (const [x, y] of [[rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.minX, rect.maxY], [rect.maxX, rect.maxY]]) {
    const u = x * frame.axis.x + y * frame.axis.y;
    const v = x * frame.side.x + y * frame.side.y;
    extent.uMin = Math.min(extent.uMin, u);
    extent.uMax = Math.max(extent.uMax, u);
    extent.vMin = Math.min(extent.vMin, v);
    extent.vMax = Math.max(extent.vMax, v);
  }
  return extent;
}

function worldPoint(frame, radius, seat) {
  const along = radius + seat.u;
  return { x: along * frame.axis.x + seat.v * frame.side.x, y: along * frame.axis.y + seat.v * frame.side.y };
}

// One branch as a tidy tree in its frame: `u` is the level's distance out from the head, `v` the seat along the side
// axis, the head at (0, 0). Buchheim, Jünger and Leipert's linear-time Walker: a first walk sets each node's
// preliminary seat and the shift its subtree owes, a second walk sums the shifts down the tree. `levels` is the
// branch's silhouette — the extent of each depth's footprints in the frame — which is what the packing reserves.
class TidyBranch {
  constructor(headId, trunk, footprints, frame) {
    this.trunk = trunk;
    this.footprints = footprints;
    this.frame = frame;
    this.records = [];
    this.seats = new Map();
    const head = this.record(headId, null, 0, 0);
    this.firstWalk(head);
    this.secondWalk(head, -head.prelim, this.levelOffsets());
    this.levels = [];
    for (const rec of this.records) {
      const seat = this.seats.get(rec.id);
      const level = this.levels[rec.depth] ?? { uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity };
      level.uMin = Math.min(level.uMin, seat.u + rec.uMin);
      level.uMax = Math.max(level.uMax, seat.u + rec.uMax);
      level.vMin = Math.min(level.vMin, seat.v + rec.vMin);
      level.vMax = Math.max(level.vMax, seat.v + rec.vMax);
      this.levels[rec.depth] = level;
    }
  }

  record(id, parent, depth, index) {
    const rec = {
      id, parent, depth, index, children: [], prelim: 0, mod: 0, shift: 0, change: 0, thread: null, ancestor: null,
      ...projectedExtent(this.footprints.get(id), this.frame),
    };
    rec.ancestor = rec;
    this.records.push(rec);
    this.trunk.trunkChildrenOf(id).forEach((childId, i) => rec.children.push(this.record(childId, rec, depth + 1, i)));
    return rec;
  }

  // The seat separation that keeps the left node's footprint clear of the right one's along the side axis.
  separation(left, right) {
    return Math.max(left.vMax - right.vMin + SIBLING_GAP, SIBLING_PITCH_MIN);
  }

  firstWalk(rec) {
    const leftSibling = rec.index > 0 ? rec.parent.children[rec.index - 1] : null;
    if (rec.children.length === 0) {
      rec.prelim = leftSibling ? leftSibling.prelim + this.separation(leftSibling, rec) : 0;
      return;
    }
    let defaultAncestor = rec.children[0];
    for (const child of rec.children) {
      this.firstWalk(child);
      defaultAncestor = this.apportion(child, defaultAncestor);
    }
    this.executeShifts(rec);
    const midpoint = (rec.children[0].prelim + rec.children[rec.children.length - 1].prelim) / 2;
    if (!leftSibling) {
      rec.prelim = midpoint;
      return;
    }
    rec.prelim = leftSibling.prelim + this.separation(leftSibling, rec);
    rec.mod = rec.prelim - midpoint;
  }

  // Walks the right contour of the left siblings' subtrees against the left contour of this one, level by level,
  // and pushes this subtree right by whatever the contours overlap.
  apportion(rec, defaultAncestor) {
    const leftSibling = rec.index > 0 ? rec.parent.children[rec.index - 1] : null;
    if (!leftSibling) return defaultAncestor;
    let innerRight = rec;
    let outerRight = rec;
    let innerLeft = leftSibling;
    let outerLeft = rec.parent.children[0];
    let modInnerRight = innerRight.mod;
    let modOuterRight = outerRight.mod;
    let modInnerLeft = innerLeft.mod;
    let modOuterLeft = outerLeft.mod;
    while (nextRight(innerLeft) && nextLeft(innerRight)) {
      innerLeft = nextRight(innerLeft);
      innerRight = nextLeft(innerRight);
      outerLeft = nextLeft(outerLeft);
      outerRight = nextRight(outerRight);
      outerRight.ancestor = rec;
      const shift = innerLeft.prelim + modInnerLeft - (innerRight.prelim + modInnerRight) + this.separation(innerLeft, innerRight);
      if (shift > 0) {
        const ancestor = innerLeft.ancestor.parent === rec.parent ? innerLeft.ancestor : defaultAncestor;
        this.moveSubtree(ancestor, rec, shift);
        modInnerRight += shift;
        modOuterRight += shift;
      }
      modInnerLeft += innerLeft.mod;
      modInnerRight += innerRight.mod;
      modOuterLeft += outerLeft.mod;
      modOuterRight += outerRight.mod;
    }
    if (nextRight(innerLeft) && !nextRight(outerRight)) {
      outerRight.thread = nextRight(innerLeft);
      outerRight.mod += modInnerLeft - modOuterRight;
    }
    if (nextLeft(innerRight) && !nextLeft(outerLeft)) {
      outerLeft.thread = nextLeft(innerRight);
      outerLeft.mod += modInnerRight - modOuterLeft;
      return rec;
    }
    return defaultAncestor;
  }

  moveSubtree(left, right, shift) {
    const subtrees = right.index - left.index;
    right.change -= shift / subtrees;
    right.shift += shift;
    left.change += shift / subtrees;
    right.prelim += shift;
    right.mod += shift;
  }

  executeShifts(rec) {
    let shift = 0;
    let change = 0;
    for (let i = rec.children.length - 1; i >= 0; i--) {
      const child = rec.children[i];
      child.prelim += shift;
      child.mod += shift;
      change += child.change;
      shift += child.shift + change;
    }
  }

  // Where each level sits along the axis: clear of the widest footprint on the level before it, plus the corridor.
  levelOffsets() {
    const inner = [];
    const outer = [];
    for (const rec of this.records) {
      inner[rec.depth] = Math.min(inner[rec.depth] ?? Infinity, rec.uMin);
      outer[rec.depth] = Math.max(outer[rec.depth] ?? -Infinity, rec.uMax);
    }
    const offsets = [0];
    for (let depth = 1; depth < inner.length; depth++) {
      offsets.push(offsets[depth - 1] + outer[depth - 1] - inner[depth] + DEPTH_GAP);
    }
    return offsets;
  }

  secondWalk(rec, modSum, levelOffsets) {
    this.seats.set(rec.id, { u: levelOffsets[rec.depth], v: rec.prelim + modSum });
    for (const child of rec.children) this.secondWalk(child, modSum + rec.mod, levelOffsets);
  }
}

function nextLeft(rec) {
  return rec.children.length > 0 ? rec.children[0] : rec.thread;
}

function nextRight(rec) {
  return rec.children.length > 0 ? rec.children[rec.children.length - 1] : rec.thread;
}

// A reserved box: an extent in a frame, half the branch gap wider on every side, with the frame's origin at the world
// point `at`. Two boxes clear each other when one of their four axes separates their corners.
function reservedBox(frame, at, extent) {
  const pad = BRANCH_GAP / 2;
  const corner = (u, v) => ({ x: at.x + u * frame.axis.x + v * frame.side.x, y: at.y + u * frame.axis.y + v * frame.side.y });
  return {
    axes: [frame.axis, frame.side],
    corners: [
      corner(extent.uMin - pad, extent.vMin - pad), corner(extent.uMax + pad, extent.vMin - pad),
      corner(extent.uMin - pad, extent.vMax + pad), corner(extent.uMax + pad, extent.vMax + pad),
    ],
  };
}

function boxesClear(a, b) {
  for (const axis of [...a.axes, ...b.axes]) {
    const spanA = projectionSpan(a.corners, axis);
    const spanB = projectionSpan(b.corners, axis);
    if (spanA.max < spanB.min || spanB.max < spanA.min) return true;
  }
  return false;
}

function projectionSpan(points, axis) {
  const span = { min: Infinity, max: -Infinity };
  for (const point of points) {
    const along = point.x * axis.x + point.y * axis.y;
    span.min = Math.min(span.min, along);
    span.max = Math.max(span.max, along);
  }
  return span;
}

// How far out along its axis each branch's head sits, every branch reserving one box per level of its silhouette.
// All start on one shared ring, the least radius at which every branch clears the hub and each other; then, largest
// first, each slides back in along its own axis for as long as it still clears the hub and every other branch where it
// stands — in halving steps from SLIDE_STEP down to RADIUS_STEP, so a branch never crosses another and every radius
// stays a multiple of RADIUS_STEP — and the pass repeats until no branch moves.
function branchRadii(branches, hubBoxes) {
  const silhouetteAt = (branch, radius) => {
    const head = { x: radius * branch.frame.axis.x, y: radius * branch.frame.axis.y };
    return branch.levels.map((level) => reservedBox(branch.frame, head, level));
  };
  const clear = (boxes, others) => boxes.every((box) => others.every((other) => boxesClear(box, other)));
  const ring = ringRadius((radius) => {
    const all = branches.map((branch) => silhouetteAt(branch, radius));
    return all.every((boxes, i) => clear(boxes, hubBoxes) && all.slice(i + 1).every((other) => clear(boxes, other)));
  });
  const radii = branches.map(() => ring);
  const placed = branches.map((branch) => silhouetteAt(branch, ring));
  let moved = true;
  while (moved) {
    moved = false;
    branches.forEach((branch, i) => {
      for (let step = SLIDE_STEP; step >= RADIUS_STEP; step /= 2) {
        while (radii[i] >= step) {
          const nearer = silhouetteAt(branch, radii[i] - step);
          if (!clear(nearer, hubBoxes) || !placed.every((other, j) => j === i || clear(nearer, other))) break;
          radii[i] -= step;
          placed[i] = nearer;
          moved = true;
        }
      }
    });
  }
  return radii;
}

// The least radius `fits` accepts: doubled until one fits, then bisected, then rounded up to the step.
function ringRadius(fits) {
  if (fits(0)) return 0;
  let low = 0;
  let high = RADIUS_STEP;
  while (!fits(high)) {
    if (high > 1e9) return high;
    low = high;
    high *= 2;
  }
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (fits(middle)) high = middle;
    else low = middle;
  }
  return Math.ceil(high / RADIUS_STEP) * RADIUS_STEP;
}
