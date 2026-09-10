// Bubble tree over the trunk arborescence: children on rays around each node inside its enclosing circle, in-edge
// side left free, then a post-order tuck sliding each subtree along its ray until footprints or trunk edges touch.
import { LayoutEngine } from '../model/ports.js';
import { cmpOrder } from '../model/TrunkTree.js';
import { footprintOf, footprintRect } from '../model/footprint.js';
import { WORKING_ZOOM } from '../theme.js';

const TWO_PI = 2 * Math.PI;
// The arc kept free on a node's parent side, so its in-edge reaches it between no children.
const IN_EDGE_GAP = Math.PI / 3;
// A root has no in-edge; its children spread around it, but never further apart than this.
const ROOT_SPREAD_CAP = Math.PI / 9;
// Subtree circles are rounded up to this step, so a small change in one caption rarely reaches its ancestors.
const RADIUS_STEP = 24;
// Island circles are rounded up more coarsely still, so an edit inside one rarely reseats the others.
const ISLAND_STEP = RADIUS_STEP * 4;
// The least two footprints, or a footprint and a trunk edge, keep between them after the tuck.
const TUCK_MARGIN = 8 / WORKING_ZOOM;
const GRID_CELL = 256;
const MAX_RECT_CELLS = 64;
// A deterministic cap keeps deep trees responsive; untouched enclosing seats remain collision-free.
const TUCK_WORK_PER_NODE = 2048;
const EPSILON = 1e-9;
// A rect corner that crossed a moving edge within this fraction of the move before it began only grazed it.
const GRAZE = 1e-3;

export class BubbleLayoutEngine extends LayoutEngine {
  static layoutName = 'bubble';
  static reorder = 'parent-arc';
  static readsCaptions = true;

  layout(tree) {
    const forest = new Forest(tree);
    const bubbles = enclosingBubbles(forest);
    const positions = growIslands(forest, bubbles);
    const work = { left: Math.max(1_000_000, forest.size * TUCK_WORK_PER_NODE) };
    const islands = forest.roots.map((root) => tuckIsland(forest, positions, root, work));
    settleIslands(forest, positions, islands);
    return new Map(forest.ids.map((id, node) => [id, { x: positions.x[node], y: positions.y[node] }]));
  }
}

// The trunk arborescence as flat arrays over topological positions, so a parent always precedes its children.
class Forest {
  constructor(tree) {
    const trunk = tree.trunk;
    this.ids = tree.topoOrder();
    this.size = this.ids.length;
    const indexOf = new Map(this.ids.map((id, node) => [id, node]));
    this.parentOf = this.ids.map((id) => (trunk.primaryParentOf(id) === null ? -1 : indexOf.get(trunk.primaryParentOf(id))));
    this.childrenOf = this.ids.map((id) => trunk.trunkChildrenOf(id).map((childId) => indexOf.get(childId)));
    this.shapes = this.ids.map((id, node) => {
      const rect = footprintRect(0, 0, footprintOf(tree.nodesById.get(id).label, { root: this.parentOf[node] === -1 }));
      return { rect, ownRadius: Math.hypot(Math.max(-rect.minX, rect.maxX), Math.max(-rect.minY, rect.maxY)) + TUCK_MARGIN / 2 };
    });
    this.subtreeSize = new Int32Array(this.size).fill(1);
    for (let node = this.size - 1; node > 0; node--) {
      if (this.parentOf[node] !== -1) this.subtreeSize[this.parentOf[node]] += this.subtreeSize[node];
    }
    this.roots = this.ids.map((id, node) => node).filter((node) => this.parentOf[node] === -1);
    this.roots.sort((a, b) => this.subtreeSize[b] - this.subtreeSize[a] || cmpOrder(tree.nodesById.get(this.ids[a]), tree.nodesById.get(this.ids[b])));
  }

  // Post-order over one root's subtree with siblings in trunk order: a subtree is a contiguous run ending at its head.
  postOrderOf(root) {
    const out = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      out.push(node);
      for (const child of this.childrenOf[node]) stack.push(child);
    }
    return out.reverse();
  }
}

// Bottom-up: each node's child ring, each child's ray in its frame (+x away from its own parent), and the circle
// enclosing the subtree — its own circle reaching half the margin past its footprint, so tangent circles keep clear.
function enclosingBubbles(forest) {
  const bubbles = new Array(forest.size);
  for (let node = forest.size - 1; node >= 0; node--) {
    const own = forest.shapes[node].ownRadius;
    const children = forest.childrenOf[node].map((child) => bubbles[child]);
    if (children.length === 0) {
      bubbles[node] = { ring: 0, rays: [], radius: stepUp(own, RADIUS_STEP), cx: 0, cy: 0 };
      continue;
    }
    const isRoot = forest.parentOf[node] === -1;
    const free = isRoot ? TWO_PI : TWO_PI - IN_EDGE_GAP;
    const ring = ringRadius(own, children, free);
    const rays = fanRays(ring, children, free, isRoot ? ROOT_SPREAD_CAP : 0);
    const circles = children.map((child, i) => circleOnRay(ring, rays[i], child));
    const enclosing = smallestCircleAround([{ x: 0, y: 0, r: own }, ...circles]);
    bubbles[node] = { ring, rays, radius: stepUp(enclosing.r, RADIUS_STEP), cx: enclosing.x, cy: enclosing.y };
  }
  return bubbles;
}

function stepUp(radius, step) {
  return Math.ceil(radius / step) * step;
}

// The shortest ring on which every child's circle clears the node's own circle and, seen from the node, all their
// arcs fit inside the free angle.
function ringRadius(own, children, free) {
  let ring = 0;
  for (const child of children) ring = Math.max(ring, Math.sqrt(Math.max(0, (own + child.radius) ** 2 - child.cy ** 2)) - child.cx);
  const arcsFit = (d) => children.reduce((sum, child) => sum + arcOf(d, child), 0) <= free;
  if (arcsFit(ring)) return ring;
  let lo = ring;
  let hi = ring;
  for (let i = 0; i < 64 && !arcsFit(hi); i++) hi *= 2;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (arcsFit(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// The angle a child's circle covers, seen from the node, when the child sits `ring` out along its ray.
function arcOf(ring, child) {
  return 2 * Math.asin(Math.min(1, child.radius / Math.hypot(ring + child.cx, child.cy)));
}

// Consecutive arcs packed edge to edge and centred on +x — a root's spread apart by the slack, up to the cap. A
// child's ray aims at the child itself; its circle's centre may sit beside the ray, so the arc is centred on that.
function fanRays(ring, children, free, spreadCap) {
  const arcs = children.map((child) => arcOf(ring, child));
  const total = arcs.reduce((sum, arc) => sum + arc, 0);
  const spread = children.length > 1 ? Math.min(spreadCap, (free - total) / (children.length - 1)) : 0;
  let cursor = -(total + spread * (children.length - 1)) / 2;
  return children.map((child, i) => {
    const arcCentre = cursor + arcs[i] / 2;
    cursor += arcs[i] + spread;
    return arcCentre - Math.atan2(child.cy, ring + child.cx);
  });
}

// A child's subtree circle in its parent's frame: the child `ring` out along `angle`, facing along it.
function circleOnRay(ring, angle, child) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  return { x: (ring + child.cx) * ux - child.cy * uy, y: (ring + child.cx) * uy + child.cy * ux, r: child.radius };
}

// Top-down: every root at its island's origin facing +x; a child leaves its parent along the parent's heading plus
// its ray and faces along that, so its own in-edge points straight back at the parent.
function growIslands(forest, bubbles) {
  const x = new Float64Array(forest.size);
  const y = new Float64Array(forest.size);
  const heading = new Float64Array(forest.size);
  for (let node = 0; node < forest.size; node++) {
    const { ring, rays } = bubbles[node];
    forest.childrenOf[node].forEach((child, i) => {
      const angle = heading[node] + rays[i];
      x[child] = x[node] + ring * Math.cos(angle);
      y[child] = y[node] + ring * Math.sin(angle);
      heading[child] = angle;
    });
  }
  return { x, y };
}

// Post-order over one island: each subtree, its children already tucked, slides toward its parent as far as the
// resting footprints and trunk edges allow. Returns the post-order and the circle around it, in the island's frame.
function tuckIsland(forest, positions, root, work) {
  const order = forest.postOrderOf(root);
  const rank = new Int32Array(forest.size);
  order.forEach((node, i) => { rank[node] = i; });
  const resting = new RestingSet(forest, positions);
  for (const node of order) resting.rest(node);

  for (const head of order) {
    if (work.left < 0) break;
    if (head === root) continue;
    const parent = forest.parentOf[head];
    const vx = positions.x[parent] - positions.x[head];
    const vy = positions.y[parent] - positions.y[head];
    if (Math.hypot(vx, vy) < EPSILON) continue;
    const last = rank[head];
    const first = last - forest.subtreeSize[head] + 1;
    const sliding = (node) => rank[node] >= first && rank[node] <= last;
    const t = resting.room(order, first, last, vx, vy, sliding, work);
    if (t <= 0) continue;
    for (let i = first; i <= last; i++) resting.lift(order[i]);
    for (let i = first; i <= last; i++) {
      positions.x[order[i]] += t * vx;
      positions.y[order[i]] += t * vy;
    }
    for (let i = first; i <= last; i++) resting.rest(order[i]);
  }

  const corners = order.flatMap((node) => {
    const { minX, maxX, minY, maxY } = resting.footprintOf(node);
    return [{ x: minX, y: minY, r: 0 }, { x: maxX, y: minY, r: 0 }, { x: minX, y: maxY, r: 0 }, { x: maxX, y: maxY, r: 0 }];
  });
  const circle = smallestCircleAround(corners);
  return { order, x: circle.x, y: circle.y, r: stepUp(circle.r + TUCK_MARGIN, ISLAND_STEP) };
}

// Islands in size order: the largest root at the world origin; every other keeps the direction the circle packing
// seats it in and slides along it until its footprints or trunk edges meet what is already resting.
function settleIslands(forest, positions, islands) {
  if (islands.length === 0) return; // an empty tree: the birth placeholder, not a picture
  const circles = islands.map(({ x, y, r }) => ({ x, y, r }));
  packCircles(circles);
  const islandOf = new Int32Array(forest.size);
  islands.forEach((island, i) => island.order.forEach((node) => { islandOf[node] = i; }));
  const resting = new RestingSet(forest, positions);
  const anchor = islands[0];
  let reach = anchor.r;
  islands.forEach((island, i) => {
    if (i > 0) {
      const seat = Math.hypot(circles[i].x, circles[i].y);
      const ux = circles[i].x / seat;
      const uy = circles[i].y / seat;
      const start = reach + island.r;
      const vx = -ux * start;
      const vy = -uy * start;
      for (const node of island.order) {
        positions.x[node] += anchor.x + ux * start - island.x;
        positions.y[node] += anchor.y + uy * start - island.y;
      }
      const t = resting.room(island.order, 0, island.order.length - 1, vx, vy, (node) => islandOf[node] === i);
      for (const node of island.order) {
        positions.x[node] += t * vx;
        positions.y[node] += t * vy;
      }
      reach = Math.max(reach, start * (1 - t) + island.r);
    }
    for (const node of island.order) resting.rest(node);
  });
}

// The footprints and trunk edges already at rest, and how far a set of nodes may slide before coming within the
// margin of one — a trunk edge riding along between two sliding nodes included.
class RestingSet {
  constructor(forest, positions) {
    this.forest = forest;
    this.positions = positions;
    this.footprints = new RectGrid(forest.size);
    this.edges = new RectGrid(forest.size);
  }

  footprintOf(node) {
    const { rect } = this.forest.shapes[node];
    const x = this.positions.x[node];
    const y = this.positions.y[node];
    return { minX: x + rect.minX, maxX: x + rect.maxX, minY: y + rect.minY, maxY: y + rect.maxY };
  }

  edgeOf(node) {
    const parent = this.forest.parentOf[node];
    return { px: this.positions.x[parent], py: this.positions.y[parent], qx: this.positions.x[node], qy: this.positions.y[node] };
  }

  rest(node) {
    this.footprints.insert(node, this.footprintOf(node));
    if (this.forest.parentOf[node] !== -1) this.edges.insert(node, boxOf(this.edgeOf(node)));
  }

  lift(node) {
    this.footprints.remove(node);
    if (this.forest.parentOf[node] !== -1) this.edges.remove(node);
  }

  // The fraction of the move (vx, vy) that nodes[first..last] can take together, marching a cell at a time and asking
  // the grids a margin wider than each sweep, so a contact at the margin is never missed across a cell boundary.
  room(nodes, first, last, vx, vy, sliding, work = null) {
    const length = Math.hypot(vx, vy);
    const ux = vx / length;
    const uy = vy / length;
    for (let travelled = 0; travelled < length; travelled += GRID_CELL) {
      const step = Math.min(GRID_CELL, length - travelled);
      let fraction = 1;
      for (let i = first; i <= last; i++) {
        if (work !== null && --work.left < 0) return 0;
        const node = nodes[i];
        const footprint = shift(this.footprintOf(node), travelled * ux, travelled * uy);
        const swept = expand(sweep(footprint, step * ux, step * uy), TUCK_MARGIN);
        for (const other of this.footprints.within(swept, work)) {
          if (!sliding(other)) fraction = Math.min(fraction, footprintStop(footprint, step * ux, step * uy, this.footprintOf(other)));
        }
        for (const other of this.edges.within(swept, work)) {
          if (!sliding(other)) fraction = Math.min(fraction, edgeStop(this.edgeOf(other), -step * ux, -step * uy, footprint));
        }
        const parent = this.forest.parentOf[node];
        if (parent === -1 || !sliding(parent)) continue;
        const edge = shiftEdge(this.edgeOf(node), travelled * ux, travelled * uy);
        for (const other of this.footprints.within(expand(sweep(boxOf(edge), step * ux, step * uy), TUCK_MARGIN), work)) {
          if (!sliding(other)) fraction = Math.min(fraction, edgeStop(edge, step * ux, step * uy, this.footprintOf(other)));
        }
      }
      if (work !== null && work.left < 0) return 0;
      if (fraction < 1) return (travelled + fraction * step) / length;
    }
    return 1;
  }
}

// Circles in the given order: the first at the origin, each next tangent to two on the front chain, at the seat
// nearest the origin (Wang, Wang, Dai & Wang 2006, the way d3 packs siblings). Depends on the radii alone.
function packCircles(circles) {
  if (circles.length === 0) return;
  circles[0].x = 0;
  circles[0].y = 0;
  if (circles.length === 1) return;
  circles[1].x = circles[0].r + circles[1].r;
  circles[1].y = 0;
  if (circles.length === 2) return;
  placeTangent(circles[1], circles[0], circles[2]);
  let a = { circle: circles[0] };
  let b = { circle: circles[1] };
  let c = { circle: circles[2] };
  a.next = c.previous = b;
  b.next = a.previous = c;
  c.next = b.previous = a;

  for (let i = 3; i < circles.length; ) {
    placeTangent(a.circle, b.circle, circles[i]);
    c = { circle: circles[i] };
    let j = b.next;
    let k = a.previous;
    let sj = b.circle.r;
    let sk = a.circle.r;
    let collided = false;
    do {
      if (sj <= sk) {
        if (intersects(j.circle, c.circle)) {
          b = j;
          a.next = b;
          b.previous = a;
          collided = true;
          break;
        }
        sj += j.circle.r;
        j = j.next;
      } else {
        if (intersects(k.circle, c.circle)) {
          a = k;
          a.next = b;
          b.previous = a;
          collided = true;
          break;
        }
        sk += k.circle.r;
        k = k.previous;
      }
    } while (j !== k.next);
    if (collided) continue;

    c.previous = a;
    c.next = b;
    a.next = b.previous = b = c;
    let best = seatDistance(a);
    while ((c = c.next) !== b) {
      const distance = seatDistance(c);
      if (distance < best) {
        a = c;
        best = distance;
      }
    }
    b = a.next;
    i++;
  }
}

// Puts c tangent to both b and a, on the outer side of the chain running from a to b.
function placeTangent(b, a, c) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 === 0) {
    c.x = a.x + c.r;
    c.y = a.y;
    return;
  }
  const a2 = (a.r + c.r) ** 2;
  const b2 = (b.r + c.r) ** 2;
  if (a2 > b2) {
    const x = (d2 + b2 - a2) / (2 * d2);
    const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
    c.x = b.x - x * dx - y * dy;
    c.y = b.y - x * dy + y * dx;
    return;
  }
  const x = (d2 + a2 - b2) / (2 * d2);
  const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
  c.x = a.x + x * dx - y * dy;
  c.y = a.y + x * dy + y * dx;
}

function intersects(a, b) {
  const reach = a.r + b.r - 1e-6;
  return reach > 0 && reach * reach > (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

// How far from the origin the seat between a chain link and its next one lies.
function seatDistance(link) {
  const a = link.circle;
  const b = link.next.circle;
  const dx = (a.x * b.r + b.x * a.r) / (a.r + b.r);
  const dy = (a.y * b.r + b.y * a.r) / (a.r + b.r);
  return dx * dx + dy * dy;
}

// The smallest circle enclosing a set of discs, exact: grow a basis of at most three discs by the one currently
// furthest outside, re-solving the basis each round (bounded; the last resort widens the circle to reach it).
function smallestCircleAround(discs) {
  let basis = [discs[0]];
  let circle = { x: discs[0].x, y: discs[0].y, r: discs[0].r };
  for (let round = 0; round < 64 + discs.length; round++) {
    let outermost = null;
    let outBy = EPSILON * (1 + circle.r);
    for (const disc of discs) {
      const by = Math.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r - circle.r;
      if (by > outBy) {
        outermost = disc;
        outBy = by;
      }
    }
    if (outermost === null) return circle;
    const improved = smallestBasis([...basis, outermost]);
    if (improved === null) break;
    basis = improved.basis;
    circle = improved.circle;
  }
  let r = 0;
  for (const disc of discs) r = Math.max(r, Math.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r);
  return { x: circle.x, y: circle.y, r };
}

// Among every one-, two- and three-disc subset of at most four discs, the smallest circle enclosing all of them.
function smallestBasis(discs) {
  let best = null;
  const consider = (basis) => {
    const circle = basis.length === 1 ? circleOfDisc(basis[0]) : basis.length === 2 ? circleOfTwoDiscs(basis[0], basis[1]) : circleOfThreeDiscs(basis[0], basis[1], basis[2]);
    if (circle === null || !discs.every((disc) => encloses(circle, disc))) return;
    if (best === null || circle.r < best.circle.r) best = { basis, circle };
  };
  for (let i = 0; i < discs.length; i++) {
    consider([discs[i]]);
    for (let j = i + 1; j < discs.length; j++) {
      consider([discs[i], discs[j]]);
      for (let k = j + 1; k < discs.length; k++) consider([discs[i], discs[j], discs[k]]);
    }
  }
  return best;
}

function encloses(circle, disc) {
  return Math.hypot(disc.x - circle.x, disc.y - circle.y) + disc.r <= circle.r + EPSILON * (1 + circle.r);
}

function circleOfDisc(a) {
  return { x: a.x, y: a.y, r: a.r };
}

function circleOfTwoDiscs(a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance + b.r <= a.r + EPSILON) return circleOfDisc(a);
  if (distance + a.r <= b.r + EPSILON) return circleOfDisc(b);
  const r = (distance + a.r + b.r) / 2;
  const k = (r - a.r) / distance;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, r };
}

// The circle tangent to three discs from outside: its centre is affine in its radius, which a quadratic then fixes.
function circleOfThreeDiscs(a, b, c) {
  const m00 = 2 * (a.x - b.x);
  const m01 = 2 * (a.y - b.y);
  const m10 = 2 * (a.x - c.x);
  const m11 = 2 * (a.y - c.y);
  const det = m00 * m11 - m01 * m10;
  if (Math.abs(det) < 1e-12) return null;
  const kab = (a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y) - (a.r * a.r - b.r * b.r);
  const kac = (a.x * a.x + a.y * a.y - c.x * c.x - c.y * c.y) - (a.r * a.r - c.r * c.r);
  const vab = 2 * (a.r - b.r);
  const vac = 2 * (a.r - c.r);
  const ax = (m11 * kab - m01 * kac) / det;
  const ay = (-m10 * kab + m00 * kac) / det;
  const bx = (m11 * vab - m01 * vac) / det;
  const by = (-m10 * vab + m00 * vac) / det;
  const wx = ax - a.x;
  const wy = ay - a.y;
  const qa = bx * bx + by * by - 1;
  const qb = 2 * (wx * bx + wy * by + a.r);
  const qc = wx * wx + wy * wy - a.r * a.r;
  const roots = [];
  if (Math.abs(qa) < 1e-12) {
    if (Math.abs(qb) > 1e-12) roots.push(-qc / qb);
  } else if (qb * qb - 4 * qa * qc >= 0) {
    const s = Math.sqrt(qb * qb - 4 * qa * qc);
    roots.push((-qb - s) / (2 * qa), (-qb + s) / (2 * qa));
  }
  let best = null;
  for (const r of roots) {
    if (!(r >= Math.max(a.r, b.r, c.r) - EPSILON)) continue;
    const circle = { x: ax + r * bx, y: ay + r * by, r };
    if (![a, b, c].every((disc) => encloses(circle, disc))) continue;
    if (best === null || circle.r < best.r) best = circle;
  }
  return best;
}

// The fraction of the move (vx, vy) the moving footprint can take before coming within the margin of the still one;
// a pair already inside each other's margin stops at their bare rims instead; 1 when they never meet.
function footprintStop(moving, vx, vy, still) {
  const margined = entryTime(moving, vx, vy, expand(still, TUCK_MARGIN));
  if (margined === null) return 1;
  if (!margined.alreadyInside) return margined.t;
  return entryTime(moving, vx, vy, still)?.t ?? 1;
}

// The fraction of the move (ux, uy) the trunk edge can take before coming within the margin of the still footprint;
// an edge already inside the margin stops at the bare rim; a crossing that already exists never blocks.
function edgeStop(edge, ux, uy, still) {
  if (segmentHitsRect(edge, expand(still, TUCK_MARGIN))) {
    if (segmentHitsRect(edge, still)) return 1;
    return segmentEntryTime(edge, ux, uy, still) ?? 1;
  }
  return segmentEntryTime(edge, ux, uy, expand(still, TUCK_MARGIN)) ?? 1;
}

// The fraction of the move (vx, vy) at which rect `a` first strictly overlaps the static rect `b`, and whether it
// already does; null when it never will within the move.
function entryTime(a, vx, vy, b) {
  let enter = -Infinity;
  let exit = Infinity;
  if (vx === 0) {
    if (a.maxX <= b.minX || a.minX >= b.maxX) return null;
  } else {
    enter = Math.min((b.minX - a.maxX) / vx, (b.maxX - a.minX) / vx);
    exit = Math.max((b.minX - a.maxX) / vx, (b.maxX - a.minX) / vx);
  }
  if (vy === 0) {
    if (a.maxY <= b.minY || a.minY >= b.maxY) return null;
  } else {
    enter = Math.max(enter, Math.min((b.minY - a.maxY) / vy, (b.maxY - a.minY) / vy));
    exit = Math.min(exit, Math.max((b.minY - a.maxY) / vy, (b.maxY - a.minY) / vy));
  }
  if (enter >= exit || exit <= 0 || enter >= 1) return null;
  return { t: Math.max(enter, 0), alreadyInside: enter < -EPSILON };
}

// The fraction of the move (ux, uy) at which the segment first enters the rect's interior — an endpoint entering or a
// corner crossing it (a graze stops it at once); null when it never does. Assumes no crossing before the move.
function segmentEntryTime({ px, py, qx, qy }, ux, uy, rect) {
  let first = Infinity;
  const p = entryTime({ minX: px, maxX: px, minY: py, maxY: py }, ux, uy, rect);
  if (p !== null) first = p.t;
  const q = entryTime({ minX: qx, maxX: qx, minY: qy, maxY: qy }, ux, uy, rect);
  if (q !== null) first = Math.min(first, q.t);
  const dx = qx - px;
  const dy = qy - py;
  const det = ux * dy - dx * uy;
  if (Math.abs(det) > 1e-12) {
    for (let corner = 0; corner < 4; corner++) {
      const wx = (corner & 1 ? rect.maxX : rect.minX) - px;
      const wy = (corner & 2 ? rect.maxY : rect.minY) - py;
      const t = (wx * dy - dx * wy) / det;
      const s = (ux * wy - uy * wx) / det;
      if (s >= 0 && s <= 1 && t >= -GRAZE && t <= 1) first = Math.min(first, Math.max(t, 0));
    }
  }
  return first === Infinity ? null : first;
}

// Liang–Barsky: does the segment pass through the rect's interior?
function segmentHitsRect({ px, py, qx, qy }, rect) {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    if (p < 0) t0 = Math.max(t0, q / p);
    else t1 = Math.min(t1, q / p);
    return t0 <= t1;
  };
  return clip(-dx, px - rect.minX) && clip(dx, rect.maxX - px) && clip(-dy, py - rect.minY) && clip(dy, rect.maxY - py) && t1 - t0 > 1e-6;
}

function boxOf({ px, py, qx, qy }) {
  return { minX: Math.min(px, qx), maxX: Math.max(px, qx), minY: Math.min(py, qy), maxY: Math.max(py, qy) };
}

function shift(rect, dx, dy) {
  return { minX: rect.minX + dx, maxX: rect.maxX + dx, minY: rect.minY + dy, maxY: rect.maxY + dy };
}

function shiftEdge({ px, py, qx, qy }, dx, dy) {
  return { px: px + dx, py: py + dy, qx: qx + dx, qy: qy + dy };
}

function sweep(rect, vx, vy) {
  return {
    minX: Math.min(rect.minX, rect.minX + vx),
    maxX: Math.max(rect.maxX, rect.maxX + vx),
    minY: Math.min(rect.minY, rect.minY + vy),
    maxY: Math.max(rect.maxY, rect.maxY + vy),
  };
}

function expand(rect, by) {
  return { minX: rect.minX - by, maxX: rect.maxX + by, minY: rect.minY - by, maxY: rect.maxY + by };
}

// Small rectangles use grid cells; wide rectangles and wide queries scan occupied entries.
class RectGrid {
  constructor(capacity) {
    this.cells = new Map();
    this.rects = new Map();
    this.wide = new Set();
    this.found = [];
    this.seen = new Int32Array(capacity);
    this.stamp = 0;
  }

  insert(node, rect) {
    this.rects.set(node, rect);
    const columns = Math.floor(rect.maxX / GRID_CELL) - Math.floor(rect.minX / GRID_CELL) + 1;
    const rows = Math.floor(rect.maxY / GRID_CELL) - Math.floor(rect.minY / GRID_CELL) + 1;
    if (columns * rows > MAX_RECT_CELLS) {
      this.wide.add(node);
      return;
    }
    for (let i = Math.floor(rect.minX / GRID_CELL); i <= Math.floor(rect.maxX / GRID_CELL); i++) {
      for (let j = Math.floor(rect.minY / GRID_CELL); j <= Math.floor(rect.maxY / GRID_CELL); j++) {
        const bucket = this.cells.get(cellKey(i, j));
        if (bucket === undefined) this.cells.set(cellKey(i, j), [node]);
        else bucket.push(node);
      }
    }
  }

  remove(node) {
    const rect = this.rects.get(node);
    this.rects.delete(node);
    if (this.wide.delete(node)) return;
    for (let i = Math.floor(rect.minX / GRID_CELL); i <= Math.floor(rect.maxX / GRID_CELL); i++) {
      for (let j = Math.floor(rect.minY / GRID_CELL); j <= Math.floor(rect.maxY / GRID_CELL); j++) {
        const bucket = this.cells.get(cellKey(i, j));
        bucket[bucket.indexOf(node)] = bucket[bucket.length - 1];
        bucket.pop();
        if (bucket.length === 0) this.cells.delete(cellKey(i, j));
      }
    }
  }

  within(rect, work = null) {
    this.stamp += 1;
    this.found.length = 0;
    const columns = Math.floor(rect.maxX / GRID_CELL) - Math.floor(rect.minX / GRID_CELL) + 1;
    const rows = Math.floor(rect.maxY / GRID_CELL) - Math.floor(rect.minY / GRID_CELL) + 1;
    if (columns * rows > this.rects.size) {
      for (const [node, bounds] of this.rects) {
        if (work !== null && --work.left < 0) return this.found;
        if (rectsTouch(rect, bounds)) this.found.push(node);
      }
      return this.found;
    }
    if (work !== null) {
      work.left -= columns * rows;
      if (work.left < 0) return this.found;
    }
    for (let i = Math.floor(rect.minX / GRID_CELL); i <= Math.floor(rect.maxX / GRID_CELL); i++) {
      for (let j = Math.floor(rect.minY / GRID_CELL); j <= Math.floor(rect.maxY / GRID_CELL); j++) {
        for (const node of this.cells.get(cellKey(i, j)) ?? []) {
          if (work !== null && --work.left < 0) return this.found;
          if (this.seen[node] === this.stamp) continue;
          this.seen[node] = this.stamp;
          this.found.push(node);
        }
      }
    }
    for (const node of this.wide) {
      if (work !== null && --work.left < 0) return this.found;
      if (rectsTouch(rect, this.rects.get(node))) this.found.push(node);
    }
    return this.found;
  }
}

function rectsTouch(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function cellKey(i, j) {
  return (i + 0x8000) * 0x10000 + (j + 0x8000);
}

export default BubbleLayoutEngine;
