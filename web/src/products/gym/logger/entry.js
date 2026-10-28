// A PERFORMED SET's bands, read off what a lifter typed: a set that was performed may name 1–99
// reps. The ROUTINE TARGET's band is 1–100 and lives in routines.js, which enforces it for the
// target sheet.

import { fmtKg } from '../log.js';
import { round } from './ladder.js';

export const LOGGER_REPS_MIN = 1;
export const LOGGER_REPS_MAX = 99;

// The line under a valid weight is the unit and nothing else: both separators are accepted, so there
// is nothing to explain.
export const WEIGHT_UNIT = 'kg';
export const REPS_HINT = 'whole reps';

// In the same words the target sheet uses, with this screen's
// own rep band in the one sentence that names a band.
export const ONE_DECIMAL = 'One decimal point only.';
export const NOT_A_NUMBER = 'That is not a number yet.';
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
  // The server refuses reps < 1.
  if (mode === 'reps' && (value < LOGGER_REPS_MIN || value > LOGGER_REPS_MAX || value % 1 !== 0)) {
    return { valid: false, value: null, message: REPS_BAND };
  }
  if (mode === 'weight') return { valid: true, value: round(value), message: WEIGHT_UNIT };
  return { valid: true, value, message: REPS_HINT };
}
