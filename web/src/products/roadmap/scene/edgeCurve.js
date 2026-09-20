// The one bow both halves of an edge read: the ribbon the GPU tessellates and the seat the captions keep clear of it.
// Screen px or world units — the curve is the same shape under a uniform scale.

const BEND_FACTOR = 0.18;
// The most of its own length a bow can carry a ribbon off the straight run between its ends.
export const BEND_REACH = BEND_FACTOR / 2;

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

// An edge's own bow, in [-0.5, 0.5), from the two node ids. Never derive it from the endpoint coordinates, or a drag
// re-rolls the curve every frame.
export function bendOf(fromId, toId) {
  return (hashStr(`${fromId}-${toId}`) % 100) / 100 - 0.5;
}

export function controlPoint(fx, fy, tx, ty, sway) {
  const dx = tx - fx;
  const dy = ty - fy;
  const len = Math.hypot(dx, dy) || 1;
  const bend = sway * len * BEND_FACTOR;
  return { cx: (fx + tx) / 2 - (dy / len) * bend, cy: (fy + ty) / 2 + (dx / len) * bend };
}

export function pointOnCurve(fx, fy, cx, cy, tx, ty, t) {
  const omt = 1 - t;
  return { x: omt * omt * fx + 2 * omt * t * cx + t * t * tx, y: omt * omt * fy + 2 * omt * t * cy + t * t * ty };
}
