// The rest timer — a target per movement, one global dial, and a value that is computed rather
// than counted. It stores the instant the set landed, never a remaining count, so a locked phone
// and a reloaded tab both come back to the truth.
//
// Being over the target is not an error and must never look like one: the overrun counts UP in
// the room's own hue, calm and quietly present. Nothing in this file ever reaches for --alarm-ink.

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

// Three sources, in the order the phone reads them (apps/ios/…/WindmillGym/RestTimer.swift): what
// THIS session's frozen plan says for this movement, then the movement's own target, then the table.
// Taking the plan entry as an argument rather than reading it off the exercise is the whole fix for
// a bug that shipped: the web asked the CATALOG exercise for a `restSeconds` the wire never puts on
// one, so a routine saved with 180 rested three minutes on the phone and two at the desk. The
// movement-level target below is kept because it is the designed rule, but note it has no producer
// yet — nothing writes restSeconds onto an exercise, only onto a routine entry (routines.js).
export function restTargetFor({ planEntry = null, exercise = null } = {}, preferenceSeconds = NEUTRAL_PREFERENCE_SECONDS) {
  const base = planEntry?.restSeconds ?? exercise?.restSeconds ?? REST_SECONDS.get(exercise?.id) ?? DEFAULT_REST_SECONDS;
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
