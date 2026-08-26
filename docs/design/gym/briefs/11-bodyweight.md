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
The age is *today*, *yesterday* or *N days ago*, counted in calendar days.

**The writing** is one chip pinned in the reach band, opening a decimal sheet.

The split is not fussiness. `../../guidelines/thumb-reach.md` forbids **a required input** in the top
band by name, and the log's header sits inside the scroll on every surface — so a field at the top
scrolls away exactly when you reach for it, and the Log tab would carry two top-anchored controls with
nothing in the reach band at all. Pinned, the Log tab has exactly one primary action, in the band, at
every scroll position.

**One door, not two.** The chip on the log is the only place a weigh-in is entered. The chart screen
carries no second input — it is where you go to *look* and to *repair*, and a field there would be
two doors onto one value and two code paths behind it. Someone standing on the chart who wants to add
today's number is one back-gesture from the chip.

The chart screen does carry the repair path, because that is a different verb and it belongs where
the mistake is visible.

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

The label's two dates are the bounding dots — the last weigh-in before the gap and the first after
it — on every surface. Where the label sits is the surface's (inside the gap, beneath the axis, or
both); the words and the two dates are the same.

Seven, because a lifter who weighs in two or three mornings a week has ordinary gaps of two to four
days, and the line should break on a **missed week** — that is the thing worth seeing. A longer
threshold buys smoothness by implying a fortnight of measurements that do not exist.

A connecting segment is still a connection and not data, so the chart **says so on itself**: *"no
line is drawn across a gap longer than seven days"*, beside the window it is showing. A reader who
knows the rule can read the line correctly; a reader who does not would be misled by it, which is
why the sentence is part of the chart rather than part of a spec.

The rule about lines is honoured by refusing to connect across a gap, not by pretending bars fit. And
the window the chart shows is **stated**, not silent: a two-value control, **90 days** · **All**,
default 90 days, and the chart prints the window it shows with what it holds — *last 90 days · 12
weigh-ins*, *the whole series · 12 weigh-ins* (*1 weigh-in*). A chart that quietly shows twelve
weeks while claiming everything is the kind of small dishonesty this room does not ship.

## What the chart refuses to draw

No goal line. No projection. No BMI. No body-fat estimate. No congratulation on a direction, and no
alarm about one.

The shell's honesty rule is the reason: **never a number we do not have.** A projection is a number we
do not have. A goal line is a number the lifter never gave us.

## A weigh-in has a repair path

Three verbs, and they belong to the lifter: a weigh-in can be **entered for any past date, corrected,
and deleted** — from the chart, by tapping a dot. One sheet — the weigh-in sheet — reused for the
repair with its date fixed to that day and a **Delete weigh-in** row, confirmed: *Delete this
weigh-in?* / **Delete** · **Keep it**.

**Back-dating lives inside the weigh-in sheet, and that is a consequence of the one-door rule.** If
the chip on the log is the only place a weigh-in is entered, then the sheet it opens has to carry a
date — defaulting to today, changeable through the platform's date picker — or "entered for any
date" is a verb with no door. It does, on all three surfaces.

**A weigh-in is never in the future.** The picker's range ends today, and a date after the device's
local today is refused at the field with *A weigh-in is not a forecast — today or earlier.*; the
server refuses a day more than one past its own UTC today with the same sentence. A served row
dated after the device's today is never the reading and never a dot.

The field refuses one thing at a time, in this order: *That is not a number yet.* · *One decimal
point only.* · *Between 20 and 400 kg — check the number.* It takes comma or point, and says so once
beside it: *comma or point, both read as a decimal*.

Without the repair path a fat-fingered 182 for 82 is permanent and rescales the chart forever. That
would be out of character: gym gives a whole backfill door to a missed session and a fix sheet with
an undo to a mistyped set, precisely because it accepts that people log late and log wrong.

## Unsigned, and not on the ladder

A load in this room is **signed** — a chin-up logs at 0 kg, a band-assisted pull-up at −20 — and the
weight ladder exists to step through plate granularity in both directions.

A bodyweight is none of those things. It is unsigned, it has no plate physics, and it is not stepped
to. **The ladder is not reused here**: the input is a plain decimal field. That is a deliberate refusal
to carry the wrong model into a place it does not belong, and it is why the open zero-crossing item in
`00-README.md` does not reach this feature.

## Units

The log stores kilograms, and the unit toggle is a display transform that two of the three surfaces do
not yet apply. Bodyweight does not ship a fourth opinion: it reads the same setting, and where the
setting does not convert, it draws kilograms and says so in the same words the room already uses.
On the web, where the toggle converts, the reading and the field are in the display unit and the
weigh-in field is the one place the transform runs toward a write — to kilograms, two decimals.

## Coach reads it, and may never write it

One read-level declaration, `list_bodyweight` (`from`/`to` optional, entries day ascending, not
counted in the read receipt), which Coach picks up automatically; its phrase in every step line is
*read your bodyweight*.

Coach may **never** write a bodyweight. A weigh-in is a fact only the lifter observed; an agent writing
one would be inventing a number, which the room's own prompt already forbids in as many words. This is
the same reason Coach cannot log a set. The absence is pinned in the backend suite: no tool whose
name says bodyweight writes, at any grant level, and nothing by that name is `propose_*`.

## The wire

One row per `(user, dateLocal)`: `{ dateLocal, weightKg, recordedAt }`. The identity **is** the local
calendar date (`YYYY-MM-DD`, a real day), so every write is idempotent by that key. Kilograms only on
the wire, two decimals, `20.00 ≤ weightKg ≤ 400.00`. `recordedAt` is the device's clock at the moment
the lifter saved — it can support an omission, never an assertion — and it decides one thing: **the
write with the later `recordedAt` wins**; a stale replay is a 200 that answers the stored row
unchanged, so a replayed old write never overwrites a newer correction. A delete is 204 always.

`GET /v1/gym/bodyweight[?from&to]` answers the window's entries and `latest` — the account's newest
day **whatever the window**, so one windowed read draws both the chart and the log head. The export is
a fourth CSV, `date,weight_kg,recorded_at`.

On the phones a weigh-in is local-first like a set: it lands in one store file per seat beside the
others and is queued to the server, and in the sign-in claim replay it goes **last** — settings,
movements, routines, sessions, then bodyweight, after every session has landed.

## Open

- **Whether a trend belongs here at all.** Day-to-day bodyweight moves a kilo or two on water, so a
  raw series shows some noise. A labelled average over a named window, drawn *over* visible points,
  would be arithmetic on numbers we have; a smoothed line drawn *instead of* the points would be a
  number we do not. This wave draws the points and does not decide the rest.
