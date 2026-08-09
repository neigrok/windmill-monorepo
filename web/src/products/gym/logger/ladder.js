// THE LADDER — the one rule for how a weight moves by a tap. Lift had the same rule pasted into
// three targets and let them drift; the cases every implementation must answer live in
// packages/api-contract/gym-ladder.json, and the phone loggers run the same golden in Swift and
// Kotlin. The web's tap-ladder went with the capture (§11) — this module stays as the golden's JS
// statement, and `round` is the grid every printed weight is spelled on (log.js fmt).
//
// The bands are read off the MAGNITUDE and never the sign — a band-assisted pull-up sits at −20 kg,
// which is a point on the number line and never a mode. So the ladder is a mirror, exactly:
// bump(−w, −direction, big) === −bump(w, direction, big) for every weight, direction and size. The
// step buttons do not clamp; only typed entry is bounded (see entry.js).

const BANDS = [
  { under: 20, small: 1, large: 5 },
  { under: 50, small: 2, large: 5 },
  { under: Infinity, small: 5, large: 10 },
];

// A step that LIGHTENS the load is sized by the band just below the magnitude rather than the one
// it sits in — one comparison tightening from < to <=, which is the limit of |weight| − ε with no
// epsilon to pick. What it buys is that a step LANDING on a boundary is undone by its opposite: the
// +1 that carried you 19 → 20 is answered by a −1 back to 19, never a −2 down to 18. It buys no
// more than that — 49 +2→ 51 −5→ 46 crosses the boundary rather than landing on it, and does not
// come back. Reversibility at the edge, not everywhere.
//
// The find falls back because NaN and Infinity compare false against every band, and a weight is
// not always a number a lifter typed: a caller can hand this a value rehydrated from a store an
// older build shaped wrong, and a throw here is a white screen where a wrong band is merely a
// wrong label.
export function steps(weight, lightening = false) {
  const load = Math.abs(weight);
  const top = BANDS[BANDS.length - 1];
  const band = BANDS.find(({ under }) => (lightening ? load <= under : load < under)) ?? top;
  return [band.small, band.large];
}

// Rounding is HALF AWAY FROM ZERO, so it mirrors like everything else here. Math.round alone is
// half-UP — it sends 2.505 to 2.51 but −2.505 to −2.5 — and the keypad reaches that: typing −2.505
// would store one weight on the web and another on the phone, whose Swift copy rounds the magnitude.
// Rounding the magnitude and reapplying the sign is the whole fix.
export function round(weight) {
  return Math.sign(weight) * Math.round(Math.abs(weight) * 100) / 100;
}

// Lightening is REDUCING THE MAGNITUDE, not going down — which is what carries the rule across zero
// without a toggle in sight. At +20 kg the row reads −5 · −1 · +2 · +5, so at −20 kg it must read
// −5 · −2 · +1 · +5; at 0 no direction lightens, and both sides read the smallest band.
export function bump(weight, direction, big) {
  const [small, large] = steps(weight, direction * weight < 0);
  return round(weight + direction * (big ? large : small));
}

export function ladderLabels(weight) {
  // direction × weight < 0, specialised for the two buttons: down lightens a loaded bar, up
  // lightens an assisted one, and at zero neither of them does.
  const [downSmall, downLarge] = steps(weight, weight > 0);
  const [upSmall, upLarge] = steps(weight, weight < 0);
  return [`−${downLarge}`, `−${downSmall}`, `+${upSmall}`, `+${upLarge}`];
}

// DOM order, loudest pair in the middle: the small step is the one you actually use, so the inner
// two are drawn louder than the outer two.
export const LADDER_KEYS = [
  { direction: -1, big: true, weight: 'outer' },
  { direction: -1, big: false, weight: 'inner' },
  { direction: 1, big: false, weight: 'inner' },
  { direction: 1, big: true, weight: 'outer' },
];

// A set of zero reps is not a set, and the server says so — Training.cpp refuses reps < 1 — so a
// ladder that floored at 0 offered a tap the log could only answer with a refusal. The floor is a
// CLAMP INTO the range and never a hold at the value: a 0 rehydrated from a live blob written before
// the floor moved is climbed out of by whichever button the thumb finds first, so the down key can
// never be the thing preserving an unloggable number. repCases pins that answer for both languages.
export const REPS_FLOOR = 1;

export function bumpReps(reps, direction) {
  if (direction < 0) return Math.max(REPS_FLOOR, reps - 1);
  return reps + 1;
}
