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
const ROUTE_EDGE = RADIUS * 0.078;   // ~2.2  — canon's 2.4·k at the progress card's clamped fit
const AVAIL_STROKE = RADIUS * 0.072; // ~2    — the outline of an available node
const LOCKED_STROKE = RADIUS * 0.046;// ~1.3  — the faint edge of a locked ghost

const BLUR_STD = RADIUS * 0.55;  // the done/active halo's gaussian spread — part of a node's drawn footprint

// The period ink ladder (#20 canon), one table so the ladder reads as one thing. Only the steps
// that lit THIS period wear the in-app look; every rung below is stated here. Settled work keeps
// its kind and its crown at a whisper and loses its halo — the halo is what "new" looks like on
// a period card, so nothing older may wear one.
const PERIOD_INK = {
  settledFill: 0.34, settledRing: 0.5, crown: 0.42,
  availRing: 0.55,
  lockedFill: 0.12, lockedRing: 0.28,
  settledEdge: 0.34, dormantEdge: 0.5,
};

let portraitUid = 0; // unique filter ids so many portraits on one page never collide

// The tree portrait as an SVG string. `box` is the pixel viewport; `viewBox` optionally
// overrides the world window — the OG card passes a glow-inclusive, padded, clamped box so
// any tree centers and fills the panel. Omit it and the model's own bounds are the window.
// `options` = { lit: Set<nodeId> } opens the period ink below.
export function treePortraitSvg(model, palette, box, viewBox, options) {
  const b = model.bounds;
  const vb = viewBox ?? { minX: b.minX, minY: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
  const glowId = `wm-glow-${portraitUid++}`;

  // The period ink (brief #20): handed the steps that lit this period, the tree is drawn on the
  // four-tier ladder instead of the plain done/not look — new work at full light, everything
  // older stepped back, and the edge INTO each new step in that step's own kind. That last rule
  // is what carries the card's meaning: it draws the ROUTE taken this period, not just the
  // destinations. No set, or an empty one, never opens the ladder — so the markup the OG card
  // and the share clip pin stays byte-identical.
  const lit = options?.lit?.size ? options.lit : null;
  const ink = (node) => (lit ? periodInkMarkup(node, palette, glowId, lit.has(node.id)) : nodeMarkup(node, palette, glowId));

  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const edges = model.edges.map((edge) => edgePath(edge, byId, palette, lit)).join('');
  const nodes = model.nodes.map((node) => `<g class="wm-node">${ink(node)}</g>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}"`
    + ` viewBox="${num(vb.minX)} ${num(vb.minY)} ${num(vb.width)} ${num(vb.height)}" preserveAspectRatio="xMidYMid meet">`
    + `<defs><filter id="${glowId}" x="-80%" y="-80%" width="260%" height="260%">`
    + `<feGaussianBlur stdDeviation="${num(BLUR_STD)}"/></filter></defs>`
    + `<g>${edges}</g>`
    + `<g>${nodes}</g>`
    + `</svg>`;
}

// A node's drawn footprint radius in world units — the OG card grows its bounding box by
// this per node so no done halo (nor the root's crown) clips at the panel edge. `assumeLit`
// measures a node as if it were done: a card in a SERIES needs a footprint that holds still
// while steps complete, and a lit node's is the larger of the two (see ogCard's steady fit).
export function nodeGlowRadius(node, assumeLit = false) {
  const r = node.emphasis ? RADIUS * ROOT_SCALE : RADIUS;
  const lit = assumeLit || node.state === 'complete' || node.state === 'active';
  const outer = lit ? r * GLOW_R + BLUR_STD * 2 : r * RING_R;
  const crown = node.emphasis ? r * 1.75 : 0; // the crown reaches ~1.72r above the disc
  return Math.max(outer, crown);
}

// A branch: a quadratic bézier bowed perpendicular to its own line, inked by the ladder below.
function edgePath(edge, byId, palette, lit) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cx = mx - dy * BOW;
  const cy = my + dx * BOW;

  const { stroke, width, opacity } = edgeInk(edge, a, b, palette, lit);
  return `<path d="M${num(a.x)} ${num(a.y)} Q${num(cx)} ${num(cy)} ${num(b.x)} ${num(b.y)}"`
    + ` fill="none" stroke="${stroke}" stroke-width="${num(width)}" stroke-linecap="round" opacity="${num(opacity)}"/>`;
}

// A branch is lit when its source node is engaged (complete/active) and dormant otherwise — and
// on a period card one rung above both: the edge INTO a step that lit this period is drawn in
// that step's own kind, thicker, at full alpha. Canon states the period card's three edge tiers
// flat, so the cross-branch fade sits this one out: the route has to read unambiguously at
// thumbnail size and a second grammar only muddies it.
function edgeInk(edge, from, to, palette, lit) {
  if (lit?.has(to.id)) {
    const kind = palette.kinds[to.color] ?? palette.kinds.terracotta;
    return { stroke: kind.c, width: ROUTE_EDGE, opacity: 1 };
  }

  const engaged = from.state === 'complete' || from.state === 'active';
  if (lit && engaged) return { stroke: palette.bark, width: LIT_EDGE, opacity: PERIOD_INK.settledEdge };
  if (lit) return { stroke: palette.dimEdge, width: DIM_EDGE, opacity: PERIOD_INK.dormantEdge };

  const faded = edge.kind === 'cross-branch' ? 0.8 : 1;
  if (engaged) return { stroke: palette.bark, width: LIT_EDGE, opacity: 0.92 * faded };
  return { stroke: palette.dimEdge, width: DIM_EDGE, opacity: 0.75 * faded };
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

// The same three states one rung down the period ladder, for a card that has to say WHEN as well
// as what. This period's work is the app's own look, borrowed whole from nodeMarkup so "new"
// can never drift from "done"; anything older keeps its kind and its shape but gives up its
// halo, its specular and most of its ink.
function periodInkMarkup(node, palette, glowId, isNew) {
  if (isNew) return nodeMarkup(node, palette, glowId);

  const kind = palette.kinds[node.color] ?? palette.kinds.terracotta;
  const r = node.emphasis ? RADIUS * ROOT_SCALE : RADIUS;
  const x = num(node.x);
  const y = num(node.y);
  const crown = node.emphasis
    ? `<g opacity="${PERIOD_INK.crown}">${crownMarkup(node.x, node.y, r, palette)}</g>`
    : '';

  if (node.state === 'complete' || node.state === 'active') {
    const ring = `<circle cx="${x}" cy="${y}" r="${num(r * RING_R)}" fill="none" stroke="rgba(${kind.rgb},${PERIOD_INK.settledRing})" stroke-width="${num(r * RING_W)}"/>`;
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="rgba(${kind.rgb},${PERIOD_INK.settledFill})"/>`;
    return ring + disc + crown;
  }
  if (node.state === 'available') {
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="${palette.avail}" stroke="rgba(${kind.rgb},${PERIOD_INK.availRing})" stroke-width="${num(AVAIL_STROKE)}"/>`;
    return disc + crown;
  }
  const disc = `<circle cx="${x}" cy="${y}" r="${num(r * LOCKED_R)}" fill="rgba(${kind.rgb},${PERIOD_INK.lockedFill})" stroke="rgba(${kind.rgb},${PERIOD_INK.lockedRing})" stroke-width="${num(LOCKED_STROKE)}"/>`;
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
