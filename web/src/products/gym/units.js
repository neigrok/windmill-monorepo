// UNITS ARE A DISPLAY TRANSFORM, AND THIS IS THE EDGE THEY LIVE ON — the one place a kilogram
// becomes a number on a screen. The store holds kilograms and only kilograms: there is no lb column,
// nothing converts on the wire, and moving this dial rewrites nothing that was logged. So the module
// has exactly one direction — kg in, a number to print out — and it is never on the way to a write.
// units.test.js proves that by walking the source rather than by promising it here.
//
// THE SPELLING IS A MODULE-LEVEL VALUE RATHER THAN A PARAMETER, and that is the decision this file
// is. The alternative is threading a unit through every label in log.js and every screen that prints
// one — twenty-odd call sites, each of them a place to forget — for a value that is one per account,
// read once on the way in, and an input to nothing but a spelling. Nothing branches on it, nothing
// stores it, nothing computes with it; `fmt` reads it, and that is the whole of its reach.
//
// THREE PLACES SET IT, each at its own edge. Two read an account: useTrainingLog.js as the rooms
// open, and the settings section the moment the lifter moves the dial. The third sets it BACK — the
// coach's shared workout (share/SharedSession.jsx) is a page with no account behind it, and it is
// answered before either of the other two runs (GymApp.jsx), so in a tab whose log was open in
// pounds it would otherwise print one document two ways with no unit word on it. It spells
// kilograms, which is what the store holds and the only reading a stranger holding a link can be
// handed honestly.

export const KG = 'kg';
export const LB = 'lb';
export const UNITS = [KG, LB];

// The international pound, exact by definition since 1959: 0.45359237 kg. This is the only ratio in
// gym's web surface and it is deliberately the only one — a second copy is how two screens end up
// disagreeing about the same bar.
const KILOGRAMS_PER_POUND = 0.45359237;

let spelling = KG;

// An unknown unit spells kilograms rather than throwing: the value arrives off the wire, and a
// deployment that grows a third unit must not white-screen a log that is otherwise perfectly
// readable. The store clamps the same way.
export function spellWeightsIn(units) {
  spelling = units === LB ? LB : KG;
}

export function weightUnit() {
  return spelling;
}

// Pounds land on a tenth; kilograms are handed back untouched, on the grid the ladder already
// rounds them to. A kilogram is a number somebody chose and a pound is a reading of it — 102.5 kg
// reads 226 lb, and 225.97 would be four digits of precision the weight never had. Half away from
// zero, like every other rounding in this product, because a band-assisted load is a negative
// number and it has to mirror.
export function inDisplayUnit(weightKg) {
  if (spelling !== LB) return weightKg;
  const pounds = weightKg / KILOGRAMS_PER_POUND;
  return Math.sign(pounds) * Math.round(Math.abs(pounds) * 10) / 10;
}
