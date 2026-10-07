import { GymUnits } from './domain/units.js';

// The store holds kilograms and only kilograms; the one field typed in the display unit is a weigh-in.

export const KG = 'kg';
export const LB = 'lb';
export const UNITS = [KG, LB];

let spelling = KG;

export function spellWeightsIn(units) {
  spelling = units === LB ? LB : KG;
}

export function weightUnit() {
  return spelling;
}

// Pounds land on a tenth, half away from zero so negative (band-assisted) loads mirror.
export function inDisplayUnit(weightKg, unit = spelling) {
  return GymUnits.reading(unit).display(weightKg);
}

// A number typed in the display unit, as the kilograms the wire takes: two decimals, half away from zero.
export function fromDisplayUnit(shown, unit = spelling) {
  return GymUnits.reading(unit).kilograms(shown);
}
