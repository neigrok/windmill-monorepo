// Concentric depth rings, contour-packed. Inside one tree every node sits on the ring for its trunk depth; siblings keep
// cmpOrder along the ring and are packed by Reingold–Tilford contours in angle space, each parent centred over its first
// and last child. A ring's radius is the largest of the pitch past the ring inside it (footprints on neighbouring rings
// can never touch), the circumference its own footprints need, and whatever inflation the packing asked for. A forest is
// islands — the largest tree's crown at the world origin, every other tree laid out around its own crown and packed by
// enclosing circle in size order, never inside another tree's rim — or, in hub mode, one shared centre with the roots on
// a hub ring whose radius is solved by bisection.
import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { footprintOf, footprintRect } from '../model/footprint.js';
import { WORKING_ZOOM } from '../theme.js';

const FULL_CIRCLE = 2 * Math.PI;
const CLOSES = FULL_CIRCLE * (1 + 1e-9); // a ring whose packing needs no more than this closes
const GAP_WU = 12 / WORKING_ZOOM; // clear space between two neighbouring footprints on one ring
const ISLAND_MARGIN_WU = 196 / WORKING_ZOOM; // clear space between two islands' rims
const HUB_MIN_WU = 120 / WORKING_ZOOM;

// Inflation: a probe widens one ring by PROBE to measure the angle it gives back; a joint pass spends that on every ring
// at the same marginal link-length price; a tightening pass bisects each inflated ring back toward the ring rule.
const PROBE = 0.02;
const MAX_PASSES = 12;
const TIGHTEN_STEPS = 20;
const HUB_BISECTION_STEPS = 30;

// Captions are upright, so how much of a ring a footprint takes depends on where on the circle it lands. Each round packs
// with the reach the previous round's angles imply, until no node moves by ANGLE_TOLERANCE. A ring whose footprints
// still touch afterwards is widened by REPAIR_STEP, at most MAX_REPAIRS times.
const MAX_ROUNDS = 6;
const ANGLE_TOLERANCE = (0.1 * Math.PI) / 180;
const REPAIR_STEP = 0.04;
const MAX_REPAIRS = 6;

const ISLAND_ANGLE_SAMPLES = 72;

export class RingsLayoutEngine extends LayoutEngine {
  static reorder = 'none';

  constructor({ multiRoot = 'islands' } = {}) {
    super();
    if (!['islands', 'hub'].includes(multiRoot)) throw new Error(`Unknown multi-root mode "${multiRoot}"`);
    this.multiRoot = multiRoot;
  }

  layout(tree) {
    const footprints = footprintsOf(tree);
    const placed = this.multiRoot === 'hub' ? hubLayout(tree, footprints) : islandsLayout(tree, footprints);
    return new Map(tree.nodes.map((node) => [node.id, placed.get(node.id)]));
  }
}

// The shared-centre variant: every root on one hub ring about the world origin, so siblings sit on rings about the
// origin and the angular reorder gesture applies.
export class HubRingsLayoutEngine extends RingsLayoutEngine {
  static reorder = 'ring';

  constructor() {
    super({ multiRoot: 'hub' });
  }
}

export default RingsLayoutEngine;

// ---- footprints ---------------------------------------------------------------------------------------------------

// Per node: the reserved box relative to the disc centre (captions hang below, so top and bottom are asymmetric) and the
// farthest its corners reach from the centre.
function footprintsOf(tree) {
  return new Map(tree.nodes.map((node) => {
    const footprint = footprintOf(node.label, { root: node.prerequisites.length === 0 });
    const rect = footprintRect(0, 0, footprint);
    const width = rect.maxX - rect.minX;
    const reach = Math.hypot(width / 2, Math.max(-rect.minY, rect.maxY));
    return [node.id, { footprint, width, top: rect.minY, bottom: rect.maxY, reach }];
  }));
}

// The least centre distance at which no footprint of `ids` can overlap one of `insideIds` in any direction: the box
// widths side by side, or the tallest vertical span either way round, whichever the diagonal needs.
function clearanceBetween(insideIds, ids, footprints) {
  if (insideIds.length === 0 || ids.length === 0) return 0;
  const widest = (list) => Math.max(...list.map((id) => footprints.get(id).width));
  const lowest = (list) => Math.max(...list.map((id) => footprints.get(id).bottom));
  const highest = (list) => Math.min(...list.map((id) => footprints.get(id).top));
  const halfWidths = (widest(insideIds) + widest(ids)) / 2;
  const span = Math.max(lowest(insideIds) - highest(ids), lowest(ids) - highest(insideIds));
  return Math.hypot(halfWidths, span);
}

// ---- one ring system --------------------------------------------------------------------------------------------

// The concentric rings about one centre: a tree about its crown, or the whole forest about the hub. Level 0 is the crown
// (empty about a hub), level 1 the top subtrees, and every node keeps its trunk depth as its level.
class RingSystem {
  constructor({ trunk, footprints, crownId, topIds, levelOf }) {
    this.trunk = trunk;
    this.footprints = footprints;
    this.crownId = crownId;
    this.topIds = topIds;
    this.levelOf = new Map();
    this.levels = [crownId === null ? [] : [crownId]];
    const preOrder = [];
    const stack = [...topIds].reverse();
    while (stack.length > 0) {
      const id = stack.pop();
      const level = levelOf(id);
      preOrder.push(id);
      this.levelOf.set(id, level);
      (this.levels[level] ??= []).push(id);
      for (const childId of [...trunk.trunkChildrenOf(id)].reverse()) stack.push(childId);
    }
    this.postOrder = preOrder.reverse();
    this.pitches = this.levels.map((ids, level) => (level === 0 ? 0 : clearanceBetween(this.levels[level - 1], ids, footprints)));
    // trunk links ending on each ring — what a wider ring stretches; roots about a hub hang from nothing
    this.links = this.levels.map((ids, level) => (level === 1 && crownId === null ? 0 : ids.length));
    this.setAngles(null);
  }

  get size() {
    return this.postOrder.length + (this.crownId === null ? 0 : 1);
  }

  // The previous round's angle per node (null before the first round), and the circumference each ring needs under them.
  setAngles(angles) {
    this.angles = angles;
    this.bounds = this.levels.map((ids, level) => (level === 0 ? 0 : ids.reduce((sum, id) => sum + this.reachAlong(id) + GAP_WU, 0) / FULL_CIRCLE));
  }

  // How much of its ring one footprint takes: its width across the top and bottom of the circle, its height at the
  // sides, the diagonal in between; the width alone until an angle is known.
  reachAlong(id) {
    const { width, top, bottom } = this.footprints.get(id);
    if (this.angles === null) return width;
    const angle = this.angles.get(id);
    return Math.min(width / Math.abs(Math.sin(angle)), (bottom - top) / Math.abs(Math.cos(angle)));
  }

  // The angle two neighbours on one ring need between their centres, `laterId` following `earlierId` around the ring:
  // side by side their half widths, one above the other the vertical span in that order, whichever the ring's direction
  // there makes smaller, plus the gap — as a chord of the ring.
  separation(earlierId, laterId, radius) {
    const earlier = this.footprints.get(earlierId);
    const later = this.footprints.get(laterId);
    const halfWidths = (earlier.width + later.width) / 2;
    const distance = () => {
      if (this.angles === null) return halfWidths;
      const from = this.angles.get(earlierId);
      const mid = from + wrap(this.angles.get(laterId) - from) / 2;
      // increasing angle runs clockwise on the y-down canvas: on the right half of the circle the later node is below
      const span = Math.cos(mid) > 0 ? earlier.bottom - later.top : later.bottom - earlier.top;
      return Math.min(halfWidths / Math.abs(Math.sin(mid)), span / Math.abs(Math.cos(mid)));
    };
    return 2 * Math.asin(Math.min(1, (distance() + GAP_WU) / (2 * radius)));
  }

  // r[d] = max(r[d-1] + pitch, the circumference bound, the floor asked for).
  ringRadii(floors) {
    const radii = [0];
    for (let level = 1; level < this.levels.length; level++) {
      radii.push(Math.max(radii[level - 1] + this.pitches[level], this.bounds[level], floors[level] ?? 0));
    }
    return radii;
  }

  // Packs every subtree by contour, deepest first, then the top subtrees around the ring. `needed` is the angle the ring
  // has to give: at every level the extremes must still clear each other across the seam where the circle closes.
  pack(radii) {
    const contours = new Map();
    const childOffsets = new Map();
    for (const id of this.postOrder) {
      const children = this.trunk.trunkChildrenOf(id);
      if (children.length === 0) {
        contours.set(id, leafContour(id));
        continue;
      }
      const { offsets, merged } = this.packSiblings(children.map((childId) => contours.get(childId)), this.levelOf.get(id) + 1, radii);
      const mid = offsets[offsets.length - 1] / 2;
      merged.shift -= mid;
      merged.entries.push({ lo: -merged.shift, hi: -merged.shift, loId: id, hiId: id });
      contours.set(id, merged);
      childOffsets.set(id, offsets.map((offset) => offset - mid));
    }
    if (this.topIds.length === 0) return { childOffsets, offsets: [], extents: [], needed: 0 };
    const extents = this.topIds.map((id) => extentOf(contours.get(id)));
    const { offsets, merged } = this.packSiblings(this.topIds.map((id) => contours.get(id)), 1, radii);
    let needed = 0;
    for (let k = 0; k < merged.entries.length; k++) {
      const entry = merged.entries[merged.entries.length - 1 - k];
      needed = Math.max(needed, entry.hi - entry.lo + this.separation(entry.hiId, entry.loId, radii[1 + k]));
    }
    return { childOffsets, offsets, extents, needed };
  }

  // Places sibling contours left to right on `level`: each is pushed against the merged contour at every level both
  // share, then absorbed into it. Returns the offsets (first at 0) and the merged contour, which reuses the deepest
  // sibling's entries.
  packSiblings(contours, level, radii) {
    let merged = contours[0];
    const offsets = [0];
    for (let i = 1; i < contours.length; i++) {
      const next = contours[i];
      const shared = Math.min(merged.entries.length, next.entries.length);
      let offset = -Infinity;
      for (let k = 0; k < shared; k++) {
        const left = merged.entries[merged.entries.length - 1 - k];
        const right = next.entries[next.entries.length - 1 - k];
        offset = Math.max(offset, left.hi + merged.shift + this.separation(left.hiId, right.loId, radii[level + k]) - right.lo - next.shift);
      }
      offsets.push(offset);
      if (next.entries.length > merged.entries.length) {
        const shift = next.shift + offset;
        for (let k = 0; k < shared; k++) {
          const left = merged.entries[merged.entries.length - 1 - k];
          const right = next.entries[next.entries.length - 1 - k];
          right.lo = left.lo + merged.shift - shift;
          right.loId = left.loId;
        }
        merged = { entries: next.entries, shift };
        continue;
      }
      for (let k = 0; k < shared; k++) {
        const left = merged.entries[merged.entries.length - 1 - k];
        const right = next.entries[next.entries.length - 1 - k];
        left.hi = right.hi + next.shift + offset - merged.shift;
        left.hiId = right.hiId;
      }
    }
    return { offsets, merged };
  }

  // Absolute angle per node: the top subtrees share the spare angle in proportion to their extents, and every child
  // hangs at its packed offset from its parent.
  place({ childOffsets, offsets, extents, needed }) {
    const angles = new Map();
    const slack = Math.max(0, FULL_CIRCLE - needed);
    const totalExtent = extents.reduce((sum, extent) => sum + extent, 0);
    let spent = 0;
    this.topIds.forEach((id, i) => {
      const share = totalExtent > 0 ? extents[i] / totalExtent : 1 / this.topIds.length;
      angles.set(id, offsets[i] + slack * (spent + share / 2));
      spent += share;
    });
    const stack = [...this.topIds];
    while (stack.length > 0) {
      const id = stack.pop();
      const children = this.trunk.trunkChildrenOf(id);
      if (children.length === 0) continue;
      const base = angles.get(id);
      children.forEach((childId, j) => angles.set(childId, base + childOffsets.get(id)[j]));
      stack.push(...children);
    }
    return angles;
  }

  positions(angles, radii) {
    const positions = new Map();
    if (this.crownId !== null) positions.set(this.crownId, { x: 0, y: 0 });
    for (const [id, angle] of angles) {
      const radius = radii[this.levelOf.get(id)];
      positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    return positions;
  }

  // The levels of every pair of footprints that still overlap at these positions.
  touchingLevels(positions) {
    const rects = [...positions].map(([id, { x, y }]) => ({ id, ...footprintRect(x, y, this.footprints.get(id).footprint) })).sort((a, b) => a.minX - b.minX);
    const levels = new Set();
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length && rects[j].minX < rects[i].maxX; j++) {
        if (rects[j].minY >= rects[i].maxY || rects[j].maxY <= rects[i].minY) continue;
        levels.add(this.levelOf.get(rects[i].id) ?? 0);
        levels.add(this.levelOf.get(rects[j].id) ?? 0);
      }
    }
    return [...levels].filter((level) => level > 0).sort((a, b) => a - b);
  }
}

// A contour is one [lo, hi] pair of centre angles per level of a subtree, deepest level first so a parent adds its own
// level with a push; `shift` is added to every stored angle. The ids on each level are what the pair rule reads.
function leafContour(id) {
  return { entries: [{ lo: 0, hi: 0, loId: id, hiId: id }], shift: 0 };
}

function extentOf(contour) {
  return contour.entries.reduce((widest, entry) => Math.max(widest, entry.hi - entry.lo), 0);
}

function wrap(angle) {
  return ((angle % FULL_CIRCLE) + FULL_CIRCLE) % FULL_CIRCLE;
}

function largestShift(previous, next) {
  let largest = 0;
  for (const [id, angle] of next) {
    const turned = wrap(angle - previous.get(id));
    largest = Math.max(largest, Math.min(turned, FULL_CIRCLE - turned));
  }
  return largest;
}

// Lays one ring system out: direction-aware rounds over `solveRadii`, then a repair of any ring whose footprints touch.
function layoutRings(rings, solveRadii) {
  let angles = null;
  let radii = [0];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rings.setAngles(angles);
    radii = solveRadii(rings);
    const next = rings.place(rings.pack(radii));
    const shift = angles === null ? Infinity : largestShift(angles, next);
    angles = next;
    if (shift < ANGLE_TOLERANCE) break;
  }
  rings.setAngles(angles);
  const floors = [...radii];
  for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
    const positions = rings.positions(angles, radii);
    const touching = rings.touchingLevels(positions);
    if (touching.length === 0 || repair === MAX_REPAIRS) return positions;
    for (const level of touching) floors[level] = radii[level] * (1 + REPAIR_STEP);
    radii = rings.ringRadii(floors);
    angles = rings.place(rings.pack(radii));
  }
  return rings.positions(angles, radii);
}

// Islands: the ring rule, then joint inflation passes until the packing closes, then tightening.
function inflatedRadii(rings) {
  const deepest = rings.levels.length - 1;
  const floors = new Array(deepest + 1).fill(0);
  const neededAt = (trial) => rings.pack(rings.ringRadii(trial)).needed;
  let radii = rings.ringRadii(floors);
  let needed = rings.pack(radii).needed;

  for (let pass = 0; pass < MAX_PASSES && needed > CLOSES; pass++) {
    const probes = [];
    for (let level = 1; level <= deepest; level++) {
      const trial = [...floors];
      trial[level] = radii[level] * (1 + PROBE);
      const trialRadii = rings.ringRadii(trial);
      const benefit = needed - rings.pack(trialRadii).needed;
      if (benefit <= 0) continue;
      const cost = trialRadii.reduce((sum, radius, k) => sum + (radius - radii[k]) * rings.links[k], 0);
      probes.push({ level, atoms: benefit / (1 - 1 / (1 + PROBE)), unitCost: Math.max(cost / PROBE, 1e-6) });
    }
    if (probes.length === 0) break;
    const factors = equalPriceFactors(probes, needed - FULL_CIRCLE);
    probes.forEach((probe, i) => { floors[probe.level] = Math.max(floors[probe.level], radii[probe.level] * factors[i]); });
    radii = rings.ringRadii(floors);
    needed = rings.pack(radii).needed;
  }

  // every angle on a ring shrinks at least as fast as 1/r, so scaling every ring by the overflow closes the packing
  if (needed > CLOSES) {
    for (let level = 1; level <= deepest; level++) floors[level] = (radii[level] * needed) / FULL_CIRCLE;
    radii = rings.ringRadii(floors);
  }

  // the per-pass cap can overshoot: bisect every inflated ring back toward the ring rule, inside out then outside in
  const inflated = () => floors.map((floor, level) => (floor > 0 ? level : 0)).filter((level) => level > 0);
  for (const level of [...inflated(), ...inflated().reverse()]) {
    if (floors[level] <= 0) continue;
    const trial = [...floors];
    trial[level] = 0;
    if (neededAt(trial) <= CLOSES) {
      floors[level] = 0;
      continue;
    }
    let low = 0;
    let high = floors[level];
    for (let step = 0; step < TIGHTEN_STEPS; step++) {
      trial[level] = (low + high) / 2;
      if (neededAt(trial) <= CLOSES) high = trial[level]; else low = trial[level];
    }
    floors[level] = high;
  }
  return rings.ringRadii(floors);
}

// Minimises Σ unitCost·(F−1) subject to Σ atoms·(1 − 1/F) ≥ deficit: every ring pays the same marginal price per radian,
// each factor capped at 2 per pass since the rings' benefits do not add up exactly.
function equalPriceFactors(probes, deficit) {
  const factorsAt = (lambda) => probes.map((probe) => Math.min(2, Math.max(1, Math.sqrt((lambda * probe.atoms) / probe.unitCost))));
  const gainAt = (factors) => probes.reduce((sum, probe, i) => sum + probe.atoms * (1 - 1 / factors[i]), 0);
  let low = 0;
  let high = 1;
  while (gainAt(factorsAt(high)) < deficit && high < 1e12) high *= 4;
  for (let step = 0; step < 60; step++) {
    const mid = (low + high) / 2;
    if (gainAt(factorsAt(mid)) >= deficit) high = mid; else low = mid;
  }
  return factorsAt(high);
}

// Hub: the first ring's radius is the one dial, bisected to the smallest value at which the packing closes; the rings
// outside it follow the ring rule.
function hubRadii(rings) {
  if (rings.levels.length < 2) return [0];
  const radiiAt = (hub) => {
    const floors = new Array(rings.levels.length).fill(0);
    floors[1] = hub;
    return rings.ringRadii(floors);
  };
  const closesAt = (hub) => rings.pack(radiiAt(hub)).needed <= CLOSES;
  let low = Math.max(HUB_MIN_WU, rings.pitches[1]);
  if (closesAt(low)) return radiiAt(low);
  let high = low * 2;
  for (let doubling = 0; doubling < 40 && !closesAt(high); doubling++) high *= 2;
  for (let step = 0; step < HUB_BISECTION_STEPS; step++) {
    const mid = (low + high) / 2;
    if (closesAt(mid)) high = mid; else low = mid;
  }
  return radiiAt(high);
}

// ---- the forest ---------------------------------------------------------------------------------------------------

function hubLayout(tree, footprints) {
  const trunk = tree.trunk;
  const crownId = trunk.centerId();
  const rings = crownId === null
    ? new RingSystem({ trunk, footprints, crownId: null, topIds: [...tree.roots()].sort(cmpOrder).map((root) => root.id), levelOf: (id) => trunk.trunkDepthOf(id) + 1 })
    : new RingSystem({ trunk, footprints, crownId, topIds: trunk.trunkChildrenOf(crownId), levelOf: (id) => trunk.trunkDepthOf(id) });
  return layoutRings(rings, hubRadii);
}

function islandsLayout(tree, footprints) {
  const trunk = tree.trunk;
  const islands = tree.roots().map((root) => {
    const rings = new RingSystem({ trunk, footprints, crownId: root.id, topIds: trunk.trunkChildrenOf(root.id), levelOf: (id) => trunk.trunkDepthOf(id) });
    const positions = layoutRings(rings, inflatedRadii);
    const rim = Math.max(...[...positions].map(([id, { x, y }]) => Math.hypot(x, y) + footprints.get(id).reach));
    return { root, size: rings.size, positions, radius: rim + ISLAND_MARGIN_WU / 2 };
  }).sort((a, b) => b.size - a.size || cmpOrder(a.root, b.root));
  const centres = islandCentres(islands.map((island) => island.radius));
  const placed = new Map();
  islands.forEach((island, i) => {
    for (const [id, { x, y }] of island.positions) placed.set(id, { x: centres[i].x + x, y: centres[i].y + y });
  });
  return placed;
}

// Circle packing in the given order: the first circle at the origin, each next one as close to the origin as it fits
// clear of every placed circle, preferring the sides over the top and bottom so the forest lies along the wide axis
// of a landscape canvas.
function islandCentres(radii) {
  const angles = Array.from({ length: ISLAND_ANGLE_SAMPLES }, (_, i) => (i * FULL_CIRCLE) / ISLAND_ANGLE_SAMPLES)
    .sort((a, b) => Math.abs(Math.sin(a)) - Math.abs(Math.sin(b)) || a - b);
  const centres = [];
  radii.forEach((radius, i) => {
    if (i === 0) {
      centres.push({ x: 0, y: 0 });
      return;
    }
    const step = radius / 2;
    for (let distance = radii[0] + radius; ; distance += step) {
      const fit = angles
        .map((angle) => ({ x: distance * Math.cos(angle), y: distance * Math.sin(angle) }))
        .find((centre) => centres.every((placed, j) => Math.hypot(centre.x - placed.x, centre.y - placed.y) >= radii[j] + radius));
      if (fit) {
        centres.push(fit);
        return;
      }
    }
  });
  return centres;
}
