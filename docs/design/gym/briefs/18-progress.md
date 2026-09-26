# Progress — the movement strip, and the one chart the room draws

The question a lifter brings to the log is *am I getting stronger*. The room answers it per
movement, with the numbers it already has, and refuses every number it does not. The feature is
**Progress**; the word *statistics* names an engine and no screen.

Obeys `12-native-idiom.md`, `13-gestures.md`, `../../guidelines/text-budget.md` and
`../../guidelines/thumb-reach.md`. The chart rules here extend `11-bodyweight.md`, which owns the
primitive.

## Where it lives: the log — a strip on web and iOS, moments woven in on Android

**The log.** Progress is a reading of what happened, and the log is the record of what happened.
It is not a fourth tab and not a Progress screen: the per-movement screen already exists — the
Record screen — and a second room onto the same chart is two doors onto one value.

> **Web and iOS: a horizontal strip of movement cards sits in the head of the log**, under the
> loaded line and the bodyweight reading, above the first week divider. One card per movement
> trained in the last twelve weeks, most recently trained first. **Every card is a door to that
> movement's Record screen.** Nothing on a card writes.

> **Android (boards `837:14824` and `837:14932`): no strip and no head
> numbers. Progress is woven into the session list where it happened.** A **moment** is a quiet
> one-line outlined card between the sessions, dated like them: *Bench Press · new best · 76 kg
> est · up 4 kg since August* with a dot trail, *Weighed in · 82.4 kg*, or *Trained 4 of the last
> 4 weeks* when a month is trained in full. Three kinds, at most one card a week. Tapping a moment
> **expands it in place** to the movement's dot chart, its window line, best and heaviest, and
> `Open record ›`; a weigh-in moment opens Bodyweight. Numbers appear only on the day they mean
> something, so a plateau reads as a calm list. The Record stays reachable from every movement
> name on a session's readback (`Caption · Readback` `850:14915`), so a lifter without a moment
> to open still has a door.

The head scrolls away, and that is right: a chart is read sitting down, and the reach band keeps
exactly one control, the weigh-in chip, at every scroll position. A card is a destination and may
stand in the top band (`12-native-idiom.md`: a destination is not an action).

The strip has no cap. A lifter following a written program works six to ten movements; a strip of
ten cards scrolls sideways and says nothing about which of them matter.

## The consistency sentence

One line in the head, under the loaded line: **`Trained 3 of the last 4 weeks`**.

The four weeks are the current local-Monday week and the three before it; a week is trained when
it holds a finished session with at least one working set. The sentence is **absent** when the
count is zero and absent until the account holds sessions in two different weeks — a sentence
about four weeks of nothing is the guilt this room does not ship. It is a count, never a chain:
there is no streak, no target, no arrow, and the number is not coloured.

## The rule every e1RM in the room obeys

Android's Log captions, movement strip and Record screen use one complete progress projection.
Its session estimate is the shared rule for qualification, ranking and display.

> **The session estimate.** A session's e1RM for a movement is Epley — `weight × (1 + reps / 30)`,
> and the load itself at one rep — over the working set of that movement with the highest estimate
> among sets of **one to ten reps**, leaving out any set rated **below RPE 7** where an RPE was
> given. A session whose working sets of a movement are all over ten reps, all rated below 7, or
> all at or below zero load has **no estimate** for that movement. A session's own e1RM — the log
> row's number — is the largest session estimate over the movements it worked.

Sets outside the estimate's qualification still count for records, tonnage and the weekly count.
RPE is a filter, never a multiplier. Retain the unrounded estimate for ranking; format only the
displayed value. A one-rep estimate is exactly the logged load.

## The chart is the room's one primitive, and bars have left

The Record screen and the card draw the dated-dot primitive `11-bodyweight.md` owns:

> **A dot per session with an estimate, on a truncated and labelled y-axis** — the window's own
> minimum and maximum plus padding — **placed on a time axis** from the window's first day to
> today, so the days since the last session are visibly empty. **A segment joins two dots only
> when the sessions are at most twenty-one days apart**; a longer gap is left empty and carries
> its own label — *no session · 7 Jul – 4 Aug* — naming the last session before it and the first
> after. **The window is stated**: *last 12 weeks · 9 sessions*, *the whole series · 23 sessions*.

The twenty-one-day threshold lives in one constant per surface — `SESSION_GAP_DAYS` in `progress.js`,
`Progress.gapDays` in `Progress.swift`, `MovementProgress.maxGapDays` in Android `Progress.kt` — and in no sentence.
The bodyweight chart keeps seven. One primitive, two series, two thresholds.

**The standing best takes the resolved PR token** on exactly one dot, when the session that set it
is inside the window. Android resolves `prInk` from the shared Instrument or Daylight palette.
The earliest session wins an equal standing mark; equal-time
sessions and set ties use the deterministic identity ordering in `../android-delivery.md`.

**What the chart refuses to draw.** No line across a gap. No rolling maximum, moving average or
fitted trend. No projection. No goal line. No percent change, no arrow, no green, no red. No
number the log does not hold.

## The card

Ours on every surface, identical to the pixel (`12-native-idiom.md`: a chart is Windmill's
vocabulary, not the platform's). Top to bottom:

1. **The name**, row-title style, with the door's chevron.
2. **The chart**, 90dp tall on Android and 64pt on the other surfaces, with two axis labels — the window's ceiling and floor — and the two
   end dates under it. The compact chart draws no gap labels; a gap is an empty span, and the
   Record screen's full chart names it.
3. **The window line**, the chart's own label: `last 12 weeks · 9 sessions`.
4. **The latest estimate**, one fact row: `e1RM 132.5 · 3 days ago`.
5. **The heaviest working load in the window**, one fact row: `heaviest 120 × 5 · 28 Aug`.
6. **The best estimate in the window**, one fact row in the PR ink: `best e1RM 132.5 · 28 Aug`.
   It is what the chart's gold point means, said in words — the point may not carry that meaning in
   colour alone. A window whose best is its latest draws the row once, on the latest.

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

The Record screen's **Estimated strength** section draws the same primitive at full height (220 pt, as bodyweight)
and gains the two-value window control **12 weeks · All**, default twelve weeks, above the chart.
Its tiles, PR ladder and recent-sets list stay. A dot there is an image named by its session
(*e1RM 132.5 · 5 Sep · 120 × 5*), not a button: a set is repaired in its session, and the chart
offers no second door to it.

## The chart is touched, and where

A chart that only shows is half a chart: the lifter puts a finger on a dot and reads the session
it came from. Two gestures, and a rule about where they live.

> **The interactive chart is the Record screen's. The card on the log's strip is a static preview
> and a door.** The strip already scrolls sideways inside a list that scrolls up; a third pan axis
> inside a card would fight both, and a scrub that starts on the wrong pixel would scroll the strip
> instead. The card is also in the top band, where `thumb-reach.md` allows a destination and no
> control. One tap on the card lands on the full chart with the same window, under the thumb.

**Android scrub.** A held touch selects the nearest dot by x and updates one readout above the
plot. The readout includes the estimate, local day and actual set, and wraps at large text without
covering a point. Releasing returns immediately to the latest point's readout. A movement before
the native hold threshold pans instead. Selection feedback is an ordinary native light tick and
is independent of the removed set-confirmation sound and haptics.

**Other surfaces' scrub.** A finger down on the chart selects the nearest dot by x and holds it while the finger
moves; the readout says the estimate, the day and the set — `102.5 kg est · 3 Sep · 95 × 5` — and
follows the finger. It **never covers the dot it names**: it sits above the dot, and beside it —
on the side with more room — when the dot is in the top quarter of the plot. The selected dot grows
by one ring and every other dot keeps its ink. Lifting the finger keeps the readout for
**`SCRUB_HOLD_MS` = 1500** and then clears it; the constant lives in `progress.js`,
`Progress.scrubHold` in `Progress.swift`, and in no sentence. Each change of selected dot fires the platform's light tick — `.selection` feedback on
iOS, `HapticFeedbackType.SegmentFrequentTick` on Android — and never the impact the record row
uses. The readout is one line in the fact style, the same bytes in both skins and at every text
size; at the largest size it wraps to two lines above the plot rather than shrinking.

**Pan.** The plot uses a nominal **`POINT_PITCH_PT` = 24** points of width per distinct session time. Android
preserves true time positions: equal timestamps share an x coordinate, and short time intervals
are never expanded independently to invent dates. When the
window's sessions need more than the card's plot — about thirteen sessions at the phone rule —
the chart is wider than the card and pans sideways with momentum, opening at its **right edge, the
most recent session**, and stopping at both ends. The axis labels stay pinned; the window line
stays what it was — *last 12 weeks · 31 sessions* — because the window did not change, only the
part of it in view. A pan and a scrub are told apart by the platform's own recogniser: a touch that
moves before it holds pans, a touch that holds scrubs.

**Zoom is out.** The window control is the zoom.

**Web.** Hover is the scrub, drag is the pan, `←` `→` step dots when the plot is focused, and the
readout is the accessible name of the focused dot. No wheel zoom.

**Nothing on the readout is red, green, arrowed or a percentage.** It names one session.

**Accessibility, both phones.** Each dot is a focusable element whose label is its readout, in date
order; the plot is a group named by the window line and carries two custom actions, *earlier
session* and *later session*, so a reader steps without a gesture. The readout's text is also
announced on each change while scrubbing.

## Three surfaces

**iOS.** The strip is a horizontal `ScrollView` inside the log's head section, `.scrollTargetBehavior(.viewAligned)`,
cards 280 pt wide with the room's card gap, the first card inset from the leading edge by the
gutter so the shell's home swipe at depth zero is never contested. Each card is a `NavigationLink`
onto `.movement(id)` in the log tab's path. The chart is a `Canvas`; the dots are one accessibility
element carrying the card's whole label.

**Android.** No strip. Moments are items of the log's `LazyColumn`, keyed like sessions and dated
by the session or weigh-in that earned them; an expanded moment is the same item grown in place
(`animateContentSize`), never a navigation. `Open record ›` opens `Away.Movement(id)`; so does a
movement name on the session readback (`SessionScreen.kt:428`). Predictive back returns to the log
with the moment still open.

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
| Consistency sentence | `Trained 3 of the last 4 weeks` · `Trained 1 of the last 4 weeks` |
| Window line | `last 12 weeks · 9 sessions` · `last 12 weeks · 1 session` · `the whole series · 23 sessions` |
| Window control (Record) | `12 weeks` · `All` |
| Gap label (Record, full chart) | `no session · 7 Jul – 4 Aug` |
| Latest estimate row | `e1RM 132.5 · 3 days ago` · `e1RM 132.5 · today` |
| Heaviest row | `heaviest 120 × 5 · 28 Aug` |
| Sparse card | `Best so far: e1RM 120, from 100 × 5 on 3 Sep.` over `3 sessions · since 21 Aug` |
| Sparse card, no estimate | `3 sessions · since 21 Aug` alone |
| Assisted card | `most reps 14 · bodyweight · 3 Sep` · `heaviest added +10 · 28 Aug` · `heaviest assisted −20 · 28 Aug` |
| Chart head (Record) | `Estimated strength` |
| Strip, spoken | `Progress by movement` |
| Scrub readout | `102.5 kg est · 3 Sep · 95 × 5` · `102.5 kg est · today · 95 × 5` |
| Reader actions on the plot | `earlier session` · `later session` |

The estimate prints through `Readout.estimate` on every surface, so `e1RM 132.5` is the same bytes
the log row already draws.

## The wire

Android reads `GET /v1/gym/stats?projection=progress` for a complete owner-scoped snapshot:
`{asOf, sessions:[{sessionId, startedAt, movements:[{exerciseId, workingSetCount, heaviest,
estimate?}]}]}`. Each performed fact retains `setId`, `weightKg`, `reps` and optional `rpe`;
the qualified estimate also carries `e1rm`. Signed, zero and no-estimate working facts remain
present. Sessions sort by `(startedAt, sessionId)` and movements by exercise ID. Equal estimates
choose the smaller set ID; heaviest-load ties choose more reps, then the smaller set ID.

Log captions, strip facts and the complete Record series derive from that same snapshot. The
client cuts the twelve-week window and computes current-plus-three local-Monday weeks with the
device zone, independently of session pagination. All means the complete lifetime series.
Movement names and record metadata, aliases and recent sets retain their existing reads.

The snapshot is cached per owner and refreshed or invalidated after finish, correction, deletion,
rename and ownership changes. A failed read preserves loaded Log rows and states the failure;
it cannot fall back to differently qualified legacy estimates or call a partial series All.
The legacy stats, record and Review responses remain compatible for web, iOS and MCP.

## Open

- **The twelve-week dot grid** (one dot per session per week, no colour, no missed marker) is out
  for now. It is honest, but the strip and the sentence answer the progress question, and a
  grid of empty cells is one reading away from a grid of guilt.
- **Reps at bodyweight as a series.** An assisted card could draw a dot per session of its most
  reps at bodyweight — formula-free and honest. This wave draws the facts and not the dots.
- **Whether the Record screen's `heaviest` deserves its own chart** under the window control, as
  the formula-free reading for a lifter who does not trust Epley.
- **The strip on the web mirror-home.** The web's home is the mirror; the strip lives on `#/gym/log`
  only, and whether the mirror wants the sentence is the mirror's call.
