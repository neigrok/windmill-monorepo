// Light or dark, chosen once for the whole app — the web half of the rule the native superapp
// follows (`guidelines/superapp-shell.md` §6). It is a DEVICE preference, not an account one: it
// lives in localStorage, it works signed out, and it never travels to another machine.
//
// Scope is the app surface (`/app` and its rooms), never the landings: the marketing family is
// warm cream by canon and a dark landing would be a different promise. A room may still PIN its own
// theme — gym's instrument skin is steel whatever this says — and a room that pins nothing follows.

const KEY = 'windmill:appearance';
const CHOICES = ['light', 'dark', 'system'];

export const APPEARANCE_CHOICES = CHOICES;

export function readAppearance() {
  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) return saved;
  } catch { /* storage unavailable — the system's answer is the honest default */ }
  return 'system';
}

export function writeAppearance(choice) {
  if (!CHOICES.includes(choice)) return;
  try { localStorage.setItem(KEY, choice); } catch { /* the choice still applies for this session */ }
}

// What the OS is asking for. Absent matchMedia (an old browser, a test) reads as light, which is
// what the app has always been.
export function systemAppearance() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// 'system' is not a third palette — it is the absence of a choice, resolved to whatever the OS says.
export function resolveAppearance(choice = readAppearance(), system = systemAppearance()) {
  return choice === 'system' ? system : choice;
}

// Watch the OS only while the choice is 'system'; an explicit light or dark must not move when the
// machine flips at sunset.
export function watchSystemAppearance(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange(query.matches ? 'dark' : 'light');
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
