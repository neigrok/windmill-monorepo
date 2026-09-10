// Captions, decided: which nodes get a fixed 14 px name, where it sits and when it appears. Pure — no DOM, screen px
// throughout; LabelOverlay measures the text and moves elements to the rectangles this file returns.
import { NODE_SIZE, BODY_FRACTION, ROOT_BODY_SCALE, MIN_BODY_PX, MIN_ROOT_BODY_PX, SELECTED_SCALE, CAPTION } from '../theme.js';
import { BEND_REACH, bendOf, controlPoint, pointOnCurve } from './edgeCurve.js';

export const CAPTION_POOL = 96; // the most captions on screen at once — also the DOM pool
export const WORKING_BODY_PX = 18; // drawn body from which every node may be named
export const FRONTIER_BODY_PX = 12; // drawn body from which the frontier is named beside the landmarks
export const SHOW_AFTER_MS = 200; // continuous eligibility before a caption appears
export const HIDE_AFTER_MS = 200; // continuous ineligibility before a shown caption goes
export const BRANCH_HEAD_MIN_SUBTREE = 8;

const TEXT_WIDTH = CAPTION.maxWidthPx - CAPTION.padPx * 2; // the text column inside the 168 px box
const RIM_FRACTION = BODY_FRACTION / 2;
const CANDIDATE_LIMIT = CAPTION_POOL * 3;
const COLLISION_GAP = 2;
const CELL_PX = 64;
const REACH_PX = 200; // a node this far past the canvas edge can still own a caption on it
const RIBBON_STEP_PX = 16; // the longest sampled crossing near a caption
const RIBBON_STEPS_MAX = 96;
const RIBBON_HALF_PX = 3; // half the drawn ribbon, plus its halo

export const RANK_SELECTED = 0;
export const RANK_HOVERED = 1;
export const RANK_FAMILY = 2; // the selected node's trunk parent and trunk children
export const RANK_ANCHOR = 3; // crowned roots and branch heads
export const RANK_FRONTIER = 4; // available
export const RANK_REST = 5;

// What a seat may not touch. A caption keeps clear of all three; one that cannot goes on a branch rather than unsaid;
// a landmark below the working view may cross the dots and threads, but never another name.
const OBSTACLE_NAME = 0; // a placed caption, or chrome holding a corner
const OBSTACLE_DISC = 1;
const OBSTACLE_RIBBON = 2;

export const ANCHOR_BELOW = 0;
export const ANCHOR_ABOVE = 1;
export const ANCHOR_RIGHT = 2;
export const ANCHOR_LEFT = 3;
const ANCHOR_COUNT = 4;

// ---- wrapping ----------------------------------------------------------

// Up to two lines of the text column, broken at a space, the second line ellipsised. `measure`
// is the text width in px under the caption font. A blank label has no caption: null.
export function wrapCaption(label, measure) {
  const source = String(label ?? '').trim().replace(/\s+/gu, ' ');
  if (source === '') return null;
  const whole = measure(source);
  if (whole <= TEXT_WIDTH) return { lines: [source], width: whole, height: CAPTION.linePx };
  const first = firstLine(source, measure);
  const rest = source.slice(first.length).trimStart();
  const second = measure(rest) <= TEXT_WIDTH ? rest : `${widestPrefix(rest, measure, '…')}…`;
  return { lines: [first, second], width: Math.max(measure(first), measure(second)), height: CAPTION.linePx * 2 };
}

// The longest run of whole words that fits; a first word wider than the column is cut between code points.
function firstLine(text, measure) {
  let line = '';
  for (const word of text.split(' ')) {
    const longer = line === '' ? word : `${line} ${word}`;
    if (measure(longer) > TEXT_WIDTH) break;
    line = longer;
  }
  if (line !== '') return line;
  return widestPrefix(text.split(' ')[0], measure, '');
}

// The most code points of `text` that, followed by `tail`, still fit the column; at least one.
function widestPrefix(text, measure, tail) {
  const points = Array.from(text);
  let low = 1;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(points.slice(0, mid).join('').trimEnd() + tail) > TEXT_WIDTH) high = mid - 1;
    else low = mid;
  }
  return points.slice(0, low).join('').trimEnd();
}

// ---- tiers -------------------------------------------------------------

// The last rank named at this zoom, keyed on the body as DRAWN — never below the floor the shader keeps — so the rule
// follows the dot on screen: the landmarks always, the frontier from 12 px, everyone from 18 px. Monotone in zoom.
export function captionRankLimit(zoom) {
  const bodyPx = Math.max(NODE_SIZE * BODY_FRACTION * zoom, MIN_BODY_PX);
  if (bodyPx < FRONTIER_BODY_PX) return RANK_ANCHOR;
  if (bodyPx < WORKING_BODY_PX) return RANK_FRONTIER;
  return RANK_REST;
}

// ---- geometry ----------------------------------------------------------

function anchorRect(candidate, boxWidth, boxHeight, anchor) {
  const { sx, sy, rim } = candidate;
  if (anchor === ANCHOR_BELOW) return { left: sx - boxWidth / 2, top: sy + rim + CAPTION.gapPx, right: sx + boxWidth / 2, bottom: sy + rim + CAPTION.gapPx + boxHeight };
  if (anchor === ANCHOR_ABOVE) return { left: sx - boxWidth / 2, top: sy - rim - CAPTION.gapPx - boxHeight, right: sx + boxWidth / 2, bottom: sy - rim - CAPTION.gapPx };
  if (anchor === ANCHOR_RIGHT) return { left: sx + rim + CAPTION.gapPx, top: sy - boxHeight / 2, right: sx + rim + CAPTION.gapPx + boxWidth, bottom: sy + boxHeight / 2 };
  return { left: sx - rim - CAPTION.gapPx - boxWidth, top: sy - boxHeight / 2, right: sx - rim - CAPTION.gapPx, bottom: sy + boxHeight / 2 };
}

function inside(rect, area) {
  return rect.left >= area.left && rect.right <= area.right && rect.top >= area.top && rect.bottom <= area.bottom;
}

// A corner-anchored chrome box (`ui/viewport.js` blocks) against the live viewport.
function blockRect(block, view) {
  const left = block.left ?? view.viewportWidth - block.right - block.width;
  const top = block.top ?? view.viewportHeight - block.bottom - block.height;
  return { left, top, right: left + block.width, bottom: top + block.height };
}

// Rectangles bucketed by 64 px cell, so a collision test touches only the cells a rectangle covers.
class CollisionGrid {
  constructor() {
    this.cells = new Map();
    this.ribbons = [];
  }

  insert(rect, kind) {
    rect.kind = kind;
    const lastX = Math.floor((rect.right + COLLISION_GAP) / CELL_PX);
    const lastY = Math.floor((rect.bottom + COLLISION_GAP) / CELL_PX);
    for (let cellX = Math.floor((rect.left - COLLISION_GAP) / CELL_PX); cellX <= lastX; cellX += 1) {
      for (let cellY = Math.floor((rect.top - COLLISION_GAP) / CELL_PX); cellY <= lastY; cellY += 1) {
        const key = (cellX + 32768) * 65536 + (cellY + 32768);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(rect);
        else this.cells.set(key, [rect]);
      }
    }
  }

  // Whether `rect` touches anything of kind `upTo` or lower; the kinds above it are the ones this pass may cross.
  collides(rect, upTo) {
    const lastX = Math.floor((rect.right + COLLISION_GAP) / CELL_PX);
    const lastY = Math.floor((rect.bottom + COLLISION_GAP) / CELL_PX);
    for (let cellX = Math.floor((rect.left - COLLISION_GAP) / CELL_PX); cellX <= lastX; cellX += 1) {
      for (let cellY = Math.floor((rect.top - COLLISION_GAP) / CELL_PX); cellY <= lastY; cellY += 1) {
        const bucket = this.cells.get((cellX + 32768) * 65536 + (cellY + 32768));
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.kind > upTo) continue;
          if (rect.left < other.right + COLLISION_GAP && rect.right > other.left - COLLISION_GAP
            && rect.top < other.bottom + COLLISION_GAP && rect.bottom > other.top - COLLISION_GAP) return true;
        }
      }
    }
    if (upTo < OBSTACLE_RIBBON) return false;
    for (const ribbon of this.ribbons) {
      const { fx, fy, tx, ty, cx, cy, length } = ribbon;
      const crossing = chordRange(fx, fy, tx, ty, rect, BEND_REACH * length + RIBBON_HALF_PX + COLLISION_GAP);
      if (crossing === null) continue;
      const [lo, hi] = crossing;
      const steps = Math.min(RIBBON_STEPS_MAX, Math.max(1, Math.ceil(((hi - lo) * length) / RIBBON_STEP_PX)));
      let previous = pointOnCurve(fx, fy, cx, cy, tx, ty, lo);
      for (let step = 1; step <= steps; step += 1) {
        const point = pointOnCurve(fx, fy, cx, cy, tx, ty, lo + ((hi - lo) * step) / steps);
        if (chordRange(previous.x, previous.y, point.x, point.y, rect, RIBBON_HALF_PX + COLLISION_GAP) !== null) return true;
        previous = point;
      }
    }
    return false;
  }
}

// ---- the placer --------------------------------------------------------

// Priority first — among the anchors the biggest subtree first, so a crown outranks a lone step — then a caption already
// on screen, then nearness to the viewport centre, then id: two passes over the same picture agree.
function byPriority(a, b) {
  return a.rank - b.rank || b.weight - a.weight || a.newcomer - b.newcomer || a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// The trunk edges form a forest; every node's size counts itself and its trunk descendants.
function trunkSubtreeSizes(nodes, parentById, childrenById) {
  const order = [];
  const stack = nodes.filter((node) => !parentById.has(node.id)).map((node) => node.id);
  while (stack.length > 0) {
    const id = stack.pop();
    order.push(id);
    for (const child of childrenById.get(id)) stack.push(child);
  }
  const sizes = new Map();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    let size = 1;
    for (const child of childrenById.get(order[i])) size += sizes.get(child);
    sizes.set(order[i], size);
  }
  return sizes;
}

// The model index, the metrics, the selection context and each caption's record — `{ phase, since, anchor, pass }`:
// pending, shown, or leaving. `place(view, now)` is the one decision, deterministic for the same inputs and clock.
export class CaptionPlacer {
  constructor() {
    this.nodesById = new Map();
    this.edges = [];
    this.spatialGrid = null;
    this.trunkParentById = new Map();
    this.trunkChildrenById = new Map();
    this.anchorIds = new Set();
    this.subtreeSizeById = new Map();
    this.metricById = new Map();
    this.stateById = new Map();
    this.selectedId = null;
    this.hoveredId = null;
    this.familyIds = new Set();
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.blocks = [];
    this.records = new Map();
    this.pass = 0;
  }

  // Records survive a re-installed model, so a live edit never blinks every caption.
  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.edges = renderModel.edges;
    this.spatialGrid = spatialGrid;
    this.stateById = new Map(renderModel.nodes.map((node) => [node.id, node.state]));
    this.trunkParentById = new Map();
    this.trunkChildrenById = new Map(renderModel.nodes.map((node) => [node.id, []]));
    for (const edge of renderModel.edges) {
      if (edge.kind !== 'trunk') continue;
      this.trunkParentById.set(edge.to, edge.from);
      this.trunkChildrenById.get(edge.from).push(edge.to);
    }
    this.subtreeSizeById = trunkSubtreeSizes(renderModel.nodes, this.trunkParentById, this.trunkChildrenById);
    this.anchorIds = new Set(renderModel.nodes
      .filter((node) => node.emphasis > 0 || (node.branch === node.id && this.subtreeSizeById.get(node.id) >= BRANCH_HEAD_MIN_SUBTREE))
      .map((node) => node.id));
    for (const id of this.records.keys()) if (!this.nodesById.has(id)) this.records.delete(id);
    this.setContext({ selectedId: this.selectedId, hoveredId: this.hoveredId });
  }

  setMetrics(metricById) {
    this.metricById = metricById;
  }

  setStates(statesMap) {
    for (const [id, state] of statesMap) this.stateById.set(id, state);
  }

  setContext({ selectedId = null, hoveredId = null }) {
    this.selectedId = this.nodesById.has(selectedId) ? selectedId : null;
    this.hoveredId = this.nodesById.has(hoveredId) ? hoveredId : null;
    this.familyIds = new Set();
    if (this.selectedId === null) return;
    const parent = this.trunkParentById.get(this.selectedId);
    if (parent !== undefined) this.familyIds.add(parent);
    for (const child of this.trunkChildrenById.get(this.selectedId)) this.familyIds.add(child);
  }

  // `blocks` are the corners chrome holds (the minimap, the legend); the sides it covers are the insets.
  setInsets({ top = 0, right = 0, bottom = 0, left = 0, blocks = [] }) {
    this.insets = { top, right, bottom, left };
    this.blocks = blocks;
  }

  rankOf(id) {
    if (id === this.selectedId) return RANK_SELECTED;
    if (id === this.hoveredId) return RANK_HOVERED;
    if (this.familyIds.has(id)) return RANK_FAMILY;
    if (this.anchorIds.has(id)) return RANK_ANCHOR;
    const state = this.stateById.get(id);
    if (state === 'available') return RANK_FRONTIER;
    return RANK_REST;
  }

  // `view` is the camera: x, y, zoom, viewportWidth, viewportHeight. Returns the captions to draw in priority order,
  // each `{ id, anchor, left, top, width, height, lines, shown }`, and when the next one changes — null when none will.
  place(view, now) {
    this.pass += 1;
    const captions = [];
    if (this.spatialGrid) this.placeRanks(view, now, captionRankLimit(view.zoom), captions);

    let nextDeadline = null;
    for (const [id, record] of this.records) {
      if (record.pass !== this.pass) { this.records.delete(id); continue; }
      if (record.phase === 'shown') continue;
      const due = record.since + (record.phase === 'pending' ? SHOW_AFTER_MS : HIDE_AFTER_MS);
      if (nextDeadline === null || due < nextDeadline) nextDeadline = due;
    }
    return { captions, nextDeadline };
  }

  placeRanks(view, now, limit, captions) {
    const grid = new CollisionGrid(); // the chrome, disc rims, nearby ribbons and captions placed so far
    const area = {
      left: this.insets.left,
      top: this.insets.top,
      right: view.viewportWidth - this.insets.right,
      bottom: view.viewportHeight - this.insets.bottom,
    };
    for (const block of this.blocks) grid.insert(blockRect(block, view), OBSTACLE_NAME);
    const candidates = this.stage(view, limit, grid, area);

    for (const candidate of candidates) {
      if (captions.length >= CAPTION_POOL) break;
      const record = this.records.get(candidate.id);
      const boxWidth = candidate.metric.width + CAPTION.padPx * 2;
      const boxHeight = candidate.metric.height;
      const lastAnchor = record ? record.anchor : -1;

      const anchor = candidate.eligible ? seatFor(candidate, boxWidth, boxHeight, grid, area, lastAnchor) : -1;
      if (anchor >= 0) {
        const phase = placedPhase(record, now, candidate.forced);
        this.records.set(candidate.id, { phase, since: record && record.phase === phase ? record.since : now, anchor, pass: this.pass });
        const rect = anchorRect(candidate, boxWidth, boxHeight, anchor);
        grid.insert(rect, OBSTACLE_NAME);
        captions.push({ id: candidate.id, anchor, left: rect.left, top: rect.top, width: boxWidth, height: boxHeight, lines: candidate.metric.lines, shown: phase !== 'pending' });
        continue;
      }

      // Lost its seat. A caption on screen holds it — and keeps lower ranks off it — until the hide deadline.
      if (!record || record.phase === 'pending') continue;
      if (record.phase === 'shown') { record.phase = 'leaving'; record.since = now; }
      if (now - record.since >= HIDE_AFTER_MS) continue;
      record.pass = this.pass;
      const rect = anchorRect(candidate, boxWidth, boxHeight, record.anchor);
      grid.insert(rect, OBSTACLE_NAME);
      captions.push({ id: candidate.id, anchor: record.anchor, left: rect.left, top: rect.top, width: boxWidth, height: boxHeight, lines: candidate.metric.lines, shown: true });
    }
  }

  // Every node near the viewport is a disc obstacle. A candidate is a node this zoom's
  // rank limit names, or one still on screen; the selected, the hovered and a crown below the working view are forced.
  stage(view, limit, grid, area) {
    const reach = REACH_PX / view.zoom;
    const halfWidth = view.viewportWidth / 2 / view.zoom;
    const halfHeight = view.viewportHeight / 2 / view.zoom;
    const ids = this.spatialGrid.within(view.x - halfWidth - reach, view.y - halfHeight - reach, view.x + halfWidth + reach, view.y + halfHeight + reach);
    const candidates = [];
    for (const id of ids) {
      const node = this.nodesById.get(id);
      const sx = (node.x - view.x) * view.zoom + view.viewportWidth / 2;
      const sy = (node.y - view.y) * view.zoom + view.viewportHeight / 2;
      const crown = node.emphasis > 0;
      const scale = 1 + (crown ? ROOT_BODY_SCALE - 1 : 0) + (id === this.selectedId ? SELECTED_SCALE - 1 : 0);
      const rim = Math.max(NODE_SIZE * RIM_FRACTION * view.zoom * scale, (crown ? MIN_ROOT_BODY_PX : MIN_BODY_PX) / 2);
      grid.insert({ left: sx - rim, top: sy - rim, right: sx + rim, bottom: sy + rim }, OBSTACLE_DISC);
      const metric = this.metricById.get(id);
      if (!metric) continue;
      const rank = this.rankOf(id);
      const record = this.records.get(id);
      const onScreen = record !== undefined && record.phase !== 'pending';
      if (rank > limit && !onScreen) continue;
      candidates.push({
        id, sx, sy, rim, metric, rank,
        eligible: rank <= limit,
        landmark: crown && limit < RANK_REST,
        forced: rank <= RANK_HOVERED || (crown && limit < RANK_REST),
        weight: rank === RANK_ANCHOR ? this.subtreeSizeById.get(id) ?? 0 : 0,
        newcomer: onScreen ? 0 : 1,
        distance: (node.x - view.x) ** 2 + (node.y - view.y) ** 2,
      });
    }
    if (limit > RANK_ANCHOR) this.stageRibbons(view, grid, area);
    candidates.sort(byPriority);
    if (candidates.length > CANDIDATE_LIMIT) candidates.length = CANDIDATE_LIMIT;
    return candidates;
  }

  // Keep nearby curves once; a seat tests its own short crossing and stops at the first ribbon it touches.
  // Thousands of spokes around a crown cost no full-viewport ribbon tessellation.
  stageRibbons(view, grid, area) {
    for (const edge of this.edges) {
      const from = this.nodesById.get(edge.from);
      const to = this.nodesById.get(edge.to);
      if (!from || !to) continue;
      const fx = (from.x - view.x) * view.zoom + view.viewportWidth / 2;
      const fy = (from.y - view.y) * view.zoom + view.viewportHeight / 2;
      const tx = (to.x - view.x) * view.zoom + view.viewportWidth / 2;
      const ty = (to.y - view.y) * view.zoom + view.viewportHeight / 2;
      // Curves outside the caption area never reach a seat's collision query.
      const length = Math.hypot(tx - fx, ty - fy);
      const crossing = chordRange(fx, fy, tx, ty, area, BEND_REACH * length + RIBBON_HALF_PX);
      if (crossing === null) continue;
      const { cx, cy } = controlPoint(fx, fy, tx, ty, bendOf(edge.from, edge.to));
      grid.ribbons.push({ fx, fy, tx, ty, cx, cy, length });
    }
  }
}

// The stretch of a straight run from (fx, fy) to (tx, ty) that lies inside `area` grown by `margin`, as a [0, 1]
// parameter range — null when none of it does.
function chordRange(fx, fy, tx, ty, area, margin) {
  let lo = 0;
  let hi = 1;
  for (const [delta, near, far] of [
    [tx - fx, area.left - margin - fx, area.right + margin - fx],
    [ty - fy, area.top - margin - fy, area.bottom + margin - fy],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (near > 0 || far < 0) return null;
      continue;
    }
    lo = Math.max(lo, Math.min(near / delta, far / delta));
    hi = Math.min(hi, Math.max(near / delta, far / delta));
  }
  return lo <= hi ? [lo, hi] : null;
}

// The seat a caption takes: one clear of everything; else one that only crosses a branch, since a name on a ribbon
// beats a step with no name; else, when it is forced, one that covers the dots and threads too. The selected and the
// hovered are never dropped — boxed in by other names they sit under one — while a landmark that would have to goes
// unnamed instead.
function seatFor(candidate, boxWidth, boxHeight, grid, area, lastAnchor) {
  const clear = freeAnchor(candidate, boxWidth, boxHeight, grid, OBSTACLE_RIBBON, area, lastAnchor);
  if (clear >= 0) return clear;
  const acrossARibbon = freeAnchor(candidate, boxWidth, boxHeight, grid, OBSTACLE_DISC, area, lastAnchor);
  if (acrossARibbon >= 0) return acrossARibbon;
  if (!candidate.forced) return -1;
  const overTheDots = freeAnchor(candidate, boxWidth, boxHeight, grid, OBSTACLE_NAME, area, lastAnchor);
  if (overTheDots >= 0) return overTheDots;
  if (candidate.landmark) return -1;
  return lastAnchor >= 0 ? lastAnchor : ANCHOR_BELOW;
}

// The last seat first, so a caption stays put across small camera moves; then below → above → right → left.
function freeAnchor(candidate, boxWidth, boxHeight, grid, upTo, area, lastAnchor) {
  if (lastAnchor >= 0 && seatIsFree(anchorRect(candidate, boxWidth, boxHeight, lastAnchor), grid, upTo, area)) return lastAnchor;
  for (let anchor = 0; anchor < ANCHOR_COUNT; anchor += 1) {
    if (anchor === lastAnchor) continue;
    if (seatIsFree(anchorRect(candidate, boxWidth, boxHeight, anchor), grid, upTo, area)) return anchor;
  }
  return -1;
}

function seatIsFree(rect, grid, upTo, area) {
  return inside(rect, area) && !grid.collides(rect, upTo);
}

// A forced caption (selected, hovered, a crown at an overview zoom) shows at once; any other waits SHOW_AFTER_MS of
// unbroken placement.
function placedPhase(record, now, forced) {
  if (forced) return 'shown';
  if (!record) return 'pending';
  if (record.phase === 'pending') return now - record.since >= SHOW_AFTER_MS ? 'shown' : 'pending';
  return 'shown';
}
