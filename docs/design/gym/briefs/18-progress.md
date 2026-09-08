# Progress — the movement strip, and the one chart the room draws

The question a lifter brings to the log is *am I getting stronger*. The room answers it per
movement, with the numbers it already has, and refuses every number it does not. The feature is
**Progress**; the word *statistics* names an engine and no screen.

Obeys `12-native-idiom.md`, `13-gestures.md`, `../../guidelines/text-budget.md` and
`../../guidelines/thumb-reach.md`. The chart rules here extend `11-bodyweight.md`, which owns the
primitive.

## Where it lives: the head of the log, as a strip

**The log.** Progress is a reading of what happened, and the log is the record of what happened.
It is not a fourth tab and not a Progress screen: the per-movement screen already exists — the
Record screen — and a second room onto the same chart is two doors onto one value.

> **A horizontal strip of movement cards sits in the head of the log**, under the loaded line and
> the bodyweight reading, above the first week divider. One card per movement trained in the last
> twelve weeks, most recently trained first. **Every card is a door to that movement's Record
> screen.** Nothing on a card writes.

The head scrolls away, and that is right: a chart is read sitting down, and the reach band keeps
exactly one control, the weigh-in chip, at every scroll position. A card is a destination and may
stand in the top band (`12-native-idiom.md`: a destination is not an action).

The strip has no cap. A lifter following a written program works six to ten movements; a strip of
ten cards scrolls sideways and says nothing about which of them matter.

## The consistency sentence

One line in the head, under the loaded line: **`trained 3 of the last 4 weeks`**.

The four weeks are the current local-Monday week and the three before it; a week is trained when
it holds a finished session with at least one working set. The sentence is **absent** when the
count is zero and absent until the account holds sessions in two different weeks — a sentence
about four weeks of nothing is the guilt this room does not ship. It is a count, never a chain:
there is no streak, no target, no arrow, and the number is not coloured.

## The rule every e1RM in the room obeys

Three surfaces printed three different e1RMs for one session: the log row took the best Epley over
every working set, the record page took Epley over the heaviest set, the statistics engine took
Epley over the heaviest set with the most reps. One rule replaces them, and it has a name so that
a screen, a test and a review can point at it.

> **The session estimate.** A session's e1RM for a movement is Epley — `weight × (1 + reps / 30)`,
> and the load itself at one rep — over the working set of that movement with the highest estimate
> among sets of **one to ten reps**, leaving out any set rated **below RPE 7** where an RPE was
> given. A session whose working sets of a movement are all over ten reps, all unrated below 7, or
> all at or below zero load has **no estimate** for that movement. A session's own e1RM — the log
> row's number — is the largest session estimate over the movements it worked.

Ten reps is where Epley's error passes the size of the progress it is meant to show; a twenty-rep
set drawn as a point is a ±15 % claim. Those sets still count for records, tonnage and the weekly
count. RPE is a filter and never a multiplier: an RPE-adjusted series would mix two estimators
the day a lifter starts rating sets.

## The chart is the room's one primitive, and bars have left

Gym drew two chart shapes: bars for e1RM on the Record screen and dots for bodyweight. The bars
could not do their job — from zero, a climb from 100 to 106 kg over twelve weeks is a row of
equal blocks, which is why two of the three Record screens had quietly moved their baseline. **Bars
are retired.** The Record screen and the card draw the primitive `11-bodyweight.md` owns:

> **A dot per session with an estimate, on a truncated and labelled y-axis** — the window's own
> minimum and maximum plus padding — **placed on a time axis** from the window's first day to
> today, so the days since the last session are visibly empty. **A segment joins two dots only
> when the sessions are at most twenty-one days apart**; a longer gap is left empty and carries
> its own label — *no session · 7 Jul – 4 Aug* — naming the last session before it and the first
> after. **The window is stated**: *last 12 weeks · 9 sessions*, *the whole series · 23 sessions*.

Twenty-one days is where the detraining literature puts the first significant loss of maximal
force; a fortnight off is ordinary and a segment across it is honest, a month is not. The
threshold lives in one constant per surface — `SESSION_GAP_DAYS` in `progress.js`,
`Progress.gapDays` in `Progress.swift`, `Progress.maxGapDays` in `Progress.kt` — and in no sentence.
The bodyweight chart keeps seven. One primitive, two series, two thresholds.

**The standing best takes the room's gold** (`--pr-ink`) on exactly one dot, when the session that
set it is inside the window. **In Daylight that dot is an ordinary dot until the Daylight PR token
lands** — the shipped gold holds 3.2:1 on the light card and the ledger already owes the token
(`consistency.md`, line 32); a mark that cannot be seen is not drawn in a colour that lies about it.

**What the chart refuses to draw.** No line across a gap. No rolling maximum, moving average or
fitted trend. No projection. No goal line. No percent change, no arrow, no green, no red. No
number the log does not hold.

## The card

Ours on every surface, identical to the pixel (`12-native-idiom.md`: a chart is Windmill's
vocabulary, not the platform's). Top to bottom:

1. **The name**, row-title style, with the door's chevron.
2. **The chart**, 64 pt tall, with two axis labels — the window's ceiling and floor — and the two
   end dates under it. The compact chart draws no gap labels; a gap is an empty span, and the
   Record screen's full chart names it.
3. **The window line**, the chart's own label: `last 12 weeks · 9 sessions`.
4. **The latest estimate**, one fact row: `e1RM 132.5 · 3 days ago`.
5. **The heaviest working load in the window**, one fact row: `heaviest 120 × 5 · 28 Aug`.

The heaviest load is reachable on the card as **a fact row and not a toggle or a tap**: a toggle
is a control the head would have to remember per card for a reading a lifter takes once, and the
card's one tap is already the door. It is not drawn on the chart beside the estimate — two series
on one axis is a comparison the room does not make.

**The card draws a chart at four sessions with an estimate spanning at least three weeks.** Below
that it draws the facts it has and nothing that looks like a chart:

> *Best so far: e1RM 120, from 100 × 5 on 3 Sep.*
> `3 sessions · since 21 Aug`

A movement with no finished session has no card. A movement inside the window with sessions but no
estimate — every working set over ten reps — draws the sparse state without the best line.

**A bodyweight or assisted movement has no estimate and no chart.** Epley is undefined at or below
zero load and the room does not invent a body fraction to fix it. Its card carries the name and
two fact rows, signed as the ladder signs them:

> `most reps 14 · bodyweight · 3 Sep`
> `heaviest added +10 · 28 Aug` — or `heaviest assisted −20 · 28 Aug`

Never *incl. bodyweight*, never an estimate built on a weigh-in.

## The Record screen follows

The Record screen's e1RM section draws the same primitive at full height (220 pt, as bodyweight)
and gains the two-value window control **12 weeks · All**, default twelve weeks, above the chart.
Its tiles, PR ladder and recent-sets list stay. A dot there is an image named by its session
(*e1RM 132.5 · 5 Sep · 120 × 5*), not a button: a set is repaired in its session, and the chart
offers no second door to it.

## Three surfaces

**iOS.** The strip is a horizontal `ScrollView` inside the log's head section, `.scrollTargetBehavior(.viewAligned)`,
cards 280 pt wide with the room's card gap, the first card inset from the leading edge by the
gutter so the shell's home swipe at depth zero is never contested. Each card is a `NavigationLink`
onto `.movement(id)` in the log tab's path. The chart is a `Canvas`; the dots are one accessibility
element carrying the card's whole label.

**Android.** A `LazyRow` with `rememberSnapFlingBehavior` in the log's `LazyColumn` head item, the
same widths, `contentPadding` at the gutter. A card is `clickable` with `onClickLabel = "open this
movement's record"` and opens `Away.Movement(id)`. Predictive back returns to the log with the
strip where it was.

**Web.** No carousel: the cards are a grid, two across in the centred column and one across at the
phone rule, each an anchor to `#/gym/movement/{id}`. Hover names the nearest dot's session in a
title; the cards are focusable in order. The chart is the design system's `DotChart` with the
21-day `joins` and a 64-px height; the component gains no gym-specific code.

## Both skins, three text sizes

Instrument: dots and segments in `--color-brand` verdigris, segment at `--gym-line-strong` weight,
axis and dates in `--gym-ink-faint`, the standing best in `--pr-ink`. Daylight: the printed card —
dots in `--color-brand` iris, no glow, the standing-best ruling above.

Chart height is fixed in points on every surface. Every other line on the card takes the platform's
text style. **At the largest accessibility size a card takes the full content width** and the
strip pages one card at a time; the two fact rows wrap to two lines each rather than truncate.
Every board in this brief is drawn in both skins and at three text sizes.

## Accessibility

- Card: *Back Squat. e1RM, last 12 weeks, 9 sessions, from 118 on 12 June to 132.5 on 5 September.
  Opens this movement's record.* The sparse card reads its two lines; the assisted card its two rows.
- Consistency sentence: read as written.
- Strip: a list named *Progress by movement*.

## The strings, pinned

| Where | String |
|---|---|
| Consistency sentence | `trained 3 of the last 4 weeks` · `trained 1 of the last 4 weeks` |
| Window line | `last 12 weeks · 9 sessions` · `last 12 weeks · 1 session` · `the whole series · 23 sessions` |
| Window control (Record) | `12 weeks` · `All` |
| Gap label (Record, full chart) | `no session · 7 Jul – 4 Aug` |
| Latest estimate row | `e1RM 132.5 · 3 days ago` · `e1RM 132.5 · today` |
| Heaviest row | `heaviest 120 × 5 · 28 Aug` |
| Sparse card | `Best so far: e1RM 120, from 100 × 5 on 3 Sep.` over `3 sessions · since 21 Aug` |
| Sparse card, no estimate | `3 sessions · since 21 Aug` alone |
| Assisted card | `most reps 14 · bodyweight · 3 Sep` · `heaviest added +10 · 28 Aug` · `heaviest assisted −20 · 28 Aug` |
| Chart head (Record) | `E1RM PER SESSION` |
| Strip, spoken | `Progress by movement` |

The estimate prints through `Readout.estimate` on every surface, so `e1RM 132.5` is the same bytes
the log row already draws.

## The wire

`GET /v1/gym/stats` already answers `movements[{exerciseId, lastTrainedAt, points[{at, weightKg,
reps, e1rm?}], bestE1rm?, heaviest?}]`, most recently trained first, and `weeks[{startedAt,
sessions, workingSets}]` contiguous with zero weeks. The strip reads it once per log open and cuts
the window on the client; the movement's name comes from the catalog the client holds.

Missing, and filed with the backend:

- **The session estimate rule** in `points` — best set by estimate, the one-to-ten rep band, the
  RPE filter — and the same rule behind `topE1rm` on a log row and `e1rmSeries` on the record page,
  so the three readers of one session agree. The record page's `e1rmSeries` and `stats.points`
  should be one projection.
- **Local weeks.** `weeks` are UTC Mondays; the log folds local Mondays. The consistency sentence
  is therefore computed **on the client** from the loaded log, which already folds local weeks and
  carries `workingSetCount` per row — and the log's first page must reach four weeks back for the
  count to be honest. If it cannot, the engine takes a zone and answers `trainedWeeksOfFour`.
- `heaviest` in `/stats` is lifetime; the card's heaviest is the window's. The client takes the
  maximum load over the windowed `points` — the point already carries its `weightKg` and `reps`.

## Open

- **The twelve-week dot grid** (one dot per session per week, no colour, no missed marker) is out
  for now. It is honest, but the strip and the sentence answer the question this wave asks, and a
  grid of empty cells is one reading away from a grid of guilt.
- **Reps at bodyweight as a series.** An assisted card could draw a dot per session of its most
  reps at bodyweight — formula-free and honest. This wave draws the facts and not the dots.
- **Whether the Record screen's `heaviest` deserves its own chart** under the window control, as
  the formula-free reading for a lifter who does not trust Epley.
- **The strip on the web mirror-home.** The web's home is the mirror; the strip lives on `#/gym/log`
  only, and whether the mirror wants the sentence is the mirror's call.
