// The write is the WHOLE document, not a patch, so two screens open at once is last-write-wins.

import { KG, LB } from '../units.js';

export const DEFAULT_PREFERENCES = {
  units: KG,
  restSeconds: null,
  restSound: true,
  confirmHaptic: true,
  confirmSound: false,
};

// Off is `null` and never a zero: the wire spells it by omission.
export const REST_CHOICES = [null, 90, 120, 180];

export function restLabel(seconds) {
  if (seconds == null) return 'off';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function readPreferences(document) {
  const held = document ?? {};
  return {
    units: held.units === LB ? LB : KG,
    restSeconds: typeof held.restSeconds === 'number' ? held.restSeconds : null,
    restSound: held.restSound !== false,
    confirmHaptic: held.confirmHaptic !== false,
    confirmSound: held.confirmSound === true,
  };
}

export function preferencesWrite(preferences) {
  const write = {
    units: preferences.units,
    restSound: preferences.restSound,
    confirmHaptic: preferences.confirmHaptic,
    confirmSound: preferences.confirmSound,
  };
  if (preferences.restSeconds != null) write.restSeconds = preferences.restSeconds;
  return write;
}

export function preferenceRefusal(error) {
  if (error?.detail) return error.detail;
  return 'that setting didn’t save — the log didn’t answer. Try again in a moment';
}
