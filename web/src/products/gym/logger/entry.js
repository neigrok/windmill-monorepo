// `seeded` marks a buffer nobody typed: the first digit replaces it, ± and ⌫ edit it.

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
  // The server refuses reps < 1.
  if (mode === 'reps' && (value < 1 || value > 99 || value % 1 !== 0)) {
    return { valid: false, value: null, message: 'Whole reps, 1 to 99' };
  }
  if (mode === 'weight') return { valid: true, value: round(value), message: WEIGHT_HINT };
  return { valid: true, value, message: REPS_HINT };
}
