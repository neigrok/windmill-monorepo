// Design tokens the WebGL scene needs as concrete values — WebGL can't read CSS
// custom properties. These are pulled from the Windmill design system
// (tokens/colors.css `--kind-*` + the dag-clean-colors exploration) so the GPU
// look matches it 1:1.
//
// A node's look is two orthogonal things:
//   • color — the node's *kind* (a category). Picks the hue: `base` (accent-500)
//     is the flat fill, `ring` (accent-600) the border, `soft` (accent-200) the
//     glyph, `glow` the halo.
//   • state — one of four tiers in the tree (design: dag-clean-colors):
//       unavailable → the same hue at low opacity, no glow (locked)
//       available   → saturated fill + ring, no resting glow (glow on hover)
//       inprogress  → available's fill + ring + a soft glow breathing at half the crown
//       activated   → same + an outer ring + a breathing halo

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

// The tree's four visual tiers. Indices are what the shaders receive; higher = more
// progress, so a state diff reads growth as a rise in tier. In-progress ("ember") is a
// third calm read between available and complete — not a re-hue and not a fourth read.
export const NODE_TIERS = ['unavailable', 'available', 'inprogress', 'activated'];
export const TIER_LOCKED = 0;
export const TIER_AVAILABLE = 1;
export const TIER_EMBER = 2;
export const TIER_COMPLETE = 3;
export function nodeTier(state) {
  if (state === 'complete') return TIER_COMPLETE; // activated — earned
  if (state === 'active') return TIER_EMBER;      // in-progress — kindled, not yet earned
  if (state === 'available') return TIER_AVAILABLE;
  return TIER_LOCKED; // locked → unavailable
}

// A node's structural *form*, orthogonal to its tier — a dashed ring the editing
// gestures reveal. `bud` is a just-born, still-unnamed tip (grows a name/edges);
// `unlinked` is a stray with neither parents nor children (a leaf whose last
// branch was cut) that wants re-attaching. Authored nodes are always `linked`.
export const NODE_FORMS = ['linked', 'bud', 'unlinked'];
export function nodeForm(label, parentCount, childCount) {
  if (parentCount === 0 && childCount === 0) return 2; // unlinked — a detached stray
  if (!label || label.trim() === '') return 1; // bud — created but not yet named
  return 0; // linked
}

// An edge grows once its source is complete (the dependency is satisfied).
export function isDone(state) {
  return state === 'complete';
}

export const CONNECTOR = { inactive: '#D3C2A0' };

export const LEAF = { light: '#9AA859', vein: '#616E33' };

export const BACKGROUND = {
  canvas: '#F9F5EB',
  glow:   '#F3F4E4',
};

export const NODE_SIZE = 56; // world units; matches SkillNode default diameter
