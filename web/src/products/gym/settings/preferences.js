// GYM'S FIVE SETTINGS AS ONE DOCUMENT — the same shape in both directions on the wire (GET and PUT
// /v1/gym/preferences), read here into what the section draws and written back whole. Pure rules
// only: no fetch, no React, and the tests read them without either.
//
// THE WRITE IS THE WHOLE DOCUMENT AND NOT A PATCH, which is the server's decision and a good one:
// `restSeconds` ABSENT is the only way to say the timer is off — there is no zero and no false — so
// on a merge "omitted" and "cleared" would have to be different things on the one field whose
// absence already means something. The cost is stated rather than hidden: two screens open at once
// is last-write-wins, and the last write is the one the lifter just touched.
//
// EVERY FIELD IS THE ACCOUNT'S, none is the device's. A lifter reads in one unit everywhere; the
// plates belong to their gym and not to their phone; the rest is their program's. The two
// confirmation flags are the subtle one — they record an INTENT, and each surface honours what it
// can. Nothing is honoured on this one, and the row says so where it is drawn — not because the
// browser cannot buzz (Chrome has `navigator.vibrate` and honours it on Android, which is where
// this PWA installs) but because no set is LOGGED at this desk for a confirmation to answer. The
// design's caption reasons from the API and is wrong about it; the row states the true limit.
//
// THE DEFAULTS ARE THE SERVER'S, spelled again here so a lifter who has never opened this screen is
// served on the first paint rather than after a round trip — and so a read that does not come back
// leaves the surface saying the same thing the store would have. Rest defaults to OFF because a
// timer nobody asked for that starts beeping in a gym is the kind of thing this product does not do.

import { KG, LB } from '../units.js';

export const DEFAULT_PREFERENCES = {
  units: KG,
  barWeightKg: 20,
  platesKg: [25, 20, 15, 10, 5, 2.5, 1.25],
  restSeconds: null,
  restSound: true,
  confirmHaptic: true,
  confirmSound: false,
};

// The one band the section can keep a hand off before the wire bounces it — never a second opinion:
// the server is what decides, and its sentence is what the lifter is shown when the two disagree.
// The store's other bands (a plate from 0.01 to 100 kg, at most twelve kinds, a rest target from 15
// to 900 seconds) are unreachable from the controls this desk draws, so they are named here and not
// spelled as constants nothing reads.
export const BAR_MAX_KG = 100;

// §I's own row: off · 1:30 · 2:00 · 3:00. Off is `null` rather than a zero, because it is what the
// wire spells by omission and there is exactly one way to say it.
export const REST_CHOICES = [null, 90, 120, 180];

export function restLabel(seconds) {
  if (seconds == null) return 'off';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// The chips the design draws — a full metric rack, which is also the default set. A gym that owns
// something else still gets it stored: the server takes any twelve kinds from 0.01 to 100, and this
// list is what the desk offers rather than what the store allows.
export const PLATE_CHOICES = [25, 20, 15, 10, 5, 2.5, 1.25];

export function withPlate(platesKg, plate) {
  if (platesKg.includes(plate)) return platesKg.filter((each) => each !== plate);
  return [...platesKg, plate].sort((left, right) => right - left);
}

// The stored document, read. Every field is filled in — the section never draws a half-document —
// and every absence is read as the default it stands for, which is exactly what the server does with
// the same absence on the way in.
//
// AN EMPTY PLATE LIST IS A REAL VALUE and survives: a gym that owns no plates is a different fact
// from a field nobody sent, and only the second one means the full rack.
export function readPreferences(document) {
  const held = document ?? {};
  return {
    units: held.units === LB ? LB : KG,
    barWeightKg: typeof held.barWeightKg === 'number' ? held.barWeightKg : DEFAULT_PREFERENCES.barWeightKg,
    platesKg: Array.isArray(held.platesKg)
      ? [...held.platesKg].sort((left, right) => right - left)
      : [...DEFAULT_PREFERENCES.platesKg],
    restSeconds: typeof held.restSeconds === 'number' ? held.restSeconds : null,
    restSound: held.restSound !== false,
    confirmHaptic: held.confirmHaptic !== false,
    confirmSound: held.confirmSound === true,
  };
}

// The body of the PUT. Off is an absence and it is the only way to spell it, so a timer nobody set
// is a field nobody sends — a `restSeconds: null` on the wire would be read as omitted anyway, and
// leaving it out says the same thing without asking the server to interpret.
export function preferencesWrite(preferences) {
  const write = {
    units: preferences.units,
    barWeightKg: preferences.barWeightKg,
    platesKg: preferences.platesKg,
    restSound: preferences.restSound,
    confirmHaptic: preferences.confirmHaptic,
    confirmSound: preferences.confirmSound,
  };
  if (preferences.restSeconds != null) write.restSeconds = preferences.restSeconds;
  return write;
}

// WHY A SETTING DID NOT LAND, in the store's own words. Every refusal on this route carries a
// sentence written for a person — "a plate weighs from 0.01 to 100 kg" — and a machine code beside
// it; the sentence is what a lifter is shown, because it names the band, and the code is never
// branched on here. A refusal with no sentence is the only case this has to finish itself, and it is
// the same half-sentence every other refusal in gym is finished with.
export function preferenceRefusal(error) {
  if (error?.detail) return error.detail;
  return 'that setting didn’t save — the log didn’t answer. Try again in a moment';
}
