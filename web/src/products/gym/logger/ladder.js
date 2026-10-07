import { WeightLadder } from '../domain/units.js';
import { SetRules } from '../domain/training.js';

export function steps(weight, lightening = false) {
  const { small, large } = WeightLadder.steps(Math.abs(weight), lightening);
  return [small, large];
}

export const round = WeightLadder.round;
export const snap = WeightLadder.onGrid;
export const bump = WeightLadder.bump;
export const ladderLabels = WeightLadder.labels;
export const bumpReps = WeightLadder.bumpReps;

// DOM order; the inner pair is the small step.
export const LADDER_KEYS = [
  { direction: -1, big: true, weight: 'outer' },
  { direction: -1, big: false, weight: 'inner' },
  { direction: 1, big: false, weight: 'inner' },
  { direction: 1, big: true, weight: 'outer' },
];

export const REPS_FLOOR = SetRules.reps.min;
