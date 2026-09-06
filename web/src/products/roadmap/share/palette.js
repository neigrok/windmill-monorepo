// The palette for everything that leaves the app. The kinds come from theme.js (light: the module
// constants; dark: the roadmap night set); the mats, inks and edges are this file's own literals.
// Per kind: c = fill, rgb = glow, soft = panel edge / dim wash (the night wash, never the ring).

import { NODE_COLORS, NODE_COLOR_NAMES, sceneTheme } from '../theme.js';

export const KIND_ORDER = NODE_COLOR_NAMES; // terracotta olive gold brick sky plum

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

const NIGHT = sceneTheme(true);
const DARK_KINDS = {};
for (const name of KIND_ORDER) DARK_KINDS[name] = { c: NIGHT.NODE_COLORS[name].base, soft: NIGHT.NODE_COLORS[name].soft };

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
    mat: '#171719', panel: NIGHT.BACKGROUND.canvas, edge: '#222224',
    text: '#F2F0EB', sub: '#B4B2AC', tert: '#7E7C77',
    track: '#222224', bark: NIGHT.BARK, dimEdge: NIGHT.CONNECTOR.inactive,
    brand: '#D08A5E', gradA: '#D08A5E', gradB: NIGHT.NODE_COLORS.gold.base,
    avail: '#050506', glowOp: 0.62, shadow: '0 4px 18px rgba(0,0,0,.45)',
    kinds: kindsFrom(DARK_KINDS),
  },
};
