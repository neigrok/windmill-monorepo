// One frame of the share video: the same framed postcard as ogCard.js, as a pure function of loop
// time t ∈ [0, LOOP). The tree dissolves to dormant and grows itself back root → frontier while the
// score assembles, then rests on the grown portrait, which is frame 0, so the loop is seamless. At
// t=0 each node renders identically to the still. Everything scales off k = w/1200; the wide
// frame's centre 1:1 crop is the square. Light only.

import { SHARE_PALETTE } from './palette.js';
import { paddedGlowBox, clampViewBox } from './ogCard.js';
import { NODE_SIZE } from '../theme.js';

// ── loop timeline (ms) — every transient windows to 0 at the seam ──────────────
export const LOOP = 3000;
const HOLD_END = 560, EXHALE_END = 860, GROW_START = 900;
const CADENCE = 320, IGNITE = 280, BLOOM = 560, SEAM_WIN = 150;
const PULSE_FROM = 2600, PULSE_TO = 2980;

// ── portrait look ratios (× a node's radius) — identical to TreePortrait.js ────
const RADIUS = NODE_SIZE / 2;   // 28 world units
const ROOT_SCALE = 1.35;
const GLOW_R = 2.05, RING_R = 1.13, RING_W = 0.09, LOCKED_R = 0.88;
const BOW = 0.14, BLUR_STD = RADIUS * 0.55;
const LIT_EDGE = RADIUS * 0.07, DIM_EDGE = RADIUS * 0.05;
const AVAIL_STROKE = RADIUS * 0.072, LOCKED_STROKE = RADIUS * 0.046;

const DISPLAY = "'Baloo 2', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

// ── easings (tokens/motion.css) ───────────────────────────────────────────────
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const fy = (t) => ((ay * t + by) * t + cy) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) { const e = fx(t) - x; if (Math.abs(e) < 1e-4) break; t -= e / (dfx(t) || 1e-4); }
    return fy(t);
  };
}
const easeStd = cubicBezier(0.4, 0, 0.2, 1);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
const num = (v) => Math.round(v * 100) / 100;

// ── grow schedule: BFS depth + a seeded per-node ignite time from the crowned root ──
function buildSchedule(model) {
  const ids = model.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = ids.map(() => []);
  for (const edge of model.edges) {
    const a = index.get(edge.from), b = index.get(edge.to);
    if (a === undefined || b === undefined) continue;
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  let root = model.nodes.findIndex((n) => n.emphasis === 1);
  if (root < 0) root = 0;
  const depth = ids.map(() => -1);
  depth[root] = 0;
  const queue = [root];
  while (queue.length) {
    const u = queue.shift();
    for (const v of adjacency[u]) if (depth[v] < 0) { depth[v] = depth[u] + 1; queue.push(v); }
  }
  for (let i = 0; i < depth.length; i++) if (depth[i] < 0) depth[i] = 1;  // orphans ride ring 1
  const jitter = (i) => ((i * 2654435761 >>> 0) % 81) - 40;
  const igniteAt = (i) => GROW_START + depth[i] * CADENCE + jitter(i);
  return { index, igniteAt };
}

// Per-node litness L ∈ [0,1] at time t: 1 while held, 1→0 together on the exhale, then 0→1 as each
// ring ignites; 1 at the seam.
function litAt(schedule, i, t) {
  if (t < HOLD_END) return 1;
  if (t < EXHALE_END) return 1 - easeStd((t - HOLD_END) / (EXHALE_END - HOLD_END));
  return easeStd(clamp01((t - schedule.igniteAt(i)) / IGNITE));
}

// 0 within SEAM_WIN of either end of the loop, 1 in the interior: no breath survives the cut.
function seamWindow(t) {
  return smooth(clamp01(t / SEAM_WIN)) * smooth(clamp01((LOOP - t) / SEAM_WIN));
}

function drawState(state) {
  if (state === 'complete' || state === 'active') return 'done';
  if (state === 'available') return 'avail';
  return 'dim';
}

// A node's SVG at (L, t). At L=1 with no bloom it is byte-for-byte the still's nodeMarkup.
function nodeFrame(node, palette, schedule, i, t) {
  const kind = palette.kinds[node.color] ?? palette.kinds.terracotta;
  const r = node.emphasis ? RADIUS * ROOT_SCALE : RADIUS;
  const x = num(node.x), y = num(node.y);
  const state = drawState(node.state);
  const L = litAt(schedule, i, t);
  const crown = node.emphasis ? crownMarkup(node.x, node.y, r, palette) : '';

  if (state === 'done') {
    const prog = clamp01((t - schedule.igniteAt(i)) / BLOOM);
    const bump = (L > 0.02 && prog > 0 && prog < 1) ? 0.45 * Math.exp(-(((prog - 0.55) / 0.16) ** 2)) : 0;
    let haloAlpha = L * palette.glowOp * (1 + bump * 0.55);
    let haloR = r * GLOW_R * (1 + bump * 0.25);
    if (node.emphasis) {
      const breath = 0.18 * Math.sin((t / 1200) * Math.PI) * seamWindow(t) * L * (prog >= 1 ? 1 : 0);
      haloAlpha *= (1 + breath);
      haloR *= (1 + 0.14 * breath);
    }
    const halo = `<circle cx="${x}" cy="${y}" r="${num(haloR)}" fill="rgba(${kind.rgb},${num(haloAlpha)})" filter="url(#wm-vg-blur)"/>`;
    const ring = `<circle cx="${x}" cy="${y}" r="${num(r * RING_R)}" fill="none" stroke="rgba(${kind.rgb},.55)" stroke-width="${num(r * RING_W)}" opacity="${num(L)}"/>`;
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="${kind.c}" opacity="${num(L)}"/>`;
    const spec = `<g opacity="${num(L * 0.9)}">${specular(node.x, node.y, r)}</g>`;
    const crownEl = node.emphasis ? `<g opacity="${num(L)}">${crown}</g>` : '';
    return halo + ring + disc + spec + crownEl;
  }
  if (state === 'avail') {
    let pulse = '';
    if (t >= PULSE_FROM && t <= PULSE_TO) {
      const pp = (t - PULSE_FROM) / (PULSE_TO - PULSE_FROM);
      const pa = (1 - pp) * (0.5 + 0.5 * Math.cos(pp * 4 * Math.PI - Math.PI)) * seamWindow(t) * L;
      pulse = `<circle cx="${x}" cy="${y}" r="${num(r * 1.9 * (1 + pa * 0.15))}" fill="rgba(${kind.rgb},${num(pa * 0.5)})"/>`;
    }
    const disc = `<circle cx="${x}" cy="${y}" r="${num(r)}" fill="${palette.avail}" stroke="${kind.c}" stroke-width="${num(AVAIL_STROKE)}" opacity="${num(L)}"/>`;
    return pulse + disc + (node.emphasis ? `<g opacity="${num(L)}">${crown}</g>` : '');
  }
  const disc = `<circle cx="${x}" cy="${y}" r="${num(r * LOCKED_R)}" fill="rgba(${kind.rgb},.16)" stroke="rgba(${kind.rgb},.4)" stroke-width="${num(LOCKED_STROKE)}" opacity="${num(L * 0.95)}"/>`;
  return disc + (node.emphasis ? `<g opacity="${num(L)}">${crown}</g>` : '');
}

function edgeFrame(edge, byId, indexOf, schedule, palette, t) {
  const a = byId.get(edge.from), b = byId.get(edge.to);
  if (!a || !b) return '';
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
  const cx = mx - dy * BOW, cy = my + dx * BOW;
  const lit = a.state === 'complete' || a.state === 'active';
  const stroke = lit ? palette.bark : palette.dimEdge;
  const width = lit ? LIT_EDGE : DIM_EDGE;
  const faded = edge.kind === 'cross-branch' ? 0.8 : 1;

  // The edge fades in with the node it feeds, so it never precedes its child.
  const ai = indexOf.get(edge.from), bi = indexOf.get(edge.to);
  const child = schedule.igniteAt(ai) > schedule.igniteAt(bi) ? ai : bi;
  const childL = litAt(schedule, child, t);
  const path = `<path d="M${num(a.x)} ${num(a.y)} Q${num(cx)} ${num(cy)} ${num(b.x)} ${num(b.y)}" fill="none" stroke="${stroke}" stroke-width="${num(width)}" stroke-linecap="round" opacity="${num(childL * (lit ? 0.92 : 0.75) * faded)}"/>`;

  // A travel head rides the edge into the child as it ignites, then is gone.
  let head = '';
  const tc = schedule.igniteAt(child), t0 = tc - 260;
  if (lit && t >= t0 && t <= tc) {
    const u = clamp01((t - t0) / 260) * 0.85;
    const v = 1 - u;
    const hx = v * v * a.x + 2 * v * u * cx + u * u * b.x;
    const hy = v * v * a.y + 2 * v * u * cy + u * u * b.y;
    const kind = palette.kinds[byId.get(edge.to).color] ?? palette.kinds.terracotta;
    const op = Math.sin(clamp01((t - t0) / 260) * Math.PI) * seamWindow(t);
    head = `<circle cx="${num(hx)}" cy="${num(hy)}" r="${num(RADIUS * 0.34 + 1.4)}" fill="rgba(${kind.rgb},1)" opacity="${num(op)}"/>`;
  }
  return path + head;
}

function specular(cx, cy, r) {
  const ex = num(cx - r * 0.3), ey = num(cy - r * 0.36);
  return `<ellipse cx="${ex}" cy="${ey}" rx="${num(r * 0.42)}" ry="${num(r * 0.24)}" fill="rgba(255,255,255,.4)" transform="rotate(-24 ${ex} ${ey})"/>`;
}

function crownMarkup(cx, cy, r, palette) {
  const w = r * 1.5, h = r * 0.5, base = cy - r - r * 0.15, x0 = cx - w / 2, x1 = cx + w / 2;
  const d = `M${num(x0)} ${num(base)}L${num(x0 + w * 0.16)} ${num(base - h)}L${num(x0 + w * 0.33)} ${num(base - h * 0.45)}`
    + `L${num(cx)} ${num(base - h * 1.15)}L${num(x1 - w * 0.33)} ${num(base - h * 0.45)}L${num(x1 - w * 0.16)} ${num(base - h)}L${num(x1)} ${num(base)}Z`;
  return `<path d="${d}" fill="${palette.kinds.gold.c}"/>`;
}

// Each done node contributes smooth(L) as it blooms in, so the score climbs with the rings.
function doneShownAt(model, schedule, t) {
  let shown = 0;
  model.nodes.forEach((node, i) => {
    if (drawState(node.state) === 'done') shown += smooth(litAt(schedule, i, t));
  });
  return Math.round(shown);
}

// The framed video card at time t. `w`/`h` are the frame box; everything scales off k = w/1200.
export function buildShareVideoFrameSvg({ model, title, done, total, dominantKind, t, w = 1080, h = 1080 }) {
  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;
  const k = w / 1200;
  const mat = 28 * k, rule = 6 * k, strip = 96 * k * (h / w < 0.7 ? 0.86 : 1);
  const panelRadius = 18 * k, panelBorder = 1.5 * k, pad = 46 * k;
  const panelX = mat, panelY = rule + mat;
  const panelW = w - mat * 2, panelBottom = h - strip, panelH = panelBottom - panelY;

  const schedule = buildSchedule(model);
  const indexOf = schedule.index;
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const box = clampViewBox(paddedGlowBox(model), panelW / 2.2, panelH / 2.2);
  const vb = `${num(box.minX)} ${num(box.minY)} ${num(box.width)} ${num(box.height)}`;

  const edges = model.edges.map((e) => edgeFrame(e, byId, indexOf, schedule, pal, t)).join('');
  const nodes = model.nodes.map((n, i) => nodeFrame(n, pal, schedule, i, t)).join('');
  const portrait = `<svg x="${num(panelX)}" y="${num(panelY)}" width="${num(panelW)}" height="${num(panelH)}"`
    + ` viewBox="${vb}" preserveAspectRatio="xMidYMid meet" overflow="hidden">`
    + `<defs><filter id="wm-vg-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${num(BLUR_STD)}"/></filter></defs>`
    + `<g>${edges}</g><g>${nodes}</g></svg>`;

  const shownDone = doneShownAt(model, schedule, t);
  const fraction = total > 0 ? Math.min(1, shownDone / total) : 0;

  // strip layout (k-scaled): kind dot + title, then the readout + bar, wordmark right.
  const dotR = 5.5 * k, titleFont = 30 * k, readFont = 15 * k, markFont = 20 * k, subFont = 13 * k;
  const stripTop = h - strip, cy1 = stripTop + strip * 0.38, cy2 = stripTop + strip * 0.68;
  const maxTitle = Math.max(8, Math.floor((w - pad * 2 - 320 * k) / (titleFont * 0.5)));
  const shownTitle = escapeXml(ellipsize(title || 'Untitled roadmap', maxTitle));
  const barX = pad + 150 * k, barW = 130 * k, barH = 8 * k, barY = cy2 - barH / 2;
  const gradId = 'wm-vg-score';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${pal.gradA}"/><stop offset="1" stop-color="${pal.gradB}"/></linearGradient></defs>`
    + `<rect x="0" y="0" width="${w}" height="${h}" fill="${pal.mat}"/>`
    + `<rect x="${num(panelX)}" y="${num(panelY)}" width="${num(panelW)}" height="${num(panelH)}" rx="${num(panelRadius)}" fill="${pal.panel}"/>`
    + `<clipPath id="wm-vg-clip"><rect x="${num(panelX)}" y="${num(panelY)}" width="${num(panelW)}" height="${num(panelH)}" rx="${num(panelRadius)}"/></clipPath>`
    + `<g clip-path="url(#wm-vg-clip)">${portrait}</g>`
    + `<rect x="${num(panelX)}" y="${num(panelY)}" width="${num(panelW)}" height="${num(panelH)}" rx="${num(panelRadius)}" fill="none" stroke="${hue.soft}" stroke-width="${num(panelBorder)}"/>`
    + `<rect x="0" y="0" width="${w}" height="${num(rule)}" fill="${hue.c}"/>`
    + `<circle cx="${num(pad + dotR)}" cy="${num(cy1)}" r="${num(dotR)}" fill="${hue.c}"/>`
    + `<text x="${num(pad + dotR * 2 + 11 * k)}" y="${num(cy1 + titleFont * 0.34)}" font-family="${DISPLAY}" font-weight="700" font-size="${num(titleFont)}" fill="${pal.text}">${shownTitle}</text>`
    + `<text x="${num(pad)}" y="${num(cy2 + readFont * 0.34)}" font-family="${MONO}" font-weight="600" font-size="${num(readFont)}" fill="${pal.text}">${shownDone}/${total}</text>`
    + `<rect x="${num(barX)}" y="${num(barY)}" width="${num(barW)}" height="${num(barH)}" rx="${num(barH / 2)}" fill="${pal.track}"/>`
    + `<rect x="${num(barX)}" y="${num(barY)}" width="${num(barW * fraction)}" height="${num(barH)}" rx="${num(barH / 2)}" fill="url(#${gradId})"/>`
    + `<text x="${num(w - pad)}" y="${num(cy1 + markFont * 0.34)}" text-anchor="end" font-family="${DISPLAY}" font-weight="600" font-size="${num(subFont * 1.15)}" fill="${pal.sub}">`
    + `Made with <tspan fill="${pal.kinds.terracotta.c}" font-weight="800" font-size="${num(markFont)}">Windmill</tspan></text>`
    + '</svg>';
}

function ellipsize(text, maxChars) {
  const clean = (text ?? '').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'));
}
