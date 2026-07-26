// The palette for everything that leaves the app (X2 share identity). Light is
// the design system 1:1 — kinds are pulled straight from theme.js (→ tokens/
// colors.css), so an exported tree can never drift from the in-app tree. Dark is
// the export-only night skin the live renderer doesn't have. Per theme: chrome
// colors (mat/panel/edge/track/brand/grad*) drive the frame; per-kind {c,rgb,soft}
// drive the tree portrait — c = fill, rgb = glow, soft = panel edge / dim wash.

import { NODE_COLORS, NODE_COLOR_NAMES } from '../theme.js';

export const KIND_ORDER = NODE_COLOR_NAMES; // terracotta olive gold brick sky plum
export const SHARE_THEMES = ['light', 'dark'];

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function kindsFrom(source) {
  const out = {};
  for (const name of KIND_ORDER) {
    const { c, soft } = source[name];
    out[name] = { c, rgb: rgbOf(c), soft };
  }
  return out;
}

const LIGHT_KINDS = {};
for (const name of KIND_ORDER) LIGHT_KINDS[name] = { c: NODE_COLORS[name].base, soft: NODE_COLORS[name].soft };

const DARK_KINDS = {
  terracotta: { c: '#D08A5E', soft: '#7C3F23' },
  olive:      { c: '#9AA859', soft: '#616E33' },
  gold:       { c: '#D9B04C', soft: '#A17822' },
  brick:      { c: '#BF6A50', soft: '#8A3A26' },
  sky:        { c: '#7FA0AE', soft: '#4A6875' },
  plum:       { c: '#A8699E', soft: '#6F3B67' },
};

export const SHARE_PALETTE = {
  light: {
    mat: '#FFFFFF', panel: '#F9F5EB', edge: '#E5D9C0',
    text: '#211B13', sub: '#6F5F45', tert: '#92805F',
    track: '#E5D9C0', bark: '#9C6B44', dimEdge: '#D3C2A0',
    brand: '#BC6C42', gradA: '#BC6C42', gradB: '#C4972F',
    avail: '#FFFFFF', glowOp: 0.42, shadow: '0 4px 18px rgba(33,27,19,.14)',
    kinds: kindsFrom(LIGHT_KINDS),
  },
  dark: {
    mat: '#17120B', panel: '#0D0B07', edge: '#2E2618',
    text: '#F4EEDF', sub: '#AE9A75', tert: '#8A785A',
    track: '#2E2618', bark: '#C07C43', dimEdge: '#3C3223',
    brand: '#D08A5E', gradA: '#D08A5E', gradB: '#D9B04C',
    avail: '#10120C', glowOp: 0.62, shadow: '0 4px 18px rgba(0,0,0,.45)',
    kinds: kindsFrom(DARK_KINDS),
  },
};
