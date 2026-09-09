// A radial mind map: every branch is a tidy tree (Buchheim/Walker) laid along its own axis, and the branches go round
// a hub on one ring, at the least radius where no two of them collide. A root with children is a branch; a lone root
// is the hub itself, at the origin, and its trunk children are the branches; a root without children is a stray and
// sits in the hub, stacked with the other strays. Branches take the twelve directions by size — the largest east, the
// second west, then south, north and the diagonals — so an edit drifts one branch instead of rotating every branch.
// Captions stay horizontal whatever the axis: a node's axis-aligned footprint is projected onto its branch's frame
// before the tidy pass, siblings stack along the frame's side axis, and every level clears the one before it by a
// corridor.

import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { footprintOf, footprintRect } from '../model/footprint.js';
import { BODY_WU, WORKING_ZOOM } from '../theme.js';

const WU_PER_PX = 1 / WORKING_ZOOM;
const SIBLING_GAP = 12 * WU_PER_PX; // between neighbouring footprints along the side axis
const SIBLING_PITCH_MIN = 2 * BODY_WU; // siblings never sit closer than two bodies, centre to centre
const DEPTH_GAP = 32 * WU_PER_PX; // the corridor between one level's outer edge and the next level's inner edge
const BRANCH_GAP = 24 * WU_PER_PX; // between neighbouring branches' footprints, and between a branch and the hub
const HUB_RADIUS_STEP = 32; // the hub radius rounds up to a multiple of this, so a small edit leaves it where it is
const PROFILE_BIN = 40; // radial bin of the angular profile branches are packed by
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
    const { hubIds, branchIds } = hubAndBranches(tree);
    const positions = hubSeats(hubIds, footprints);
    if (branchIds.length === 0) return positions;

    const angles = branchAngles(branchIds.length);
    const branches = branchIds.map((id, i) => new TidyBranch(id, trunk, footprints, frameOf(angles[i])));
    const clearance = hubClearance(hubIds, footprints, positions);
    const hubRadius = hubRadiusFor(branches, footprints, clearance);
    for (const branch of branches) {
      for (const [id, seat] of branch.seats) positions.set(id, worldPoint(branch.frame, hubRadius, seat));
    }
    return positions;
  }
}

// What sits in the hub and what goes round it, the branches largest first; ties keep the roots' own order.
function hubAndBranches(tree) {
  const trunk = tree.trunk;
  const roots = [...tree.roots()].sort(cmpOrder).map((root) => root.id);
  const centre = trunk.centerId();
  const hubIds = centre === null ? roots.filter((id) => trunk.trunkChildrenOf(id).length === 0) : [centre];
  const heads = centre === null ? roots.filter((id) => trunk.trunkChildrenOf(id).length > 0) : trunk.trunkChildrenOf(centre);
  const branchIds = heads
    .map((id, index) => ({ id, index, size: subtreeSize(id, trunk) }))
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .map((branch) => branch.id);
  return { hubIds, branchIds };
}

function subtreeSize(id, trunk) {
  return 1 + trunk.trunkChildrenOf(id).reduce((sum, childId) => sum + subtreeSize(childId, trunk), 0);
}

// The hub's occupants in a column down the origin, one footprint under the other.
function hubSeats(hubIds, footprints) {
  const heights = hubIds.map((id) => footprints.get(id).maxY - footprints.get(id).minY);
  const column = heights.reduce((sum, height) => sum + height, 0) + SIBLING_GAP * Math.max(0, hubIds.length - 1);
  const positions = new Map();
  let top = -column / 2;
  hubIds.forEach((id, i) => {
    positions.set(id, { x: 0, y: top - footprints.get(id).minY });
    top += heights[i] + SIBLING_GAP;
  });
  return positions;
}

// How far from the origin a branch's nearest footprint corner must stay: past every hub occupant, plus the gap.
function hubClearance(hubIds, footprints, positions) {
  let farthest = 0;
  for (const id of hubIds) {
    const rect = footprints.get(id);
    const { x, y } = positions.get(id);
    for (const [cx, cy] of [[rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.minX, rect.maxY], [rect.maxX, rect.maxY]]) {
      farthest = Math.max(farthest, Math.hypot(x + cx, y + cy));
    }
  }
  return hubIds.length === 0 ? 0 : farthest + BRANCH_GAP;
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

function worldPoint(frame, hubRadius, seat) {
  const along = hubRadius + seat.u;
  return { x: along * frame.axis.x + seat.v * frame.side.x, y: along * frame.axis.y + seat.v * frame.side.y };
}

// One branch as a tidy tree in its frame: `u` is the level's distance out from the head, `v` the seat along the side
// axis, the head at (0, 0). Buchheim, Jünger and Leipert's linear-time Walker: a first walk sets each node's
// preliminary seat and the shift its subtree owes, a second walk sums the shifts down the tree.
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

// Where a branch's footprints lie with its head at `hubRadius`: the angles they cover relative to the axis, per
// radial bin from the origin, and the radius of the nearest corner. Two branches can only collide in a bin they share.
function angularProfile(branch, hubRadius, footprints) {
  const profile = { bins: new Map(), nearest: Infinity };
  for (const [id, seat] of branch.seats) {
    const point = worldPoint(branch.frame, hubRadius, seat);
    const rect = footprints.get(id);
    let nearest = Infinity;
    let farthest = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of [[rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.minX, rect.maxY], [rect.maxX, rect.maxY]]) {
      const radius = Math.hypot(point.x + x, point.y + y);
      const angle = Math.atan2(point.y + y, point.x + x) - branch.frame.angle;
      const relative = Math.atan2(Math.sin(angle), Math.cos(angle));
      nearest = Math.min(nearest, radius);
      farthest = Math.max(farthest, radius);
      lo = Math.min(lo, relative);
      hi = Math.max(hi, relative);
    }
    profile.nearest = Math.min(profile.nearest, nearest);
    for (let bin = Math.floor(nearest / PROFILE_BIN); bin <= Math.floor(farthest / PROFILE_BIN); bin++) {
      const span = profile.bins.get(bin) ?? { lo: Infinity, hi: -Infinity };
      span.lo = Math.min(span.lo, lo);
      span.hi = Math.max(span.hi, hi);
      profile.bins.set(bin, span);
    }
  }
  return profile;
}

function collide(placedA, placedB) {
  for (const [bin, spanA] of placedA.profile.bins) {
    const spanB = placedB.profile.bins.get(bin);
    if (!spanB) continue;
    const radius = (bin + 0.5) * PROFILE_BIN;
    const centreA = placedA.angle + (spanA.lo + spanA.hi) / 2;
    const centreB = placedB.angle + (spanB.lo + spanB.hi) / 2;
    const apart = Math.abs(Math.atan2(Math.sin(centreB - centreA), Math.cos(centreB - centreA)));
    if (apart + 1e-7 < (spanA.hi - spanA.lo) / 2 + (spanB.hi - spanB.lo) / 2 + BRANCH_GAP / radius) return true;
  }
  return false;
}

// With the axes fixed: the least hub radius at which every branch clears the hub and no two branches collide in any
// radial bin — doubled until one fits, then bisected — rounded up to the step so a small edit leaves it where it is.
function hubRadiusFor(branches, footprints, clearance) {
  const fits = (hubRadius) => {
    const placed = branches.map((branch) => ({ angle: branch.frame.angle, profile: angularProfile(branch, hubRadius, footprints) }));
    if (placed.some(({ profile }) => profile.nearest < clearance)) return false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) if (collide(placed[i], placed[j])) return false;
    }
    return true;
  };
  if (fits(0)) return 0;
  let low = 0;
  let high = HUB_RADIUS_STEP;
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
  return Math.ceil(high / HUB_RADIUS_STEP) * HUB_RADIUS_STEP;
}
