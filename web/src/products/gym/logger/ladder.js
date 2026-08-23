// Bands are read off the MAGNITUDE, never the sign: bump(−w, −dir, big) === −bump(w, dir, big).
// The cross-surface cases are in packages/api-contract/gym-ladder.json.

const BANDS = [
  { under: 20, small: 1, large: 2.5 },
  { under: 50, small: 2.5, large: 5 },
  { under: Infinity, small: 2.5, large: 10 },
];

// A lightening step is sized by the band just below the magnitude; the fallback covers NaN and Infinity.
export function steps(weight, lightening = false) {
  const load = Math.abs(weight);
  const top = BANDS[BANDS.length - 1];
  const band = BANDS.find(({ under }) => (lightening ? load <= under : load < under)) ?? top;
  return [band.small, band.large];
}

// Half away from zero: Math.round alone is half-up and breaks on negative loads.
export function round(weight) {
  return Math.sign(weight) * Math.round(Math.abs(weight) * 100) / 100;
}

// Lightening is reducing the MAGNITUDE, not going down; at 0 no direction lightens.
export function bump(weight, direction, big) {
  const [small, large] = steps(weight, direction * weight < 0);
  return round(weight + direction * (big ? large : small));
}

// `direction × weight < 0` specialised per button: down lightens a loaded bar, up lightens an
// assisted one, and at zero neither does. Passing a constant here gets the assisted side wrong.
export function ladderLabels(weight) {
  const [downSmall, downLarge] = steps(weight, weight > 0);
  const [upSmall, upLarge] = steps(weight, weight < 0);
  return [`−${downLarge}`, `−${downSmall}`, `+${upSmall}`, `+${upLarge}`];
}

// DOM order; the inner pair is the small step.
export const LADDER_KEYS = [
  { direction: -1, big: true, weight: 'outer' },
  { direction: -1, big: false, weight: 'inner' },
  { direction: 1, big: false, weight: 'inner' },
  { direction: 1, big: true, weight: 'outer' },
];

// The server refuses reps < 1; the floor clamps into range rather than holding.
export const REPS_FLOOR = 1;

export function bumpReps(reps, direction) {
  if (direction < 0) return Math.max(REPS_FLOOR, reps - 1);
  return reps + 1;
}
