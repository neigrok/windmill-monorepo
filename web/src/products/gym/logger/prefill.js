// THE PREFILL — the number in front of you before you touch anything, and the reason this is a
// training log and not a form. Three sources in a fixed order, and the one that loses is still on
// screen: today's own last set wins (sticky carry-forward), then the plan snapshot, then last
// time, then the empty bar.
//
// Every rule here is pure, and "last time" arrives already resolved — it is one read of the store
// (`GET /v1/gym/last`), which owns the walk back through the history and the warmup filter. This
// module receives that answer exactly as the wire shipped it, so there is no second vocabulary for
// the same fact and nothing to keep in step.
//
// The asymmetry in "last time" is deliberate: the weight comes from the LAST working set, where
// the lifter actually ended up, and the reps from the FIRST, before fatigue cut them.

import { agoLabel, dayLabel, fmt, planOf } from '../log.js';

export const EMPTY_BAR_KG = 20;
export const EMPTY_BAR_REPS = 5;

export function planEntryFor(session, exerciseId) {
  const entries = planOf(session)?.entries;
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry.exerciseId === exerciseId) ?? null;
}

export function workingSetsOf(sets, exerciseId) {
  return sets.filter((set) => set.exerciseId === exerciseId && set.kind !== 'warmup');
}

// Last time is a SESSION, not a set — you get the whole block back, and there is no cutoff: as far
// back as the log goes. An answer that names the movement and nothing else is a lifter who has
// never trained it, so an absent block and an absent answer fall through to the same place here,
// and only the card below has to tell them apart.
export function prefillFor({ todaySets = [], planEntry = null, lastTime = null }) {
  const sticky = todaySets.length > 0 ? todaySets[todaySets.length - 1] : null;
  if (sticky) return { weight: sticky.weightKg, reps: sticky.reps };
  const last = lastTime?.sets ?? null;
  return {
    weight: planEntry?.weightKg ?? (last ? last[last.length - 1].weightKg : EMPTY_BAR_KG),
    reps: planEntry?.reps ?? (last ? last[0].reps : EMPTY_BAR_REPS),
  };
}

// The card says which day, how long ago, and — when that block happened on a different day of the
// program — which routine it was, rather than hiding the difference.
//
// Four states, not two, because the log going quiet is not a training fact: a read still in flight
// says so and waits, a read that came back empty-handed says THAT instead of going on claiming to
// be reading, and ONLY an answer may say "first time". A card that draws "no history" over a
// movement the lifter has squatted for a year, because the phone was in a basement, is the product
// lying in the one pixel it exists for — and a card still saying "reading your log…" ten minutes
// after the read failed is the same lie told more quietly.
export function prefillCard({
  lastTime = null, planEntry = null, routine = null, readFailed = false, now = Date.now(),
}) {
  if (!lastTime && readFailed) return { title: 'Last time', body: 'the log didn’t answer' };
  if (!lastTime) return { title: 'Last time', body: 'reading your log…' };
  if (!lastTime.session) {
    const weight = planEntry?.weightKg;
    if (weight != null) {
      return { title: 'First time logging this', body: `no history — dialled to the plan’s ${fmt(weight)} kg` };
    }
    return { title: 'First time logging this', body: 'no history — start where you like' };
  }
  const day = lastTime.session.startedAt;
  const cross = lastTime.routine && lastTime.routine !== routine ? `  ·  ${lastTime.routine}` : '';
  const shown = lastTime.sets.slice(0, 4).map((set) => `${fmt(set.weightKg)} × ${set.reps}`);
  const more = lastTime.sets.length > 4 ? `,   +${lastTime.sets.length - 4} more` : '';
  return {
    title: `Last time · ${dayLabel(day)} · ${agoLabel(day, now)}${cross}`,
    body: `${shown.join(',   ')}${more}`,
  };
}

// "set 4 of 3" is legal, normal and drawn in exactly the same ink as "set 3 of 5". The plan is a
// snapshot of what was written down, the log is what happened, and when they disagree the log is
// right — so the counter never warns and the target is never hidden. Warmups never advance it.
export function counterLine({ workingSetsToday = 0, planEntry = null }) {
  if (!planEntry) return { count: `set ${workingSetsToday + 1}`, tail: '  ·  no target' };
  const weight = planEntry.weightKg;
  const target = weight == null ? '' : ` @ ${fmt(weight)}`;
  return {
    count: `set ${workingSetsToday + 1} of ${planEntry.sets}`,
    tail: `  ·  plan ${planEntry.sets} × ${planEntry.reps}${target}`,
  };
}
