// THE LADDER — the one place in Windmill where a weight moves by a tap. Lift had the same rule
// pasted into three targets and let them drift; here every button, every label and every test
// reads these four functions, and there is no second copy to disagree with.
//
// The bands are read off the MAGNITUDE, so the ladder behaves the same on the negative side of
// zero — band-assisted pull-ups sit at −20 kg, which is a point on the number line and never a
// mode. The step buttons do not clamp; only typed entry is bounded (see entry.js).

export function steps(weight) {
  const load = Math.abs(weight);
  if (load < 20) return [1, 5];
  if (load < 50) return [2, 5];
  return [5, 10];
}

export function round(weight) {
  return Math.round(weight * 100) / 100;
}

// The down-step is evaluated JUST BELOW the current weight, so stepping down from exactly 20 kg
// lands on 19 and not 18 — you land back inside the band you came from. The visible consequence
// is that at 20 kg the row reads −5 · −1 · +2 · +5, and that asymmetry is the proof the rule is
// working, not a bug to straighten.
export function bump(weight, direction, big) {
  const [small, large] = steps(direction < 0 ? weight - 0.001 : weight);
  return round(weight + direction * (big ? large : small));
}

export function ladderLabels(weight) {
  const [downSmall, downLarge] = steps(weight - 0.001);
  const [upSmall, upLarge] = steps(weight);
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

export function bumpReps(reps, direction) {
  if (direction < 0) return Math.max(0, reps - 1);
  return reps + 1;
}
