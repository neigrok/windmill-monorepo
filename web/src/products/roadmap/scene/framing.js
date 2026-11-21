// Where a camera sits to show a roadmap or one step of it: the fit, the floor no zoom passes and the centre the chrome
// leaves. Pure. A `canvas` is the camera's own facts: viewportWidth, viewportHeight, insets, workingZoom and fitBounds.
import { NODE_SIZE } from '../theme.js';

const MAX_ZOOM = 6;
// The zoom floor sits this far below the whole tree's fit: a wheel or pinch can back off from All steps, never lose the tree.
const FLOOR_BELOW_FIT = 0.5;
const MIN_ZOOM_WITHOUT_MODEL = 0.006;
const FIT_PADDING = 0.9;
// The air a focused step's family keeps inside the frame.
const FAMILY_FRAME_PAD = NODE_SIZE * 2;

// The zoom that shows all of `bounds` inside the visible area, uncapped.
export function fitZoomFor(canvas, bounds, padding = FIT_PADDING) {
  const boundsWidth = Math.max(bounds.maxX - bounds.minX, 1);
  const boundsHeight = Math.max(bounds.maxY - bounds.minY, 1);
  const visibleWidth = Math.max(1, canvas.viewportWidth - canvas.insets.left - canvas.insets.right);
  const visibleHeight = Math.max(1, canvas.viewportHeight - canvas.insets.top - canvas.insets.bottom);
  return Math.min(visibleWidth / boundsWidth, visibleHeight / boundsHeight) * padding;
}

export function minZoom(canvas) {
  if (!canvas.fitBounds) return MIN_ZOOM_WITHOUT_MODEL;
  return Math.min(fitZoomFor(canvas, canvas.fitBounds), canvas.workingZoom) * FLOOR_BELOW_FIT;
}

export function clampZoom(canvas, zoom, maxZoom = MAX_ZOOM) {
  return Math.min(maxZoom, Math.max(minZoom(canvas), zoom));
}

// The world-space size of the area the chrome leaves visible, at `zoom`.
export function visibleSpanAt(canvas, zoom) {
  return {
    width: Math.max(1, canvas.viewportWidth - canvas.insets.left - canvas.insets.right) / zoom,
    height: Math.max(1, canvas.viewportHeight - canvas.insets.top - canvas.insets.bottom) / zoom,
  };
}

// Where the camera must sit for a world point to land at the centre of the visible area at `zoom`.
export function centreFor(canvas, x, y, zoom) {
  return {
    x: x + (canvas.insets.right - canvas.insets.left) / (2 * zoom),
    y: y + (canvas.insets.bottom - canvas.insets.top) / (2 * zoom),
  };
}

// All of `bounds` inside the visible area; the cap keeps a tiny tree from fitting-to-fill past the working zoom.
export function fitFrame(canvas, bounds, padding = FIT_PADDING, maxZoom = canvas.workingZoom) {
  const zoom = clampZoom(canvas, fitZoomFor(canvas, bounds, padding), maxZoom);
  return { ...centreFor(canvas, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, zoom), zoom };
}

// What a focus frames: the box holding the step, its trunk parent and its trunk children when that box fits the
// visible area at `zoom` — a step at the edge of its family never opens on half a screen of empty canvas — else the step.
export function familyCentre(canvas, edges, nodesById, node, zoom) {
  let minX = node.x;
  let maxX = node.x;
  let minY = node.y;
  let maxY = node.y;
  for (const edge of edges) {
    if (edge.kind !== 'trunk') continue;
    const relative = edge.to === node.id ? nodesById.get(edge.from) : edge.from === node.id ? nodesById.get(edge.to) : null;
    if (!relative) continue;
    minX = Math.min(minX, relative.x);
    maxX = Math.max(maxX, relative.x);
    minY = Math.min(minY, relative.y);
    maxY = Math.max(maxY, relative.y);
  }
  const span = visibleSpanAt(canvas, zoom);
  if (maxX - minX + FAMILY_FRAME_PAD * 2 > span.width || maxY - minY + FAMILY_FRAME_PAD * 2 > span.height) return node;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// A step's family at the working zoom, centred in the visible area.
export function focusFrame(canvas, edges, nodesById, node) {
  const target = familyCentre(canvas, edges, nodesById, node, canvas.workingZoom);
  return { ...centreFor(canvas, target.x, target.y, canvas.workingZoom), zoom: clampZoom(canvas, canvas.workingZoom) };
}
