// Light or dark for the whole web surface: a device preference in localStorage that never travels.
// One module-level store — every subscriber sees a switch the moment it is made, in this tab or
// another. A room that pins its own theme ignores it.

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

// ---- The browser's own chrome ----
// Tells the address bar and the form controls the ground <html> now wears, the way
// scripts/appBoot.js does before any module runs: each meta keeps what it first replaced in
// `data-was`, so `restoreBrowserChrome` can hand it back when the frame that painted it unmounts.
// Returns the ground it read.
export function paintBrowserChrome(theme) {
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim();
  for (const [name, value] of [['theme-color', ground], ['color-scheme', theme]]) {
    const meta = document.querySelector(`meta[name="${name}"]`);
    if (!meta || !value) continue;
    if (!meta.dataset.was) meta.setAttribute('data-was', meta.getAttribute('content'));
    meta.setAttribute('content', value);
  }
  return ground;
}

export function restoreBrowserChrome() {
  for (const name of ['theme-color', 'color-scheme']) {
    const meta = document.querySelector(`meta[name="${name}"]`);
    if (meta?.dataset.was) meta.setAttribute('content', meta.dataset.was);
  }
}

// ---- The store ----
// `snapshot` is replaced, never mutated, so useSyncExternalStore sees one identity per state.
let choice = readAppearance();
let system = systemAppearance();
let snapshot = { choice, resolved: resolveAppearance(choice, system) };
const listeners = new Set();
let stopWatching = null;

function publish() {
  snapshot = { choice, resolved: resolveAppearance(choice, system) };
  for (const listener of listeners) listener();
}

export function getAppearance() {
  return snapshot;
}

export function setAppearance(next) {
  if (!CHOICES.includes(next) || next === choice) return;
  writeAppearance(next);
  choice = next;
  publish();
}

// Watches the device and the other tabs only while somebody is listening.
export function subscribeAppearance(listener) {
  listeners.add(listener);
  if (listeners.size === 1) stopWatching = watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { stopWatching?.(); stopWatching = null; }
  };
}

function watch() {
  const unwatchSystem = watchSystemAppearance((next) => { system = next; publish(); });
  if (typeof window === 'undefined') return unwatchSystem;
  const onStorage = (event) => {
    if (event.key !== null && event.key !== KEY) return;
    const stored = readAppearance();
    if (stored === choice) return;
    choice = stored;
    publish();
  };
  window.addEventListener('storage', onStorage);
  return () => { unwatchSystem(); window.removeEventListener('storage', onStorage); };
}
