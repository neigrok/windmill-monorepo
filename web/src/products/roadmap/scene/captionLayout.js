// Captions, decided: which nodes get a fixed 14 px name, where each name sits, and when it appears.
// Pure — no DOM. LabelOverlay measures the text, hands the metrics in, and moves elements to the
// rectangles this file returns. Screen px throughout; a caption never scales with zoom.
import { NODE_SIZE, BODY_FRACTION, ROOT_BODY_SCALE, CAPTION } from '../theme.js';

export const CAPTION_POOL = 96; // the most captions on screen at once — also the DOM pool
export const WORKING_BODY_PX = 18; // projected ordinary body from which every node may be named
export const CAPTION_MIN_BODY_PX = 4; // below this only the selected and the hovered node are named
export const SHOW_AFTER_MS = 200; // continuous eligibility before a caption appears
export const HIDE_AFTER_MS = 200; // continuous ineligibility before a shown caption goes
export const BRANCH_HEAD_MIN_SUBTREE = 8;

const TEXT_WIDTH = CAPTION.maxWidthPx - CAPTION.padPx * 2; // the text column inside the 168 px box
const RIM_FRACTION = BODY_FRACTION / 2;
const SELECTED_SCALE = 1.14; // the shader grows the selected disc by this
const CANDIDATE_LIMIT = CAPTION_POOL * 3;
const COLLISION_GAP = 2;
const CELL_PX = 64;
const REACH_PX = 200; // a node this far past the canvas edge can still own a caption on it

const RANK_SELECTED = 0;
const RANK_HOVERED = 1;
const RANK_FAMILY = 2; // the selected node's trunk parent and trunk children
const RANK_ANCHOR = 3; // crowned roots and branch heads
const RANK_FRONTIER = 4; // active and available
const RANK_REST = 5;

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

// Keyed on the projected ordinary body, so the same rule holds on every tree. Monotone in zoom.
export function captionTier(zoom) {
  const bodyPx = NODE_SIZE * BODY_FRACTION * zoom;
  if (bodyPx < CAPTION_MIN_BODY_PX) return 'none';
  if (bodyPx < WORKING_BODY_PX) return 'overview';
  return 'working';
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

// Rectangles bucketed by 64 px cell, so a collision test touches only the cells a rectangle covers.
class CollisionGrid {
  constructor() {
    this.cells = new Map();
  }

  insert(rect) {
    this.visit(rect, (key) => {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(rect);
      else this.cells.set(key, [rect]);
      return false;
    });
  }

  collides(rect) {
    return this.visit(rect, (key) => {
      const bucket = this.cells.get(key);
      if (!bucket) return false;
      for (const other of bucket) {
        if (rect.left < other.right + COLLISION_GAP && rect.right > other.left - COLLISION_GAP
          && rect.top < other.bottom + COLLISION_GAP && rect.bottom > other.top - COLLISION_GAP) return true;
      }
      return false;
    });
  }

  visit(rect, callback) {
    const firstX = Math.floor((rect.left - COLLISION_GAP) / CELL_PX);
    const lastX = Math.floor((rect.right + COLLISION_GAP) / CELL_PX);
    const firstY = Math.floor((rect.top - COLLISION_GAP) / CELL_PX);
    const lastY = Math.floor((rect.bottom + COLLISION_GAP) / CELL_PX);
    for (let cellX = firstX; cellX <= lastX; cellX += 1) {
      for (let cellY = firstY; cellY <= lastY; cellY += 1) {
        if (callback((cellX + 32768) * 65536 + (cellY + 32768))) return true;
      }
    }
    return false;
  }
}

// ---- the placer --------------------------------------------------------

// Priority first, then a caption already on screen before one that is not, then nearness to the
// viewport centre, then id — so two passes over the same picture agree.
function byPriority(a, b) {
  return a.rank - b.rank || a.newcomer - b.newcomer || a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

// Holds the model index, the metrics, the selection context and each caption's hysteresis record;
// `place(view, now)` is the one decision, deterministic for the same inputs and clock.
// A record is `{ phase, since, anchor, pass }`: pending (placed, waiting SHOW_AFTER_MS), shown,
// or leaving (lost its seat, drawn there until HIDE_AFTER_MS pass). No record is hidden.
export class CaptionPlacer {
  constructor() {
    this.nodesById = new Map();
    this.spatialGrid = null;
    this.trunkParentById = new Map();
    this.trunkChildrenById = new Map();
    this.anchorIds = new Set();
    this.metricById = new Map();
    this.stateById = new Map();
    this.selectedId = null;
    this.hoveredId = null;
    this.familyIds = new Set();
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.records = new Map();
    this.pass = 0;
  }

  // Records survive a re-installed model, so a live edit never blinks every caption.
  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = spatialGrid;
    this.stateById = new Map(renderModel.nodes.map((node) => [node.id, node.state]));
    this.trunkParentById = new Map();
    this.trunkChildrenById = new Map(renderModel.nodes.map((node) => [node.id, []]));
    for (const edge of renderModel.edges) {
      if (edge.kind !== 'trunk') continue;
      this.trunkParentById.set(edge.to, edge.from);
      this.trunkChildrenById.get(edge.from).push(edge.to);
    }
    const subtree = trunkSubtreeSizes(renderModel.nodes, this.trunkParentById, this.trunkChildrenById);
    this.anchorIds = new Set(renderModel.nodes
      .filter((node) => node.emphasis > 0 || (node.branch === node.id && subtree.get(node.id) >= BRANCH_HEAD_MIN_SUBTREE))
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

  setInsets({ top = 0, right = 0, bottom = 0, left = 0 }) {
    this.insets = { top, right, bottom, left };
  }

  rankOf(id) {
    if (id === this.selectedId) return RANK_SELECTED;
    if (id === this.hoveredId) return RANK_HOVERED;
    if (this.familyIds.has(id)) return RANK_FAMILY;
    if (this.anchorIds.has(id)) return RANK_ANCHOR;
    const state = this.stateById.get(id);
    if (state === 'active' || state === 'available') return RANK_FRONTIER;
    return RANK_REST;
  }

  // `view` is the camera: x, y, zoom, viewportWidth, viewportHeight. Returns the captions to draw,
  // in priority order, each `{ id, anchor, left, top, width, height, lines, shown }`, and the clock instant
  // at which the next pending or leaving caption changes — null when none is waiting.
  place(view, now) {
    this.pass += 1;
    const captions = [];
    const tier = captionTier(view.zoom);
    const forcedId = this.selectedId ?? this.hoveredId;
    if (this.spatialGrid && (tier !== 'none' || forcedId !== null || this.records.size > 0)) this.placeTier(view, now, tier, captions);

    let nextDeadline = null;
    for (const [id, record] of this.records) {
      if (record.pass !== this.pass) { this.records.delete(id); continue; }
      if (record.phase === 'shown') continue;
      const due = record.since + (record.phase === 'pending' ? SHOW_AFTER_MS : HIDE_AFTER_MS);
      if (nextDeadline === null || due < nextDeadline) nextDeadline = due;
    }
    return { captions, nextDeadline };
  }

  placeTier(view, now, tier, captions) {
    const grid = new CollisionGrid();
    const candidates = this.stage(view, tier, grid);
    const area = {
      left: this.insets.left,
      top: this.insets.top,
      right: view.viewportWidth - this.insets.right,
      bottom: view.viewportHeight - this.insets.bottom,
    };

    for (const candidate of candidates) {
      if (captions.length >= CAPTION_POOL) break;
      const record = this.records.get(candidate.id);
      const boxWidth = candidate.metric.width + CAPTION.padPx * 2;
      const boxHeight = candidate.metric.height;
      const forced = candidate.rank <= RANK_HOVERED;
      const lastAnchor = record ? record.anchor : -1;

      let anchor = candidate.eligible ? freeAnchor(candidate, boxWidth, boxHeight, grid, area, lastAnchor) : -1;
      if (anchor < 0 && forced && candidate.eligible) anchor = lastAnchor >= 0 ? lastAnchor : ANCHOR_BELOW;
      if (anchor >= 0) {
        const phase = placedPhase(record, now, forced);
        this.records.set(candidate.id, { phase, since: record && record.phase === phase ? record.since : now, anchor, pass: this.pass });
        const rect = anchorRect(candidate, boxWidth, boxHeight, anchor);
        grid.insert(rect);
        captions.push({ id: candidate.id, anchor, left: rect.left, top: rect.top, width: boxWidth, height: boxHeight, lines: candidate.metric.lines, shown: phase !== 'pending' });
        continue;
      }

      // Lost its seat. A caption on screen holds it — and keeps lower ranks off it — until the hide deadline.
      if (!record || record.phase === 'pending') continue;
      if (record.phase === 'shown') { record.phase = 'leaving'; record.since = now; }
      if (now - record.since >= HIDE_AFTER_MS) continue;
      record.pass = this.pass;
      const rect = anchorRect(candidate, boxWidth, boxHeight, record.anchor);
      grid.insert(rect);
      captions.push({ id: candidate.id, anchor: record.anchor, left: rect.left, top: rect.top, width: boxWidth, height: boxHeight, lines: candidate.metric.lines, shown: true });
    }
  }

  // Every node near the viewport becomes a disc obstacle. A candidate is a node the tier lets be
  // named, or one whose caption is still on screen and must be held; sorted by priority and capped
  // so a dense overview never walks the whole tree. The selected and the hovered node are named at
  // every zoom — below CAPTION_MIN_BODY_PX theirs is the only name on screen.
  stage(view, tier, grid) {
    const reach = REACH_PX / view.zoom;
    const halfWidth = view.viewportWidth / 2 / view.zoom;
    const halfHeight = view.viewportHeight / 2 / view.zoom;
    const ids = this.spatialGrid.within(view.x - halfWidth - reach, view.y - halfHeight - reach, view.x + halfWidth + reach, view.y + halfHeight + reach);
    const candidates = [];
    for (const id of ids) {
      const node = this.nodesById.get(id);
      const sx = (node.x - view.x) * view.zoom + view.viewportWidth / 2;
      const sy = (node.y - view.y) * view.zoom + view.viewportHeight / 2;
      const rim = NODE_SIZE * RIM_FRACTION * view.zoom * (node.emphasis > 0 ? ROOT_BODY_SCALE : 1) * (id === this.selectedId ? SELECTED_SCALE : 1);
      grid.insert({ left: sx - rim, top: sy - rim, right: sx + rim, bottom: sy + rim });
      const metric = this.metricById.get(id);
      if (!metric) continue;
      const rank = this.rankOf(id);
      const record = this.records.get(id);
      const onScreen = record !== undefined && record.phase !== 'pending';
      const eligible = rank <= RANK_HOVERED || tier === 'working' || (tier === 'overview' && this.anchorIds.has(id));
      if (!eligible && !onScreen) continue;
      candidates.push({
        id, sx, sy, rim, metric, rank, eligible,
        newcomer: onScreen ? 0 : 1,
        distance: (node.x - view.x) ** 2 + (node.y - view.y) ** 2,
      });
    }
    candidates.sort(byPriority);
    if (candidates.length > CANDIDATE_LIMIT) candidates.length = CANDIDATE_LIMIT;
    return candidates;
  }
}

// The last seat first, so a caption stays put across small camera moves; then below → above → right → left.
function freeAnchor(candidate, boxWidth, boxHeight, grid, area, lastAnchor) {
  if (lastAnchor >= 0 && seatIsFree(anchorRect(candidate, boxWidth, boxHeight, lastAnchor), grid, area)) return lastAnchor;
  for (let anchor = 0; anchor < ANCHOR_COUNT; anchor += 1) {
    if (anchor === lastAnchor) continue;
    if (seatIsFree(anchorRect(candidate, boxWidth, boxHeight, anchor), grid, area)) return anchor;
  }
  return -1;
}

function seatIsFree(rect, grid, area) {
  return inside(rect, area) && !grid.collides(rect);
}

// A forced caption (selected, hovered) shows at once; any other waits SHOW_AFTER_MS of unbroken placement.
function placedPhase(record, now, forced) {
  if (forced) return 'shown';
  if (!record) return 'pending';
  if (record.phase === 'pending') return now - record.since >= SHOW_AFTER_MS ? 'shown' : 'pending';
  return 'shown';
}
