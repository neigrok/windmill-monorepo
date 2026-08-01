// The rest timer — a target per movement, one global dial, and a value that is computed rather
// than counted. It stores the instant the set landed, never a remaining count, so a locked phone
// and a reloaded tab both come back to the truth.
//
// Being over the target is not an error and must never look like one: the overrun counts UP in
// steel, calm and quietly present. Nothing in this file ever reaches for --alarm-ink.

import { clockOf } from '../log.js';

export const DEFAULT_REST_SECONDS = 120;
export const NEUTRAL_PREFERENCE_SECONDS = 180;

// The design's own table. The accessories agree with the default on purpose — they are written out
// so the rule reads as a decision rather than as an omission, and a movement the table has never
// heard of (including one the lifter created) rests for two minutes.
const REST_SECONDS = new Map([
  ['back-squat', 180],
  ['bench-press', 180],
  ['overhead-press', 180],
  ['romanian-deadlift', 120],
  ['chin-up', 120],
  ['barbell-row', 120],
  ['dip', 120],
  ['face-pull', 60],
]);

export function restTargetFor(exercise, preferenceSeconds = NEUTRAL_PREFERENCE_SECONDS) {
  const base = exercise?.restSeconds ?? REST_SECONDS.get(exercise?.id) ?? DEFAULT_REST_SECONDS;
  return Math.round(base * (preferenceSeconds / NEUTRAL_PREFERENCE_SECONDS));
}

export function restReadout({ targetSeconds, startedAt, now }) {
  const left = targetSeconds - Math.floor((now - startedAt) / 1000);
  const overrun = left < 0;
  return {
    left,
    overrun,
    landed: left <= 0,
    label: `${overrun ? 'rest done' : 'resting'} · target ${clockOf(targetSeconds * 1000)}`,
    time: overrun ? `+${clockOf(-left * 1000)}` : clockOf(left * 1000),
  };
}
