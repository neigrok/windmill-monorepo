// The progress card (design brief #20, "repeat-share-surface") — the RECURRING post, sibling to
// the unfurl card in ogCard.js. Same postcard: 1200×630 at @2x, the same mat / rule / cream panel
// / bottom strip, the same glow-inclusive fit, light only. It is the same object with a different
// strip, not a lookalike, so it imports the recipe rather than copying it.
//
// What makes the two tell apart across a room — the real requirement, because feed thumbnails are
// small — is the portrait. The milestone card is the whole tree lit with one crowned thing: a
// moment. This one veils the settled tree back to a ghost and burns ONLY what lit since the last
// share. New brightness on a dim tree versus one bright thing on a lit one.
//
// The strip's headline is the count, and it says "since I last shared" — never "this week".
// completedAt is stamped only for completions made in this browser, and the server's progress API
// returns no timestamps at all, so a weekly framing would be a decorative lie. The share ledger's
// id-diff needs no clock and stays true for someone who posts fortnightly. "Update #N" is the
// ordinal from our own share history — a counter is what makes a series read as a series — and
// never a faked "day 47", because we cannot know their day one.

import { SHARE_PALETTE } from './palette.js';
import { treePortraitSvg } from './TreePortrait.js';
import { POSTCARD, paddedGlowBox, clampViewBox, ellipsize, escapeXml } from './ogCard.js';

const GHOST = 0.28;             // what the settled tree drops to behind the newly-lit steps

const CHIP_PAD_X = 22;          // the "Update #N" chip's breathing room around its numerals
const CHIP_RISE = 31;           // chip top above the readout baseline …
const CHIP_DROP = 8;            // … and its bottom below it — the sum stays inside the 4% safe line
const MONO_ADVANCE = 0.6;       // JetBrains Mono's em advance, for sizing the chip to its text
const DISPLAY_ADVANCE = 0.5;    // Baloo's rough em advance, for the title's ellipsis guard

// The card. `lit` is the set of steps newly complete since the last share — it drives the veil
// AND the headline, so an empty one has nothing to say and is refused rather than dressed up as
// a post claiming nothing happened. `update` is the share ordinal this post will carry.
export function buildProgressCardSvg({ model, title, done, total, dominantKind, lit, update }) {
  if (!lit?.size) throw new Error('progress card needs at least one step lit since the last share');

  const pal = SHARE_PALETTE.light;
  const hue = pal.kinds[dominantKind] ?? pal.kinds.terracotta;
  const {
    W, H, PAD, RULE, MAX_FIT_SCALE,
    PANEL_X, PANEL_Y, PANEL_W, PANEL_H, PANEL_BOTTOM, PANEL_RADIUS, PANEL_BORDER,
    TITLE_FONT, READOUT_FONT, MARK_FONT, DISPLAY, MONO,
  } = POSTCARD;

  const box = clampViewBox(paddedGlowBox(model), PANEL_W / MAX_FIT_SCALE, PANEL_H / MAX_FIT_SCALE);
  const portrait = treePortraitSvg(model, pal, { w: PANEL_W, h: PANEL_H }, box, { highlight: lit, dim: GHOST });

  const contentL = PAD;
  const contentR = W - PAD;
  const headlineBaseline = PANEL_BOTTOM + 48;
  const readoutBaseline = PANEL_BOTTOM + 88;

  // The news, in the poster's own voice — the card is a post they make, so it speaks first person
  // where the toast that offered it speaks to them.
  const headline = `${lit.size} step${lit.size === 1 ? '' : 's'} since I last shared`;

  const barX = contentL + 150;
  const barW = 600;
  const barH = 18;
  const barY = readoutBaseline - barH - 4;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;

  const chipLabel = `Update #${update}`;
  const chipW = Math.round(chipLabel.length * READOUT_FONT * MONO_ADVANCE + CHIP_PAD_X * 2);
  const chipX = contentR - chipW;
  const chipY = readoutBaseline - CHIP_RISE;
  const chipH = CHIP_RISE + CHIP_DROP;

  // The roadmap's name is demoted to the readout register — the count is the headline here — and
  // sits between the score bar and the chip, cut to whatever gap the two leave it.
  const titleX = barX + barW + 44;
  const maxTitleChars = Math.max(8, Math.floor((chipX - 32 - titleX) / (READOUT_FONT * DISPLAY_ADVANCE)));
  const shownTitle = escapeXml(ellipsize(title || 'Untitled roadmap', maxTitleChars));

  const arrowW = 30;                 // the drawn "→" after the wordmark
  const arrowY = headlineBaseline - Math.round(MARK_FONT * 0.28);
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

    + `<circle cx="${contentL + 13}" cy="${headlineBaseline - 19}" r="13" fill="${hue.c}"/>`
    + `<text x="${contentL + 42}" y="${headlineBaseline}" font-family="${DISPLAY}" font-weight="700" font-size="${TITLE_FONT}" fill="${pal.text}">${headline}</text>`

    + `<text x="${contentL}" y="${readoutBaseline}" font-family="${MONO}" font-weight="600" font-size="${READOUT_FONT}" fill="${pal.sub}">${done}/${total}</text>`
    + `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${pal.track}"/>`
    + `<rect x="${barX}" y="${barY}" width="${Math.round(barW * fraction)}" height="${barH}" rx="${barH / 2}" fill="url(#${gradId})"/>`
    + `<text x="${titleX}" y="${readoutBaseline}" font-family="${DISPLAY}" font-weight="600" font-size="${READOUT_FONT}" fill="${pal.sub}">${shownTitle}</text>`

    + `<rect x="${chipX}" y="${chipY}" width="${chipW}" height="${chipH}" rx="${chipH / 2}" fill="${hue.soft}"/>`
    + `<text x="${chipX + chipW / 2}" y="${readoutBaseline}" text-anchor="middle" font-family="${MONO}" font-weight="600" font-size="${READOUT_FONT}" fill="${pal.text}">${chipLabel}</text>`

    + `<text x="${wordsEnd}" y="${headlineBaseline}" text-anchor="end" font-family="${DISPLAY}" font-weight="600" font-size="${MARK_FONT}" fill="${pal.sub}">`
    + `Made with <tspan fill="${pal.kinds.terracotta.c}" font-weight="700">Windmill</tspan></text>`
    // Drawn, not typed — the latin woff2 subset we embed may lack U+2192, so a shaft + chevron
    // keeps the mark intact whatever the font covers (same reasoning as the OG card).
    + `<path d="M${contentR - arrowW} ${arrowY} H${contentR} M${contentR - 13} ${arrowY - 9} L${contentR} ${arrowY} L${contentR - 13} ${arrowY + 9}" fill="none" stroke="${pal.sub}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`

    + '</svg>';
}
