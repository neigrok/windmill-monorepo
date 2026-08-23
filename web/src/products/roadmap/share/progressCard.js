// The recurring post, sibling to the unfurl card in ogCard.js: the same postcard, mat, rule, panel
// and watermark, light only. The fit is measured as if the whole tree were lit, so the frame holds
// still across a series; only what lit this period wears the in-app look, and the edge into each
// new step is drawn in that step's own kind. The hue comes from the dominant kind among `lit`, and
// tints the rule, chip, stamp and current tick.

import { SHARE_PALETTE } from './palette.js';
import { ShareStats } from './ShareStats.js';
import { treePortraitSvg } from './TreePortrait.js';
import { POSTCARD, paddedGlowBox, clampViewBox, ellipsize, escapeXml } from './ogCard.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';

const {
  W, H, K, PAD, RULE, MAX_FIT_SCALE,
  PANEL_X, PANEL_Y, PANEL_W, PANEL_RADIUS, PANEL_BORDER,
  MARK_FONT, DISPLAY, MONO,
} = POSTCARD;

const STRIP = 120 * K;                  // 240
const PANEL_BOTTOM = H - STRIP;         // 1020
const PANEL_H = PANEL_BOTTOM - PANEL_Y; // 964

const STAMP = 76 * K;                   // 152 square, the strip's lead
const STAMP_RADIUS = 20 * K;            // 40
const STAMP_FONT = 34 * K;              // 68
const GUTTER = 24 * K;                  // 48

const CHIP_FONT = 12 * K;               // 24
const CHIP_TRACK = 0.1;                 // .1em
const CHIP_H = 20 * K;                  // 40
const CHIP_PAD_X = 13 * K;              // 26
const TITLE_FONT = 27 * K;              // 54
const SCORE_FONT = 15 * K;              // 30
const LABEL_FONT = 14 * K;              // 28
const BAR_W = 110 * K;                  // 220
const BAR_H = 9 * K;                    // 18

// One tick per elapsed period; a quiet period draws the floor tick, a huge one is capped.
const TICKS = 6;
const TICK_W = 6 * K;                   // 12
const TICK_GAP = 5 * K;                 // 10
const TICK_FLOOR = 6 * K;               // 12 — a quiet period reads as a dot
const TICK_PER_STEP = 4 * K;            // 8
const TICK_CAP = 30 * K;                // 60

const MONO_ADVANCE = 0.6;               // JetBrains Mono's em advance, for sizing the chip to its text
const DISPLAY_ADVANCE = 0.5;            // Baloo's rough em advance, for the title's ellipsis guard

// `lit` is the set of steps that lit this period and drives the ink, the stamp and the hue; an
// empty one is refused. `period` names this period on the chip, `since` names the period the last
// card covered when one was skipped, and `ledger` holds the deltas of the periods before this one,
// oldest first — the card appends its own; null draws no ledger.
export function buildProgressCardSvg({ model, title, done, total, lit, period, since = null, ledger = [] }) {
  if (!lit?.size) throw new Error('progress card needs at least one step lit this period');

  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[periodKind(model, lit)] ?? pal.kinds.terracotta;

  const box = clampViewBox(paddedGlowBox(model, { steady: true }), PANEL_W / MAX_FIT_SCALE, PANEL_H / MAX_FIT_SCALE);
  const portrait = treePortraitSvg(model, pal, { w: PANEL_W, h: PANEL_H }, box, { lit });

  const contentL = PAD;
  const contentR = W - PAD;
  const stampY = PANEL_BOTTOM + (STRIP - STAMP) / 2;  // the stamp centers the strip
  const rowsX = contentL + STAMP + GUTTER;            // the two rows sit clear of it
  const row1 = stampY + 32 * K;                       // the period chip and the title
  const row2 = stampY + 62 * K;                       // the score, its label and the watermark

  // The ledger is measured first: it claims the strip's right end, the title takes what is left.
  const deltas = ledger === null ? [] : [...ledger, lit.size].slice(-TICKS);
  const ledgerW = deltas.length === 0 ? 0 : deltas.length * TICK_W + (deltas.length - 1) * TICK_GAP;
  const ledgerX = contentR - ledgerW;
  const ticks = deltas.map((delta, i) => {
    const height = Math.min(TICK_CAP, TICK_FLOOR + Math.max(0, delta) * TICK_PER_STEP);
    const fill = i === deltas.length - 1 ? hue.c : pal.track;
    return `<rect x="${ledgerX + i * (TICK_W + TICK_GAP)}" y="${row1 - height}" width="${TICK_W}" height="${height}" rx="${TICK_W / 2}" fill="${fill}"/>`;
  }).join('');

  const label = (period ?? '').trim();
  const chipW = label ? Math.round(label.length * CHIP_FONT * (MONO_ADVANCE + CHIP_TRACK) + CHIP_PAD_X * 2) : 0;
  const chipY = row1 - 10 * K - CHIP_H / 2;           // centered on the title's optical middle
  const chip = label
    ? `<rect x="${rowsX}" y="${chipY}" width="${chipW}" height="${CHIP_H}" rx="${CHIP_H / 2}" fill="rgba(${hue.rgb},.16)"/>`
      + `<text x="${rowsX + chipW / 2}" y="${chipY + CHIP_H / 2 + 4 * K}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="${CHIP_FONT}" letter-spacing="${CHIP_FONT * CHIP_TRACK}" fill="${hue.c}">${escapeXml(label)}</text>`
    : '';

  const titleX = rowsX + (chipW ? chipW + GUTTER : 0);
  const maxTitleChars = Math.max(8, Math.floor((ledgerX - GUTTER - titleX) / (TITLE_FONT * DISPLAY_ADVANCE)));
  const shownTitle = escapeXml(ellipsize(title || 'Untitled roadmap', maxTitleChars));

  const barX = rowsX + 75 * K;
  const barY = row2 - BAR_H - 4;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;

  const arrowW = 30;                 // the drawn "→" after the wordmark
  const arrowY = row2 - Math.round(MARK_FONT * 0.28);
  const wordsEnd = contentR - arrowW - 16;

  const clipId = 'wm-progress-panel';
  const gradId = 'wm-progress-score';

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

    + `<rect x="${contentL}" y="${stampY}" width="${STAMP}" height="${STAMP}" rx="${STAMP_RADIUS}" fill="${hue.soft}"/>`
    + `<text x="${contentL + STAMP / 2}" y="${stampY + STAMP / 2 + 12 * K}" text-anchor="middle" font-family="${DISPLAY}" font-weight="700" font-size="${STAMP_FONT}" fill="${hue.c}">+${lit.size}</text>`

    + chip
    + `<text x="${titleX}" y="${row1}" font-family="${DISPLAY}" font-weight="700" font-size="${TITLE_FONT}" fill="${pal.text}">${shownTitle}</text>`

    + `<text x="${rowsX}" y="${row2}" font-family="${MONO}" font-weight="600" font-size="${SCORE_FONT}" fill="${pal.sub}">${done}/${total}</text>`
    + `<rect x="${barX}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${pal.track}"/>`
    + `<rect x="${barX}" y="${barY}" width="${Math.round(BAR_W * fraction)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="url(#${gradId})"/>`
    + `<text x="${barX + BAR_W + GUTTER / 2}" y="${row2}" font-family="${DISPLAY}" font-weight="600" font-size="${LABEL_FONT}" fill="${pal.tert}">${escapeXml(since ? `steps done · since ${since}` : 'steps done')}</text>`

    + ticks
    + `<text x="${wordsEnd}" y="${row2}" text-anchor="end" font-family="${DISPLAY}" font-weight="600" font-size="${MARK_FONT}" fill="${pal.sub}">`
    + `Made with <tspan fill="${pal.kinds.terracotta.c}" font-weight="700">Windmill</tspan></text>`
    // Drawn, not typed: the embedded latin woff2 subset may lack U+2192.
    + `<path d="M${contentR - arrowW} ${arrowY} H${contentR} M${contentR - 13} ${arrowY - 9} L${contentR} ${arrowY} L${contentR - 13} ${arrowY + 9}" fill="none" stroke="${pal.sub}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`

    + '</svg>';
}

// The dominant kind among the steps that lit this period, with ShareStats' tie-break.
function periodKind(model, lit) {
  const tally = new Map();
  for (const node of model.nodes) {
    if (!lit.has(node.id)) continue;
    const kind = node.color ?? DEFAULT_NODE_COLOR;
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  return ShareStats.dominant(tally);
}
