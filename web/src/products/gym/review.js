// THE END OF A SESSION, READ — three facts, at most one line of meaning, and the movement-by-
// movement comparison under it. Everything below renders the `Review` the store computed and
// NOTHING here computes one: no e1RM, no record decision, no matching of one session against
// another. The Epley formula and the record ladder live in the domain, once per language, so web
// and iOS can never disagree about which line is the loud one — a second opinion drawn here would
// be the product arguing with itself in its own loudest pixel.
//
// The empty slot is a decision. On the ~190 sessions in 200 that earn nothing the record line is
// simply absent and nothing takes its place: no encouragement, no streak, no score. The comparison
// is a fact with a direction and never a grade, which is why nothing in it is a percentage and
// nothing in it is coloured.

import { dayLabel, durLabel, fmt, nameOfMovement, NO_ROUTINE, timeLabel } from './log.js';
import { weightUnit } from './units.js';

export const RECORD_TITLE = 'Personal record';

// A short session is not a failure and is not congratulated either — it is asked about (screen 11),
// and the word above it is the only thing that changes. `first` is the log's to know, not the
// review's: the store answers what happened in this session, and whether one came before it is a
// question about the list.
export function finishHead({ startedAt, finishedAt, routine = null, slight = false, first = false }) {
  return {
    title: slight ? 'Ended early' : 'Session finished',
    subtitle: routine ?? (first ? 'Your first session' : NO_ROUTINE),
    when: `${dayLabel(startedAt)} · ${timeLabel(startedAt)} – ${timeLabel(finishedAt)}`,
  };
}

// The three facts, in the order the screen draws them. Duration is spelled by the log's one
// duration vocabulary rather than the mock's bare "1h 02", because a product with two ways to say
// an hour has to keep them in step forever. A session with no loaded working set has no honest
// one-rep estimate — a chin-up at zero and a band-assisted pull-up at −20 have none — so the tile
// says nothing with a dash rather than printing a zero nobody lifted.
export function statTiles(stats) {
  return [
    { value: durLabel(stats.durationMs), label: 'Duration' },
    { value: String(stats.workingSets), label: 'Working sets' },
    { value: stats.topE1rm == null ? '—' : fmt(stats.topE1rm), label: 'Top e1RM' },
  ];
}

// The rare loud line. The mark that was passed is named beside the one that passed it, because a
// record with nothing to compare against is a first entry, and a first entry is not a record — the
// domain refuses to call it one, and this sentence would be empty without the `past` half anyway.
//
// A kind this build has never heard of draws NOTHING. The slot is allowed to be empty, and a
// sentence assembled out of a rule we do not know is the one thing it may not hold.
export function recordSentence(record, catalog) {
  if (!record) return null;
  const movement = nameOfMovement(catalog, record.exerciseId);
  const past = `past ${fmt(record.previous)} from ${dayLabel(record.previousAt)}`;
  const unit = weightUnit();
  if (record.kind === 'e1rm') return `${movement} e1RM ${fmt(record.value)} ${unit} — ${past}.`;
  if (record.kind === 'heaviest') return `${movement} ${fmt(record.value)} ${unit} × ${record.reps} — ${past}.`;
  if (record.kind === 'reps-at-weight') return `${movement} ${record.reps} reps at ${fmt(record.weightKg)} ${unit} — ${past}.`;
  return null;
}

// A rep target a routine declines to set is screen 6's `3 × max` — a movement taken to whatever it
// gives that day. The wire spells it by omission (gymApi.js). It is not a zero and it is not a blank.
function countLabel({ sets, reps }) {
  if (reps == null) return `${sets} × max`;
  return `${sets}×${reps}`;
}

// Zero is not a load, it is the absence of one: a chin-up reads `3×8`, and a band-assisted pull-up
// at −20 still reads its load, because that is a real point on the number line here.
function topLabel(top) {
  if (top.weightKg == null || top.weightKg === 0) return countLabel(top);
  return `${countLabel(top)} @ ${fmt(top.weightKg)}`;
}

// Which reference the arrow points from: the plan, when the session had one for that movement, and
// last time when it did not. The plan is what the lifter agreed to and the log is what happened.
//
// The one row that is not an arrow is the one that fell short — "planned 3×12 · did 3×10" says the
// thing an arrow cannot, which is that the session did not get through what was written down.
// Everything is measured on the top working set the store already picked, never on volume.
//
// WHAT MAY BE CALLED SHORT is narrow, because `now.sets` is not what a reader assumes: it counts
// only the sets at the TOP LOAD (gymApi.js), so a session that ramped 100·105·110·110·110 through
// every one of five planned sets arrives as `sets: 3` and a set-count comparison would tell a
// lifter who finished the workout that they did not. Reps are the only axis the wire can be read
// short on — and only when the bar did not go up, because heavier for fewer is a different session
// rather than a smaller one, and §2.4 says this is a fact with a direction and never a grade.
function detailOf({ now, before, planned }) {
  const short = planned != null && planned.reps != null && now.reps < planned.reps
    && (planned.weightKg == null || now.weightKg <= planned.weightKg);
  if (short) return `planned ${countLabel(planned)} · did ${countLabel(now)}`;
  if (planned) return `${topLabel(planned)} → ${topLabel(now)}`;
  if (before) return `${topLabel(before)} → ${topLabel(now)}`;
  return topLabel(now);
}

// "Against last Legs" — the same routine, the last time it ran, in the order this session performed
// its movements. The wire carries a movement's top working set and how many, and never the reps of
// each one (gymApi.js), so the mock's "5,5,5,5,4" is not drawn here: the row would have to invent
// four numbers to draw it.
//
// The routine NAME is omitted when the earlier session's snapshot carries none, deliberately and at
// the store's end — "Against last " is worse than a heading naming no day at all. So the heading
// names the session rather than interpolating an undefined into the loudest line on the screen.
export function comparison(against, catalog) {
  if (!against) return null;
  return {
    title: against.routine ? `Against last ${against.routine}` : 'Against last time',
    rows: against.movements.map((movement) => ({
      exerciseId: movement.exerciseId,
      movement: nameOfMovement(catalog, movement.exerciseId),
      detail: detailOf(movement),
    })),
  };
}
