// The per-tree unfurl image (design brief #12, "og-tree-cards"). A shared tree should
// unfurl as ITSELF: this builds a 1200×630 postcard — rendered at @2x (2400×1260) — from
// the app's own RenderModel, so the card the scrapers show is the tree the owner sees.
//
// Pure and DOM-free: it returns an SVG string. `rasterize.js` turns that into a PNG and
// `ogUpload.js` uploads it. Everything scales off k = W/1200 (k=2 here). Light only —
// scrapers ignore theme — so every color is a literal light value read from SHARE_PALETTE.
//
// The fit is the whole trick: the portrait's viewBox is the tree's own node positions, grown
// to include each node's glow/crown footprint and padded 8%, then clamped to a floor so a
// 3-node tree centers at a sane size instead of two dinner plates. preserveAspectRatio
// ("xMidYMid meet", inside treePortraitSvg) then centers and scales any tree to fill the
// panel with no per-tree tuning.

import { SHARE_PALETTE } from './palette.js';
import { treePortraitSvg, nodeGlowRadius } from './TreePortrait.js';

const W = 2400;
const H = 1260;
const K = W / 1200;             // 2 — every measure below is spec·k

const MAT = 28 * K;             // 56  warm-white postcard border on sides + top
const RULE = 6 * K;             // 12  dominant-kind bar, full width, at the very top
const STRIP = 96 * K;           // 192 bottom band (min 84px abs — cleared)
const PAD = 46 * K;             // 92  strip horizontal padding
const PANEL_RADIUS = 18 * K;    // 36
const PANEL_BORDER = 1.5 * K;   // 3

const PAD_FRAC = 0.08;          // 8% breathing room around the tree's footprint
const MAX_FIT_SCALE = 2.2;      // clamp: the tree never scales past this (no dinner plates)

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

// The postcard itself — one set of measures for every card in the family, so a sibling
// (progressCard.js) is the same object with a different strip rather than a lookalike that
// drifts. Everything here is spec·k; the strip's own baselines are each card's business.
export const POSTCARD = {
  W, H, K, MAT, RULE, STRIP, PAD, PANEL_RADIUS, PANEL_BORDER, MAX_FIT_SCALE,
  PANEL_X, PANEL_Y, PANEL_W, PANEL_H, PANEL_BOTTOM,
  TITLE_FONT, READOUT_FONT, MARK_FONT, DISPLAY, MONO,
};

// The tree's own node positions, grown by each node's glow/crown footprint, padded 8%. The
// meet-fit reads this as the world window it centers into the panel — so wide, tall and
// sparse trees all frame themselves without a per-tree knob.
//
// `{ steady: true }` measures every node as if it were lit. A lit node's footprint is far bigger
// than an unlit one's, so the as-drawn box SWELLS as steps complete — right for a one-off unfurl
// of the tree as it stands, fatal for a card in a series, where week 4 must sit in exactly the
// frame week 3 sat in or a feed of them flickers instead of progressing. The steady box depends
// on the tree's SHAPE alone: it holds still while the plan is worked and re-frames when the plan
// itself changes, which is the only thing that should move a frame. It is also the larger box, so
// nothing a period card draws can clip against it.
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

// The fit-scale clamp: a small tree's window is too tight, so the meet-fit would blow it up.
// Expanding the window to a floor (re-centered on the tree) caps the scale — the tree sits
// centered with empty margin instead of filling the frame. A big tree is already past the
// floor, so this is a no-op and the meet-fit fills the panel as normal.
export function clampViewBox(box, minWidth, minHeight) {
  const width = Math.max(box.width, minWidth);
  const height = Math.max(box.height, minHeight);
  const centerX = box.minX + box.width / 2;
  const centerY = box.minY + box.height / 2;
  return { minX: centerX - width / 2, minY: centerY - height / 2, width, height };
}

// Build the whole postcard: mat → rule → cream panel holding the fitted portrait → bottom
// strip (title, n/m readout + score bar, watermark). `dominantKind` (the most common kind
// among done nodes; see ShareStats) tints ONLY the rule, the title dot and the panel border.
export function buildOgCardSvg({ model, title, done, total, dominantKind }) {
  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;

  const box = clampViewBox(paddedGlowBox(model), PANEL_W / MAX_FIT_SCALE, PANEL_H / MAX_FIT_SCALE);
  const portrait = treePortraitSvg(model, pal, { w: PANEL_W, h: PANEL_H }, box);

  // Type sits in the strip's top band, above the 4% safe line (H − 96 = 1164), so a social
  // crop never clips the title or score; the lower strip is postcard margin.
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
    // The arrow is drawn, not typed — the latin woff2 subset we embed may lack U+2192, so a
    // shaft + chevron keeps the mark intact whatever the font covers.
    + `<path d="M${contentR - arrowW} ${arrowY} H${contentR} M${contentR - 13} ${arrowY - 9} L${contentR} ${arrowY} L${contentR - 13} ${arrowY + 9}" fill="none" stroke="${pal.sub}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`

    + '</svg>';
}

// One line, ellipsis-guarded — SVG text has no CSS ellipsis, so a title too wide for the
// strip is cut to fit and tailed with an ellipsis.
export function ellipsize(text, maxChars) {
  const clean = (text ?? '').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

// The tree title is user text dropped into markup — escape the five XML delimiters so a
// stray & or < can never break (or inject into) the SVG.
export function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    ch === '&' ? '&amp;'
      : ch === '<' ? '&lt;'
        : ch === '>' ? '&gt;'
          : ch === '"' ? '&quot;'
            : '&#39;'
  ));
}
