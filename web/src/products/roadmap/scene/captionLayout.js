import { LABEL_MAX_WIDTH, LABEL_LINE_HEIGHT, LABEL_GAP, NODE_BODY_DIAMETER } from '../model/geometry.js';

export const LABEL_POOL_SIZE = 96;
const CANDIDATE_LIMIT = LABEL_POOL_SIZE * 3;
const CELL_SIZE = 64;
const COLLISION_GAP = 4;

export function wrapCaption(label, measure, maxWidth = LABEL_MAX_WIDTH - 8) {
  const source = String(label ?? '').trim().replace(/\s+/gu, ' ') || 'Untitled step';
  if (measure(source) <= maxWidth) return { text: source, width: measure(source), height: LABEL_LINE_HEIGHT };
  const points = Array.from(source);
  let cut = points.length;
  while (cut > 1 && measure(points.slice(0, cut).join('')) > maxWidth) cut -= 1;
  const space = points.slice(0, cut + 1).lastIndexOf(' ');
  if (space > 0) cut = space;
  const first = points.slice(0, cut).join('').trimEnd();
  let second = points.slice(cut).join('').trimStart();
  if (measure(second) > maxWidth) {
    const tail = Array.from(second);
    let end = tail.length;
    while (end > 0 && measure(`${tail.slice(0, end).join('').trimEnd()}…`) > maxWidth) end -= 1;
    second = `${tail.slice(0, end).join('').trimEnd()}…`;
  }
  return { text: `${first}\n${second}`, width: Math.max(measure(first), measure(second)), height: LABEL_LINE_HEIGHT * 2 };
}

function compare(a, b) {
  return a.priority - b.priority || a.retained - b.retained || a.distance - b.distance || a.id.localeCompare(b.id);
}

export function captionCandidates(nodes, camera, { selectedId = null, hoveredId = null, neighbors = new Set(), retained = new Set() } = {}) {
  const heap = [];
  for (const node of nodes) {
    const branch = node.emphasis > 0 || node.branch === node.id;
    const priority = node.id === selectedId ? 0 : node.id === hoveredId ? 1 : neighbors.has(node.id) ? 2
      : camera.zoom < 0.3 && branch ? 3 : node.state === 'active' || node.state === 'available' ? (camera.zoom < 0.3 ? 4 : 3) : branch ? 4 : 5;
    const candidate = { id: node.id, node, priority, retained: retained.has(node.id) ? 0 : 1, distance: (node.x - camera.x) ** 2 + (node.y - camera.y) ** 2 };
    if (heap.length < CANDIDATE_LIMIT) {
      heap.push(candidate);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (compare(heap[parent], heap[i]) >= 0) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
      continue;
    }
    if (compare(candidate, heap[0]) >= 0) continue;
    heap[0] = candidate;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      const left = i * 2 + 1;
      const right = left + 1;
      const child = right < heap.length && compare(heap[right], heap[left]) > 0 ? right : left;
      if (compare(heap[i], heap[child]) >= 0) break;
      [heap[i], heap[child]] = [heap[child], heap[i]];
      i = child;
    }
  }
  return heap.sort(compare);
}

export function placeCaptions(nodes, camera, metrics, context = {}) {
  const cells = new Map();
  const placements = [];
  const insets = camera.insets ?? {};
  const viewport = { left: Math.max(8, insets.left ?? 0), top: Math.max(8, insets.top ?? 0), right: camera.viewportWidth - Math.max(8, insets.right ?? 0), bottom: camera.viewportHeight - Math.max(8, insets.bottom ?? 0) };
  const visitCells = (rect, visit) => {
    for (let x = Math.floor(rect.left / CELL_SIZE); x <= Math.floor(rect.right / CELL_SIZE); x += 1) {
      for (let y = Math.floor(rect.top / CELL_SIZE); y <= Math.floor(rect.bottom / CELL_SIZE); y += 1) {
        if (visit(`${x},${y}`)) return true;
      }
    }
    return false;
  };
  const insert = (rect) => visitCells(rect, (key) => {
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(rect);
    return false;
  });
  const collides = (rect) => visitCells(rect, (key) => (cells.get(key) ?? []).some((other) =>
    rect.left < other.right + COLLISION_GAP && rect.right > other.left - COLLISION_GAP
    && rect.top < other.bottom + COLLISION_GAP && rect.bottom > other.top - COLLISION_GAP));
  for (const obstacle of context.obstacles ?? []) insert(obstacle);
  for (const node of nodes) {
    const point = camera.worldToScreen(node.x, node.y);
    const radius = NODE_BODY_DIAMETER * (1 + (node.emphasis ?? 0) * 0.55 + (node.id === context.selectedId ? 0.14 : 0)) * camera.zoom / 2;
    if (radius < 4 && node.id !== context.selectedId && node.id !== context.hoveredId) continue;
    insert({ left: point.x - radius, right: point.x + radius, top: point.y - radius, bottom: point.y + radius });
  }
  const eligible = nodes.filter((node) => {
    if (node.id === context.selectedId || node.id === context.hoveredId) return true;
    const point = camera.worldToScreen(node.x, node.y);
    if (point.x < viewport.left || point.x > viewport.right || point.y < viewport.top || point.y > viewport.bottom) return false;
    return !(context.obstacles ?? []).some((rect) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  });
  const candidates = captionCandidates(eligible, camera, context);
  const limit = Math.min(LABEL_POOL_SIZE, Math.max(8, Math.floor(camera.viewportWidth * camera.viewportHeight / (camera.zoom < 0.45 ? 50000 : 18000))));
  for (const candidate of candidates) {
    if (placements.length >= limit) break;
    const metric = metrics.get(candidate.id);
    if (!metric) continue;
    const point = camera.worldToScreen(candidate.node.x, candidate.node.y);
    const radius = NODE_BODY_DIAMETER * (1 + (candidate.node.emphasis ?? 0) * 0.55 + (candidate.id === context.selectedId ? 0.14 : 0)) * camera.zoom / 2;
    const width = metric.width + 8;
    const height = metric.height;
    const gap = radius + LABEL_GAP;
    const positions = [
      [point.x - width / 2, point.y + gap],
      [point.x - width / 2, point.y - gap - height],
      [point.x + gap, point.y - height / 2],
      [point.x - gap - width, point.y - height / 2],
    ];
    if (candidate.priority <= 1) {
      for (let offset = 24; offset <= 240; offset += 24) {
        positions.push([point.x - width / 2 + offset, point.y + gap], [point.x - width / 2 - offset, point.y + gap]);
        positions.push([point.x - width / 2, point.y + gap + offset], [point.x - width / 2, point.y - gap - height - offset]);
      }
    }
    let rectangle = null;
    for (const [left, top] of positions) {
      const rect = { left, top, right: left + width, bottom: top + height };
      if (rect.left < viewport.left || rect.right > viewport.right || rect.top < viewport.top || rect.bottom > viewport.bottom || collides(rect)) continue;
      rectangle = rect;
      break;
    }
    if (!rectangle && candidate.priority === 0) {
      for (let top = viewport.top; top + height <= viewport.bottom && !rectangle; top += LABEL_LINE_HEIGHT) {
        for (let left = viewport.left; left + width <= viewport.right; left += 24) {
          const rect = { left, top, right: left + width, bottom: top + height };
          if (collides(rect)) continue;
          rectangle = rect;
          break;
        }
      }
    }
    if (!rectangle) continue;
    insert(rectangle);
    placements.push({ id: candidate.id, ...rectangle });
  }
  return placements;
}
