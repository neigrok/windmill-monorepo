// A PERFORMED SET's bands, read off what a lifter typed: a set that was performed may name 1–99
// reps. The ROUTINE TARGET's band is 1–100 and lives in routines.js, which enforces it for the
// target sheet.

import { fmtKg } from '../log.js';
import { round } from './ladder.js';

export const LOGGER_REPS_MIN = 1;
export const LOGGER_REPS_MAX = 99;
export const MAX_LOAD_KG = 500;

// The line under a valid weight is the unit and nothing else: both separators are accepted, so there
// is nothing to explain.
export const WEIGHT_UNIT = 'kg';
export const REPS_HINT = 'whole reps';

// Pinned in briefs/15-the-routine.md, in the same words the target sheet uses, with this screen's
// own rep band in the one sentence that names a band.
export const ONE_DECIMAL = 'One decimal point only.';
export const NOT_A_NUMBER = 'That is not a number yet.';
export const OVER_MAX_LOAD = 'Over 500 kg — check the number.';
export const REPS_BAND = 'Whole reps, 1 to 99.';

export function parseEntry(pad, mode, current) {
  const raw = pad.text.trim();
  const normalised = raw.replace(/,/g, '.');
  if (raw === '' || raw === '-') {
    return { valid: false, value: null, message: `Enter a number, or cancel to keep ${fmtKg(current)}` };
  }
  if ((normalised.match(/\./g) || []).length > 1) {
    return { valid: false, value: null, message: ONE_DECIMAL };
  }
  const value = Number(normalised);
  if (!Number.isFinite(value)) {
    return { valid: false, value: null, message: NOT_A_NUMBER };
  }
  if (mode === 'weight' && Math.abs(value) > MAX_LOAD_KG) {
    return { valid: false, value: null, message: OVER_MAX_LOAD };
  }
  // The server refuses reps < 1.
  if (mode === 'reps' && (value < LOGGER_REPS_MIN || value > LOGGER_REPS_MAX || value % 1 !== 0)) {
    return { valid: false, value: null, message: REPS_BAND };
  }
  if (mode === 'weight') return { valid: true, value: round(value), message: WEIGHT_UNIT };
  return { valid: true, value, message: REPS_HINT };
}
