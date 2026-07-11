// The shared frame recipe (X2 spec) — one set of numbers so the PNG (#8), the OG
// card (#7), the gallery thumb (#12) and the GIF (#14) can't drift. It's pure
// geometry: given a size + theme + dominant kind + stats it resolves every rect,
// hue and type size. Everything scales off k = w/1200, so proportions hold at any
// export size. Renderers (the Canvas2D exporter, the DOM preview, the gallery card)
// read this recipe and paint it; no rendering or I/O lives here.

import { SHARE_PALETTE } from './palette.js';

// One recipe, four export geometries. `square` marks the landscape sizes whose
// center 1:1 crop (a Reddit thumb) must still read as Windmill — the mat runs full
// height so the crop keeps the rule and the identity strip.
export const SHARE_SIZES = [
  { id: 'og',     label: 'OG / unfurl', w: 1200, h: 630,  square: true },
  { id: 'feed',   label: 'Feed wide',   w: 1600, h: 900,  square: true },
  { id: 'square', label: 'Square',      w: 1080, h: 1080, square: false },
  { id: 'gif',    label: 'GIF',         w: 960,  h: 540,  square: true },
];

export function shareSize(id) {
  return SHARE_SIZES.find((size) => size.id === id) ?? SHARE_SIZES[0];
}

export class ShareFrame {
  constructor({ w = 1200, h = 630, theme = 'light', kind = 'terracotta', variant = 'mat', stats = null, title = '' }) {
    this.w = w;
    this.h = h;
    this.theme = theme;
    this.kind = kind;
    this.variant = variant; // 'mat' (postcard export) | 'intro' (GIF title card)
    this.stats = stats;
    this.title = title;
    this.k = w / 1200;
    this.palette = SHARE_PALETTE[theme];
    this.hue = this.palette.kinds[kind];
  }

  // Frame chrome dimensions — the mat border, the kind rule, the identity strip,
  // its inner padding, and the 4% safe inset all type must sit inside.
  get rule()  { return 6 * this.k; }
  get mat()   { return 28 * this.k; }
  get strip() { return 96 * this.k; }
  get pad()   { return 46 * this.k; }
  get inset() { return 48 * this.k; }

  // The cream canvas the tree portrait fills. The mat variant insets it behind a
  // rounded, kind-edged panel; the intro title card has no canvas.
  panelRect() {
    const side = this.mat;
    const top = this.rule + this.mat;
    return { x: side, y: top, w: this.w - side * 2, h: this.h - top - this.strip };
  }

  panelRadius() { return 18 * this.k; }
  panelBorder() { return { width: 1.5 * this.k, color: this.theme === 'light' ? this.hue.soft : this.palette.edge }; }

  // Type sizes and the strip's metering widgets, all off k so nothing drops below
  // ~14px at final size (spec S2 · TYPE).
  type() {
    const k = this.k;
    return {
      title: 30 * k,
      count: 15 * k,
      label: 13 * k,
      wordmark: 20 * k,
      madeWith: 15 * k,
      dot: 11 * k,
      barW: 130 * k,
      barH: 8 * k,
    };
  }

  // Center point + sizes for the GIF title card (no tree, just wordmark + title).
  introLayout() {
    const k = this.k;
    return { cx: this.w / 2, cy: this.h / 2, dot: 15 * k, wordmark: 52 * k, title: 18 * k, gap: 14 * k };
  }

  // The center 1:1 square a landscape crop keeps — must contain the root + most
  // lit nodes. Null for already-square exports.
  cropSquare() {
    if (this.w <= this.h) return null;
    const size = this.h;
    return { x: (this.w - size) / 2, y: 0, w: size, h: size };
  }
}
