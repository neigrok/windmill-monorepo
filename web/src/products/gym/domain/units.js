// @ts-check

import { roundHalfAway, roundToQuantum } from '../../../../../packages/api-contract/sync/reference/core/values.js';

export class GymUnits {
  static kilogramsPerPound = 0.45359237;
  static kg = new GymUnits('kg');
  static lb = new GymUnits('lb');

  /** @param {'kg' | 'lb'} value */
  constructor(value) { this.value = value; Object.freeze(this); }

  /** @param {string | null | undefined} value */
  static reading(value) { return value === 'lb' ? GymUnits.lb : GymUnits.kg; }

  /** @param {number} kilograms */
  display(kilograms) { return this.value === 'lb' ? roundToQuantum(kilograms / GymUnits.kilogramsPerPound, 0.1) : kilograms; }

  /** @param {number} displayed */
  kilograms(displayed) { return roundToQuantum(this.value === 'lb' ? displayed * GymUnits.kilogramsPerPound : displayed, 0.01); }
}

export const WeightLadder = Object.freeze({
  /** @param {number} magnitude @param {boolean} lightening */
  steps(magnitude, lightening = false) {
    if (lightening ? magnitude <= 20 : magnitude < 20) return Object.freeze({ small: 1, large: 2.5 });
    if (lightening ? magnitude <= 50 : magnitude < 50) return Object.freeze({ small: 2.5, large: 5 });
    return Object.freeze({ small: 2.5, large: 10 });
  },
  /** @param {number} weight */
  round(weight) { return roundToQuantum(weight, 0.01); },
  /** @param {number} weight */
  onGrid(weight) {
    const step = WeightLadder.steps(Math.abs(weight)).small;
    const magnitude = roundHalfAway(Math.abs(weight) / step) * step;
    return WeightLadder.round(weight < 0 ? -magnitude : magnitude);
  },
  /** @param {number} weight @param {number} direction @param {boolean} big */
  bump(weight, direction, big = false) {
    const step = WeightLadder.steps(Math.abs(weight), direction * weight < 0);
    return WeightLadder.round(weight + direction * (big ? step.large : step.small));
  },
  /** @param {number} weight */
  labels(weight) {
    const down = WeightLadder.steps(Math.abs(weight), weight > 0);
    const up = WeightLadder.steps(Math.abs(weight), weight < 0);
    return Object.freeze([`−${down.large}`, `−${down.small}`, `+${up.small}`, `+${up.large}`]);
  },
  /** @param {number} reps @param {number} direction */
  bumpReps(reps, direction) {
    if (direction < 0) return reps <= 1 ? 1 : reps - 1;
    return reps >= 2_147_483_647 ? reps : Math.max(1, reps + 1);
  },
});
