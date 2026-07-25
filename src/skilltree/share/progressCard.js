// The progress card (design brief #20, "repeat-share-surface") — the RECURRING post, sibling to
// the unfurl card in ogCard.js. Same postcard: 1200×630 at @2x, the same mat, rule, cream panel
// and watermark, light only. Everything but the ink, the strip and the hue is deliberately
// identical to #12, because this has to read as unmistakably the same object.
//
// Three things make it a card in a SERIES rather than a second unfurl:
//
// THE FRAME HOLDS STILL. The fit is measured as if the whole tree were lit (paddedGlowBox's steady
// box), so it depends on the plan's shape and not on progress through it. Week 4 sits in exactly
// the frame week 3 sat in; a feed of these progresses instead of flickering.
//
// THE INK IS A LADDER. Only what lit this period wears the in-app look, settled work steps back,
// and the edge INTO each new step is drawn in that step's own kind — so the portrait shows the
// ROUTE taken this period, not just the destinations. That rule carries most of the meaning.
//
// THE HUE COMES FROM THE NEW WORK. The dominant kind among `lit` (ties to terracotta, ShareStats'
// rule) tints the rule, the chip, the stamp and the current ledger tick. Two consecutive cards
// then differ by construction — the brief's "must not look like the same image twice" answered by
// the data rather than by decoration.
//
// The strip is stamp-led: the delta leads, the title follows. `period` is whatever names this
// period on the chip — the card never invents one, it prints what progressPeriod.js counted from
// the tree's planting time (or the share ordinal, when there is no planting time to count from).

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

const STRIP = 120 * K;                  // 240 — one line taller than #12's 96·k: the stamp earns it
const PANEL_BOTTOM = H - STRIP;         // 1020
const PANEL_H = PANEL_BOTTOM - PANEL_Y; // 964

const STAMP = 76 * K;                   // 152 square, the strip's lead — "+3"
const STAMP_RADIUS = 20 * K;            // 40
const STAMP_FONT = 34 * K;              // 68
const GUTTER = 24 * K;                  // 48 — the strip's one horizontal breath

const CHIP_FONT = 12 * K;               // 24
const CHIP_TRACK = 0.1;                 // .1em — the period chip's mono register
const CHIP_H = 20 * K;                  // 40
const CHIP_PAD_X = 13 * K;              // 26
const TITLE_FONT = 27 * K;              // 54 — a rung below #12's 30·k, because the stamp leads
const SCORE_FONT = 15 * K;              // 30
const LABEL_FONT = 14 * K;              // 28
const BAR_W = 110 * K;                  // 220
const BAR_H = 9 * K;                    // 18

// The ledger (#8 of canon): one tick per elapsed period, the series made visible. A quiet period
// is a floor tick — a dot, shown and never scolded — and a huge one is capped so it can't tower
// over the strip. It is also the one privacy call worth naming: it publishes the quiet weeks too.
const TICKS = 6;
const TICK_W = 6 * K;                   // 12
const TICK_GAP = 5 * K;                 // 10
const TICK_FLOOR = 6 * K;               // 12 — its own width: a quiet period reads as a dot
const TICK_PER_STEP = 4 * K;            // 8
const TICK_CAP = 30 * K;                // 60

const MONO_ADVANCE = 0.6;               // JetBrains Mono's em advance, for sizing the chip to its text
const DISPLAY_ADVANCE = 0.5;            // Baloo's rough em advance, for the title's ellipsis guard

// The card. `lit` is the set of steps that lit this period — it drives the ink, the stamp and the
// hue, so an empty one has nothing to say and is refused rather than dressed up as a post claiming
// nothing happened. `period` names this period on the chip. `since` names the period the LAST card
// covered when one was skipped, and rides the score's label ("steps done · since week 3") so a
// stamp carrying two periods' work never reads as one period's. `ledger` is the deltas of the
// periods BEFORE this one, oldest first — the card appends its own, so the current tick can never
// disagree with the stamp; `null` draws no ledger at all, the per-tree toggle's off position.
export function buildProgressCardSvg({ model, title, done, total, lit, period, since = null, ledger = [] }) {
  if (!lit?.size) throw new Error('progress card needs at least one step lit this period');

  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[periodKind(model, lit)] ?? pal.kinds.terracotta;

  const box = clampViewBox(paddedGlowBox(model, { steady: true }), PANEL_W / MAX_FIT_SCALE, PANEL_H / MAX_FIT_SCALE);
  const portrait = treePortraitSvg(model, pal, { w: PANEL_W, h: PANEL_H }, box, { lit });

  const contentL = PAD;
  const contentR = W - PAD;
  const stampY = PANEL_BOTTOM + (STRIP - STAMP) / 2;  // the stamp centers the strip …
  const rowsX = contentL + STAMP + GUTTER;            // … and the two rows sit clear of it
  const row1 = stampY + 32 * K;                       // the period chip and the title
  const row2 = stampY + 62 * K;                       // the score, its label and the watermark

  // The ledger is measured first: it claims the strip's right end, and the title takes whatever
  // is left between the chip and it.
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
    // Drawn, not typed — the latin woff2 subset we embed may lack U+2192, so a shaft + chevron
    // keeps the mark intact whatever the font covers (same reasoning as the OG card).
    + `<path d="M${contentR - arrowW} ${arrowY} H${contentR} M${contentR - 13} ${arrowY - 9} L${contentR} ${arrowY} L${contentR - 13} ${arrowY + 9}" fill="none" stroke="${pal.sub}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`

    + '</svg>';
}

// The dominant kind among the steps that lit this period. The tally is this card's — it counts
// the period, not the tree — but the tie-break is ShareStats', unchanged, so the system keeps
// exactly one rule for what a shared maximum means.
function periodKind(model, lit) {
  const tally = new Map();
  for (const node of model.nodes) {
    if (!lit.has(node.id)) continue;
    const kind = node.color ?? DEFAULT_NODE_COLOR;
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  return ShareStats.dominant(tally);
}
