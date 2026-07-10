// Design tokens the WebGL scene needs as concrete values — WebGL can't read
// CSS custom properties. These mirror src/styles/tokens/colors.css exactly, so
// the baked node atlas matches the DOM SkillNode look 1:1. If colors.css changes,
// change these too.

export const FRUIT = {
  locked:    { inner: '#E5D9C0', outer: '#D3C2A0', ring: '#D3C2A0', icon: '#B29F7B', glow: null },
  available: { inner: '#D2DAA5', outer: '#7D8C43', ring: '#7D8C43', icon: '#FFFFFF', glow: 'rgba(125,140,67,0.45)' },
  active:    { inner: '#EEDA9E', outer: '#C4972F', ring: '#C4972F', icon: '#FFFFFF', glow: 'rgba(196,151,47,0.42)' },
  complete:  { inner: '#EEDA9E', outer: '#9D5330', ring: '#9D5330', icon: '#FFFFFF', glow: 'rgba(188,108,66,0.50)' },
};

export const CONNECTOR = {
  inactive: '#D3C2A0',
  active:   '#9C6B44',
};

export const LEAF = { light: '#9AA859', vein: '#616E33' };

export const BACKGROUND = {
  canvas: '#F9F5EB',
  glow:   '#F3F4E4',
};

export const NODE_STATES = ['locked', 'available', 'active', 'complete'];

export const NODE_SIZE = 56; // world units; matches SkillNode default diameter
