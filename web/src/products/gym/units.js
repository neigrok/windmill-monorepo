// Units are a display transform. The store holds kilograms and only kilograms: no lb column, no
// conversion on the wire, and this dial rewrites nothing already logged. Kilograms in, a number to
// print out; the one field typed in the display unit is a weigh-in (bodyweight/bodyweight.js),
// which comes back through `fromDisplayUnit` to two decimals of a kilogram before it is written.

export const KG = 'kg';
export const LB = 'lb';
export const UNITS = [KG, LB];

// The international pound, exact by definition.
const KILOGRAMS_PER_POUND = 0.45359237;

let spelling = KG;

export function spellWeightsIn(units) {
  spelling = units === LB ? LB : KG;
}

export function weightUnit() {
  return spelling;
}

// Pounds land on a tenth, half away from zero so negative (band-assisted) loads mirror.
export function inDisplayUnit(weightKg) {
  if (spelling !== LB) return weightKg;
  const pounds = weightKg / KILOGRAMS_PER_POUND;
  return Math.sign(pounds) * Math.round(Math.abs(pounds) * 10) / 10;
}

// A number typed in the display unit, as the kilograms the wire takes: two decimals, half away from zero.
export function fromDisplayUnit(shown) {
  const kg = spelling === LB ? shown * KILOGRAMS_PER_POUND : shown;
  return Math.sign(kg) * Math.round(Math.abs(kg) * 100) / 100;
}
