// The per-tree unfurl image: a 1200×630 postcard rendered at @2x from the app's own RenderModel,
// returned as an SVG string. Everything scales off k = W/1200. Light only.

import { SHARE_PALETTE } from './palette.js';
import { treePortraitSvg, nodeGlowRadius } from './TreePortrait.js';

const W = 2400;
const H = 1260;
const K = W / 1200;             // 2 — every measure below is spec·k

const MAT = 28 * K;             // 56  postcard border on sides + top
const RULE = 6 * K;             // 12  dominant-kind bar, full width, at the very top
const STRIP = 96 * K;           // 192 bottom band
const PAD = 46 * K;             // 92  strip horizontal padding
const PANEL_RADIUS = 18 * K;    // 36
const PANEL_BORDER = 1.5 * K;   // 3

const PAD_FRAC = 0.08;          // breathing room around the tree's footprint
const MAX_FIT_SCALE = 2.2;      // the tree never scales past this

const TITLE_FONT = 30 * K;      // 60
const READOUT_FONT = 15 * K;    // 30
const MARK_FONT = 20 * K;       // 40

const DISPLAY = "'Baloo 2', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const PANEL_X = MAT;
const PANEL_Y = MAT;
const PANEL_W = W - MAT * 2;    // 2288
const PANEL_BOTTOM = H - STRIP; // 1068
const PANEL_H = PANEL_BOTTOM - PANEL_Y; // 1012

// One set of measures for every card in the family; everything here is spec·k.
export const POSTCARD = {
  W, H, K, MAT, RULE, STRIP, PAD, PANEL_RADIUS, PANEL_BORDER, MAX_FIT_SCALE,
  PANEL_X, PANEL_Y, PANEL_W, PANEL_H, PANEL_BOTTOM,
  TITLE_FONT, READOUT_FONT, MARK_FONT, DISPLAY, MONO,
};

// The world window the meet-fit centers into the panel: node positions grown by each node's glow
// footprint and padded. `{ steady: true }` measures every node as if lit, so the box depends on the
// tree's shape alone and holds still as steps complete.
export function paddedGlowBox(model, { steady = false } = {}) {
  if (model.nodes.length === 0) return { minX: -100, minY: -100, width: 200, height: 200 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    const glow = nodeGlowRadius(node, steady);
    minX = Math.min(minX, node.x - glow);
    minY = Math.min(minY, node.y - glow);
    maxX = Math.max(maxX, node.x + glow);
    maxY = Math.max(maxY, node.y + glow);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const padX = width * PAD_FRAC;
  const padY = height * PAD_FRAC;
  return { minX: minX - padX, minY: minY - padY, width: width + padX * 2, height: height + padY * 2 };
}

// Expanding a too-tight window to a floor, re-centered, caps the meet-fit's scale.
export function clampViewBox(box, minWidth, minHeight) {
  const width = Math.max(box.width, minWidth);
  const height = Math.max(box.height, minHeight);
  const centerX = box.minX + box.width / 2;
  const centerY = box.minY + box.height / 2;
  return { minX: centerX - width / 2, minY: centerY - height / 2, width, height };
}

// `dominantKind` tints only the rule, the title dot and the panel border.
export function buildOgCardSvg({ model, title, done, total, dominantKind }) {
  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;

  const box = clampViewBox(paddedGlowBox(model), PANEL_W / MAX_FIT_SCALE, PANEL_H / MAX_FIT_SCALE);
  const portrait = treePortraitSvg(model, pal, { w: PANEL_W, h: PANEL_H }, box);

  // Type sits above the 4% safe line (H − 96 = 1164) so a social crop never clips it.
  const contentL = PAD;
  const contentR = W - PAD;
  const titleBaseline = PANEL_BOTTOM + 48;
  const readoutBaseline = PANEL_BOTTOM + 88;

  const maxTitleChars = Math.max(8, Math.floor((contentR - (contentL + 42) - 480) / (TITLE_FONT * 0.5)));
  const shownTitle = escapeXml(ellipsize(title || 'Untitled roadmap', maxTitleChars));

  const barX = contentL + 150;
  const barW = 600;
  const barH = 18;
  const barY = readoutBaseline - barH - 4;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;

  const arrowW = 30;                 // the drawn "→" after the wordmark
  const arrowY = titleBaseline - Math.round(MARK_FONT * 0.28);
  const wordsEnd = contentR - arrowW - 16;

  const clipId = 'wm-og-panel';
  const gradId = 'wm-og-score';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + '<defs>'
    + `<clipPath id="${clipId}"><rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="${PANEL_RADIUS}"/></clipPath>`
    + `<linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${pal.gradA}"/><stop offset="1" stop-color="${pal.gradB}"/></linearGradient>`
    + '</defs>'

    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${pal.mat}"/>`
    + `<rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="${PANEL_RADIUS}" fill="${pal.panel}"/>`
    + `<g clip-path="url(#${clipId})"><g transform="translate(${PANEL_X} ${PANEL_Y})">${portrait}</g></g>`
    + `<rect x="${PANEL_X}" y="${PANEL_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="${PANEL_RADIUS}" fill="none" stroke="${hue.soft}" stroke-width="${PANEL_BORDER}"/>`
    + `<rect x="0" y="0" width="${W}" height="${RULE}" fill="${hue.c}"/>`

    + `<circle cx="${contentL + 13}" cy="${titleBaseline - 19}" r="13" fill="${hue.c}"/>`
    + `<text x="${contentL + 42}" y="${titleBaseline}" font-family="${DISPLAY}" font-weight="700" font-size="${TITLE_FONT}" fill="${pal.text}">${shownTitle}</text>`

    + `<text x="${contentL}" y="${readoutBaseline}" font-family="${MONO}" font-weight="600" font-size="${READOUT_FONT}" fill="${pal.sub}">${done}/${total}</text>`
    + `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${pal.track}"/>`
    + `<rect x="${barX}" y="${barY}" width="${Math.round(barW * fraction)}" height="${barH}" rx="${barH / 2}" fill="url(#${gradId})"/>`

    + `<text x="${wordsEnd}" y="${titleBaseline}" text-anchor="end" font-family="${DISPLAY}" font-weight="600" font-size="${MARK_FONT}" fill="${pal.sub}">`
    + `Made with <tspan fill="${pal.kinds.terracotta.c}" font-weight="700">Windmill</tspan></text>`
    // Drawn, not typed: the embedded latin woff2 subset may lack U+2192.
    + `<path d="M${contentR - arrowW} ${arrowY} H${contentR} M${contentR - 13} ${arrowY - 9} L${contentR} ${arrowY} L${contentR - 13} ${arrowY + 9}" fill="none" stroke="${pal.sub}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`

    + '</svg>';
}

// SVG text has no CSS ellipsis, so a too-wide title is cut to fit and tailed with one.
export function ellipsize(text, maxChars) {
  const clean = (text ?? '').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

// User text goes into markup: escape the five XML delimiters so it can never break or inject.
export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
        : ch === '>' ? '&gt;'
          : ch === '"' ? '&quot;'
            : '&#39;'
  ));
}
