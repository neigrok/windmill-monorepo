// TAP-TO-TYPE — the keypad's whole mind, with no sheet around it. One rule governs the pad:
// an invalid entry never silently reverts. Lift dropped the lifter back to the old number without
// a word; here the buffer stays, the echo turns alarm-ink, the message names the exact problem and
// teaches the format, and the empty case even names the value Cancel would keep. The only ways out
// are Set (commits) and Cancel (keeps the previous value).
//
// The pad opens on the number it was opened from, so a gesture the lifter has not made yet is
// never drawn as a mistake: the echo reads back the current value, Set and Return commit it, and
// alarm ink waits for a buffer the lifter actually put into that state. `seeded` is what makes
// that honest — the first digit starts a fresh number rather than appending to a value nobody
// typed, while ± and ⌫ edit what is there, because they are corrections and not entry.
//
// The same pad serves both numbers: in reps mode the comma and ± keys are stood down — inert, not
// absent — so the geometry a chalked thumb learned does not move between the two.

import { fmtKg } from '../log.js';
import { round } from './ladder.js';

export const MAX_BUFFER = 8;

export const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '±', '0', ','];

export const WEIGHT_HINT = 'kg  ·  comma or point both read as a decimal  ·  ± for band-assisted';
export const REPS_HINT = 'whole reps';

export function openPad(current) {
  return { text: `${current}`, seeded: true };
}

export function isKeyLive(key, mode) {
  if (mode === 'reps') return key !== ',' && key !== '±';
  return true;
}

// A key that does not fit is refused whole — never write a number the lifter did not type, and
// that includes eating the digit under their thumb to make room for a sign.
export function pressKey(pad, key, mode) {
  if (!isKeyLive(key, mode)) return pad;
  if (key === '±') {
    if (pad.text.startsWith('-')) return { text: pad.text.slice(1), seeded: false };
    if (pad.text.length >= MAX_BUFFER) return pad;
    return { text: `-${pad.text}`, seeded: false };
  }
  const held = pad.seeded ? '' : pad.text;
  if (held.length >= MAX_BUFFER) return pad;
  return { text: `${held}${key}`, seeded: false };
}

export function backspace(pad) {
  return { text: pad.text.slice(0, -1), seeded: false };
}

// The echo is the raw buffer, so the lifter reads back exactly what they pressed; only the minus
// is swapped for the typographic one, and an empty buffer shows an em dash rather than nothing.
export function echoOf(pad) {
  if (pad.text === '') return '—';
  return pad.text.replace(/^-/, '−');
}

export function parseEntry(pad, mode, current) {
  const raw = pad.text.trim();
  const normalised = raw.replace(/,/g, '.');
  if (raw === '' || raw === '-') {
    return { valid: false, value: null, message: `Enter a number, or cancel to keep ${fmtKg(current)}` };
  }
  if ((normalised.match(/\./g) || []).length > 1) {
    return { valid: false, value: null, message: 'One decimal point only — 72,5 or 72.5' };
  }
  const value = Number(normalised);
  if (!Number.isFinite(value)) {
    return { valid: false, value: null, message: 'Not a number yet — 72,5 reads as 72.5' };
  }
  if (mode === 'weight' && Math.abs(value) > 500) {
    return { valid: false, value: null, message: 'Over 500 kg — check the number' };
  }
  // 1 and not 0: the server refuses reps < 1, so a pad that accepted 0 handed back a number the log
  // could only refuse — the one entry that looked legal here and died at the wire.
  if (mode === 'reps' && (value < 1 || value > 99 || value % 1 !== 0)) {
    return { valid: false, value: null, message: 'Whole reps, 1 to 99' };
  }
  if (mode === 'weight') return { valid: true, value: round(value), message: WEIGHT_HINT };
  return { valid: true, value, message: REPS_HINT };
}
