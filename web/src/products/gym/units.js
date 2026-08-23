// Units are a display transform. The store holds kilograms and only kilograms: no lb column, no
// conversion on the wire, and this dial rewrites nothing already logged. One direction — kg in, a
// number to print out — and it is never on the way to a write.

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
