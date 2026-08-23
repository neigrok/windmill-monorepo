// Concrete token values the WebGL scene needs; it cannot read CSS custom properties.
// Per hue: base = fill, ring = border, soft = glyph, glow = halo.

export const NODE_COLORS = {
  terracotta: { base: '#BC6C42', ring: '#9D5330', soft: '#EAC6B0', glow: 'rgba(188,108,66,0.50)' },
  olive:      { base: '#7D8C43', ring: '#616E33', soft: '#D2DAA5', glow: 'rgba(125,140,67,0.50)' },
  gold:       { base: '#C4972F', ring: '#A17822', soft: '#EEDA9E', glow: 'rgba(196,151,47,0.50)' },
  brick:      { base: '#A84E35', ring: '#8A3A26', soft: '#E4B6A8', glow: 'rgba(168,78,53,0.50)' },
  sky:        { base: '#5F8494', ring: '#4A6875', soft: '#C4D5DC', glow: 'rgba(95,132,148,0.50)' },
  plum:       { base: '#8D4F83', ring: '#6F3B67', soft: '#D3ABC9', glow: 'rgba(141,79,131,0.50)' },
};

export const NODE_COLOR_NAMES = Object.keys(NODE_COLORS);
export const DEFAULT_NODE_COLOR = 'terracotta';

// Tier indices are what the shaders receive; higher = more progress.
const TIER_LOCKED = 0;
const TIER_AVAILABLE = 1;
export const TIER_EMBER = 2;
export const TIER_COMPLETE = 3;
export function nodeTier(state) {
  if (state === 'complete') return TIER_COMPLETE;
  if (state === 'active') return TIER_EMBER;
  if (state === 'available') return TIER_AVAILABLE;
  return TIER_LOCKED;
}

// `bud` is a just-born, still-unnamed tip; `unlinked` is a stray with neither parents nor children.
export function nodeForm(label, parentCount, childCount) {
  if (parentCount === 0 && childCount === 0) return 2; // unlinked — a detached stray
  if (!label || label.trim() === '') return 1; // bud — created but not yet named
  return 0; // linked
}

export function isDone(state) {
  return state === 'complete';
}

export const CONNECTOR = { inactive: '#D3C2A0' };

// BARK_CREAM is the warm cream a branch brightens toward when BOTH its endpoints are in the set.
export const BARK = '#9C6B44';
export const BARK_CREAM = '#EAD8B0';

export const BACKGROUND = {
  canvas: '#F9F5EB',
  glow:   '#F3F4E4',
};

export const NODE_SIZE = 56; // world units; matches SkillNode default diameter
