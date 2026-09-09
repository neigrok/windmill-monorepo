// Concrete colour values the WebGL scene needs; it cannot read CSS custom properties. The module
// constants are the LIGHT set; `sceneTheme(isDark)` hands the scene the set for the room it sits in.
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

// The same four faces for the DOM, as the --kind-* tokens colors.css declares for both hours, so a
// swatch, chip or dot follows the room's theme the way the scene does. Same shape as NODE_COLORS.
export const KIND_CSS = Object.fromEntries(NODE_COLOR_NAMES.map((name) => [name, {
  base: `var(--kind-${name})`,
  ring: `var(--kind-${name}-ring)`,
  soft: `var(--kind-${name}-soft)`,
  glow: `var(--kind-${name}-glow)`,
}]));

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

// CHIP is the inline-styled pill (hover name, arrival chevron): dark on the light canvas, light on the night one.
export const CHIP = { bg: '#2A231A', ink: '#F4EFE6' };

const NIGHT_NODE_COLORS = {
  terracotta: { base: '#D98B5F', ring: '#E2A887', soft: '#30221B', glow: 'rgba(221,151,111,0.50)' },
  olive:      { base: '#9DAF5C', ring: '#B6C385', soft: '#25291A', glow: 'rgba(167,183,108,0.50)' },
  gold:       { base: '#D9AE45', ring: '#E2C274', soft: '#302816', glow: 'rgba(221,182,88,0.50)' },
  brick:      { base: '#C86B50', ring: '#D6907C', soft: '#2D1C18', glow: 'rgba(206,122,98,0.50)' },
  sky:        { base: '#7BA6B8', ring: '#9CBCCA', soft: '#1F272B', glow: 'rgba(136,175,191,0.50)' },
  plum:       { base: '#B06FA6', ring: '#C493BC', soft: '#291D28', glow: 'rgba(184,125,175,0.50)' },
};

const LIGHT_SCENE = {
  BACKGROUND,
  CONNECTOR: { ...CONNECTOR, active: '#B29F7B' },
  BARK,
  BARK_CREAM,
  NODE_COLORS,
  CHIP,
};

const NIGHT_SCENE = {
  BACKGROUND: { canvas: '#0B0B0C', glow: '#141416' },
  CONNECTOR: { inactive: '#2E2E32', active: '#7E7C77' },
  BARK: '#6E5D49',
  BARK_CREAM: '#D9C7A6',
  NODE_COLORS: NIGHT_NODE_COLORS,
  CHIP: { bg: '#F2F0EB', ink: '#0B0B0C' },
};

export function sceneTheme(isDark) {
  return isDark ? NIGHT_SCENE : LIGHT_SCENE;
}

// The scene follows the nearest themed ancestor, so a room that pins its own data-theme wins over the html attribute.
export function isNightFor(element) {
  const themed = element.closest('[data-theme]');
  return !!themed && themed.getAttribute('data-theme') === 'dark';
}

export const NODE_SIZE = 56; // world units; matches SkillNode default diameter

// The body disc fills this share of NODE_SIZE (the shader's EDGE); a crowned root's body is ROOT_BODY_SCALE times wider.
export const BODY_FRACTION = 0.84;
export const ROOT_BODY_SCALE = 1.55;
export const BODY_WU = NODE_SIZE * BODY_FRACTION;

// The zoom at which an ordinary body is 52 CSS px across — the desktop working view every focus floors at and every fit caps at.
export const WORKING_ZOOM = 52 / BODY_WU;
// The phone's working view: the same body at 40 px.
export const PHONE_WORKING_ZOOM = 0.85;
// A body never draws narrower than this many screen px at any zoom; the crowned root keeps a taller floor.
export const MIN_BODY_PX = 6;
export const MIN_ROOT_BODY_PX = 9;

// Captions are fixed-size DOM text under the disc, never scaled by zoom: 14 px Nunito 700 on a 20 px line, at most two
// lines inside 168 px (160 px of text plus 4 px each side), starting 8 px below the rim. The layout reserves the same box
// through model/footprint.js, so a caption and its seat agree on every device.
export const CAPTION = { fontPx: 14, linePx: 20, maxWidthPx: 168, padPx: 4, gapPx: 8, maxLines: 2, charPx: 6.65 };
