// The hero of every share surface (X2 identity) — the tree rendered as a
// deterministic, standalone SVG string from the app's RenderModel. Pure: it
// takes a model, a share palette and a pixel box, and returns markup. No React,
// no WebGL, no DOM, no I/O. The string is rasterised into an <img> for PNG/OG/
// thumb/GIF export, so it carries its own xmlns, explicit width/height, and
// per-call-unique filter ids; it never reaches out to CSS vars, fonts or urls.

import { NODE_SIZE } from '../theme.js';

const RADIUS = NODE_SIZE / 2;   // 28 world units — same space as node x/y and bounds
const ROOT_SCALE = 1.35;        // the root disc (emphasis) runs larger + crowned

// Look ratios are × a node's own radius so they hold whether the tree spans
// hundreds or thousands of world units — strokes track the node, not the pixel.
const GLOW_R = 2.05;            // soft halo radius
const RING_R = 1.13;            // thin outer ring, just past the disc
const RING_W = 0.09;            // outer ring stroke
const LOCKED_R = 0.88;          // locked disc shrinks slightly inward
const BOW = 0.14;               // edge bow — perpendicular offset, × edge length

const LIT_EDGE = RADIUS * 0.07;      // ~1.96 world units — a grown, lit branch
const DIM_EDGE = RADIUS * 0.05;      // ~1.4  — a dormant branch
const AVAIL_STROKE = RADIUS * 0.072; // ~2    — the outline of an available node
const LOCKED_STROKE = RADIUS * 0.046;// ~1.3  — the faint edge of a locked ghost

const BLUR_STD = RADIUS * 0.55;  // the done/active halo's gaussian spread — part of a node's drawn footprint

let portraitUid = 0; // unique filter ids so many portraits on one page never collide

// The tree portrait as an SVG string. `box` is the pixel viewport; `viewBox` optionally
// overrides the world window — the OG card passes a glow-inclusive, padded, clamped box so
// any tree centers and fills the panel. Omit it and the model's own bounds are the window.
// `options` = { highlight: Set<nodeId>|null, dim: number } opens the veil seam below.
export function treePortraitSvg(model, palette, box, viewBox, options) {
  const b = model.bounds;
  const vb = viewBox ?? { minX: b.minX, minY: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
  const glowId = `wm-glow-${portraitUid++}`;

  // The veil (brief #20): given a non-empty highlight set, everything outside it drops to `dim`
  // — a scatter of new brightness on a ghosted tree, which is what makes the progress card read
  // as the structural opposite of the milestone card at thumbnail size. An edge is outside
  // unless BOTH its endpoints are highlighted. A veil that doesn't dim isn't one: with no
  // highlight, an empty one, or dim 1, nothing is written and the markup is byte-identical to
  // the portrait the OG card and the share clip already draw.
  const dim = options?.dim ?? 1;
  const highlight = dim < 1 && options?.highlight?.size ? options.highlight : null;
  const nodeVeil = (node) => (!highlight || highlight.has(node.id) ? '' : ` opacity="${num(dim)}"`);
  const edgeVeil = (edge) => (!highlight || (highlight.has(edge.from) && highlight.has(edge.to)) ? 1 : dim);

  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const edges = model.edges.map((edge) => edgePath(edge, byId, palette, edgeVeil(edge))).join('');
  const nodes = model.nodes.map((node) => `<g class="wm-node"${nodeVeil(node)}>${nodeMarkup(node, palette, glowId)}</g>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}"`
    + ` viewBox="${num(vb.minX)} ${num(vb.minY)} ${num(vb.width)} ${num(vb.height)}" preserveAspectRatio="xMidYMid meet">`
    + `<defs><filter id="${glowId}" x="-80%" y="-80%" width="260%" height="260%">`
    + `<feGaussianBlur stdDeviation="${num(BLUR_STD)}"/></filter></defs>`
    + `<g>${edges}</g>`
    + `<g>${nodes}</g>`
    + `</svg>`;
}

// A node's drawn footprint radius in world units — the OG card grows its bounding box by
// this per node so no done halo (nor the root's crown) clips at the panel edge.
export function nodeGlowRadius(node) {
  const r = node.emphasis ? RADIUS * ROOT_SCALE : RADIUS;
  const lit = node.state === 'complete' || node.state === 'active';
  const outer = lit ? r * GLOW_R + BLUR_STD * 2 : r * RING_R;
  const crown = node.emphasis ? r * 1.75 : 0; // the crown reaches ~1.72r above the disc
  return Math.max(outer, crown);
}

// A branch: a quadratic bézier bowed perpendicular to its own line, lit when its
// source node is engaged (complete/active), dimmed and de-emphasised otherwise.
// `veil` scales the finished opacity — 1 for every caller that doesn't highlight.
function edgePath(edge, byId, palette, veil = 1) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cx = mx - dy * BOW;
  const cy = my + dx * BOW;

  const lit = a.state === 'complete' || a.state === 'active';
  const faded = edge.kind === 'cross-branch' ? 0.8 : 1;
  const stroke = lit ? palette.bark : palette.dimEdge;
  const width = lit ? LIT_EDGE : DIM_EDGE;
  const opacity = (lit ? 0.92 : 0.75) * faded * veil;

  return `<path d="M${num(a.x)} ${num(a.y)} Q${num(cx)} ${num(cy)} ${num(b.x)} ${num(b.y)}"`
    + ` fill="none" stroke="${stroke}" stroke-width="${num(width)}" stroke-linecap="round" opacity="${num(opacity)}"/>`;
}

// State → look. Done fruit glows; available fruit is a hollow outline; locked
// fruit is a faint ghost of its kind. The root wears a crown on top of any state.
function nodeMarkup(node, palette, glowId) {
  const kind = palette.kinds[node.color] ?? palette.kinds.terracotta;
  const r = node.emphasis ? RADIUS * ROOT_SCALE : RADIUS;
  const x = num(node.x);
  const y = num(node.y);
  const crown = node.emphasis ? crownMarkup(node.x, node.y, r, palette) : '';

  if (node.state === 'complete' || node.state === 'active') {
    const halo = `<circle cx="${x}" cy="${y}" r="${num(r * GLOW_R)}" fill="rgba(${kind.rgb},${num(palette.glowOp)})" filter="url(#${glowId})"/>`;
    const ring = `<circle cx="${x}" cy="${y}" r="${num(r * RING_R)}" fill="none" stroke="rgba(${kind.rgb},.55)" stroke-width="${num(r * RING_W)}"/>`;
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="${kind.c}"/>`;
    return halo + ring + disc + specular(node.x, node.y, r) + crown;
  }
  if (node.state === 'available') {
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="${palette.avail}" stroke="${kind.c}" stroke-width="${num(AVAIL_STROKE)}"/>`;
    return disc + crown;
  }
  const disc = `<circle cx="${x}" cy="${y}" r="${num(r * LOCKED_R)}" fill="rgba(${kind.rgb},.16)" stroke="rgba(${kind.rgb},.4)" stroke-width="${num(LOCKED_STROKE)}"/>`;
  return disc + crown;
}

// The painterly fruit highlight — a soft white ellipse tilted top-left of the disc.
function specular(cx, cy, r) {
  const ex = num(cx - r * 0.3);
  const ey = num(cy - r * 0.36);
  return `<ellipse cx="${ex}" cy="${ey}" rx="${num(r * 0.42)}" ry="${num(r * 0.24)}"`
    + ` fill="rgba(255,255,255,.4)" transform="rotate(-24 ${ex} ${ey})"/>`;
}

// A small three-peak gold crown sitting just above the root's disc.
function crownMarkup(cx, cy, r, palette) {
  const w = r * 1.5;
  const h = r * 0.5;
  const base = cy - r - r * 0.15;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const d = `M${num(x0)} ${num(base)}`
    + `L${num(x0 + w * 0.16)} ${num(base - h)}`
    + `L${num(x0 + w * 0.33)} ${num(base - h * 0.45)}`
    + `L${num(cx)} ${num(base - h * 1.15)}`
    + `L${num(x1 - w * 0.33)} ${num(base - h * 0.45)}`
    + `L${num(x1 - w * 0.16)} ${num(base - h)}`
    + `L${num(x1)} ${num(base)}Z`;
  return `<path d="${d}" fill="${palette.kinds.gold.c}"/>`;
}

function num(v) {
  return Math.round(v * 100) / 100;
}
