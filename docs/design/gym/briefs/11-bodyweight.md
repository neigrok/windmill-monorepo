# Bodyweight — a number, a day, and no interpretation

The word *tracker* is banned in this room and stays banned. The feature is **Bodyweight**.

## Where it lives, and why it is not a tab

**The log.** The log is the record of what happened, and a weigh-in is what happened.

It is **not a fourth tab.** Gym has three, the shell's canon says so, and a five-second daily task
does not earn a rail seat. A tab would also lie about the feature's weight in the product: this is a
number a lifter enters in the morning, not a place they go.

## Reading at the top. Writing in the reach band.

These are two different things and they belong in two different places.

**The reading** is a quiet line at the head of the log: today's weight, or the last one and its age —
*"82.4 kg · 3 days ago"*. On a day with no weigh-in it reads the last number and its age; it is
**never a blank field demanding one**. A missing fact draws nothing — never a dash, never a zero.

**The writing** is one chip pinned in the reach band, opening a decimal sheet.

The split is not fussiness. `../../guidelines/thumb-reach.md` forbids **a required input** in the top
band by name, and the log's header sits inside the scroll on every surface — so a field at the top
scrolls away exactly when you reach for it, and the Log tab would carry two top-anchored controls with
nothing in the reach band at all. Pinned, the Log tab has exactly one primary action, in the band, at
every scroll position.

## The chart is a new primitive

Neither shape gym already owns will do, and this is worth saying plainly because reaching for the
existing one would have been the obvious move.

Gym's chart is **bars, and they normalise to the series maximum** — which is right for an estimated
one-rep max climbing from 60 to 120, and useless for a bodyweight sitting between 82.0 and 84.5, where
every bar renders as a near-identical full-height block.

A **line** is banned, and for a reason that applies here more strongly than where it was written: *a
line between discrete sessions implies days that never happened.* A weigh-in series is more gapped
than a session series, not less.

So:

> **A dot per measurement, on a truncated and labelled y-axis** — the series' own minimum and maximum
> plus padding. **Gaps left visibly empty.** **No segment drawn across a gap longer than seven days**,
> and the gap carries its own label — *"no weigh-in · 7 Jul – 4 Aug"*.

Seven, because a lifter who weighs in two or three mornings a week has ordinary gaps of two to four
days, and the line should break on a **missed week** — that is the thing worth seeing. A longer
threshold buys smoothness by implying a fortnight of measurements that do not exist.

A connecting segment is still a connection and not data, so the chart **says so on itself**: *"no
line is drawn across a gap longer than seven days"*, beside the window it is showing. A reader who
knows the rule can read the line correctly; a reader who does not would be misled by it, which is
why the sentence is part of the chart rather than part of a spec.

The rule about lines is honoured by refusing to connect across a gap, not by pretending bars fit. And
the window the chart shows is **stated**, not silent: "the whole series" needs a scroll or a range
control, and a chart that quietly shows twelve weeks while claiming everything is the kind of small
dishonesty this room does not ship.

## What the chart refuses to draw

No goal line. No projection. No BMI. No body-fat estimate. No congratulation on a direction, and no
alarm about one.

The shell's honesty rule is the reason: **never a number we do not have.** A projection is a number we
do not have. A goal line is a number the lifter never gave us.

## A weigh-in has a repair path

Three verbs, and they belong to the lifter: a weigh-in can be **entered for any date, corrected, and
deleted** — from the chart, by tapping a point. One sheet, reused from the fix sheet.

Without them a fat-fingered 182 for 82 is permanent and rescales the chart forever. That would be out
of character: gym gives a whole backfill door to a missed session and a fix sheet with an undo to a
mistyped set, precisely because it accepts that people log late and log wrong.

## Unsigned, and not on the ladder

A load in this room is **signed** — a chin-up logs at 0 kg, a band-assisted pull-up at −20 — and the
weight ladder exists to step through plate granularity in both directions.

A bodyweight is none of those things. It is unsigned, it has no plate physics, and it is not stepped
to. **The ladder is not reused here**: the input is a plain decimal field. That is a deliberate refusal
to carry the wrong model into a place it does not belong, and it is why the open zero-crossing item in
`00-README.md` does not reach this feature.

## Units

The log stores kilograms, and the unit toggle is a display transform that two of the three surfaces do
not yet apply. Bodyweight must not ship a fourth opinion: it reads the same setting, and where the
setting does not convert, it draws kilograms and says so in the same words the room already uses.

## Coach reads it, and may never write it

One read-level declaration, which Coach picks up automatically.

Coach may **never** write a bodyweight. A weigh-in is a fact only the lifter observed; an agent writing
one would be inventing a number, which the room's own prompt already forbids in as many words. This is
the same reason Coach cannot log a set.

## Open

- **The wire shape.** `{ dateLocal, weightKg }`, one write per local date, is greenfield — there is no
  table, no column and no route today. It needs a backend contract before a board becomes a build, and
  it needs a place in the sign-in claim replay like every other local-first object.
- **Whether a trend belongs here at all.** Day-to-day bodyweight moves a kilo or two on water, so a
  raw series shows some noise. A labelled average over a named window, drawn *over* visible points,
  would be arithmetic on numbers we have; a smoothed line drawn *instead of* the points would be a
  number we do not. This wave draws the points and does not decide the rest.
