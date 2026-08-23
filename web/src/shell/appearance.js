// Light or dark for the `/app` surface: a device preference in localStorage that never travels.
// A room that pins its own theme ignores it.

// scripts/appBoot.js interpolates this key into the <head> boot script; rename it in both places.
export const KEY = 'windmill:appearance';
const CHOICES = ['light', 'dark', 'system'];

export const APPEARANCE_CHOICES = CHOICES;

export function readAppearance() {
  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'system';
}

export function writeAppearance(choice) {
  if (!CHOICES.includes(choice)) return;
  try { localStorage.setItem(KEY, choice); } catch { /* the choice still applies for this session */ }
}

export function systemAppearance() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveAppearance(choice = readAppearance(), system = systemAppearance()) {
  return choice === 'system' ? system : choice;
}

export function watchSystemAppearance(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange(query.matches ? 'dark' : 'light');
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
