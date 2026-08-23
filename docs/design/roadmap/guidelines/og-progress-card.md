# Windmill The week-N progress card (og-progress-card)

The recurring share artifact: a "week 3" / "day 47" image posted on a cadence. It extends the
per-tree unfurl card (`og-tree-cards.md`) into a diff poster. Physics: `motion-language.md`.

> One tree, two ink levels. Everything done before the period sinks to a memory; this period's
> completions keep the ordinary full-light done treatment and their edges light in their kind. No
> new node chrome.

## Frame

Same TreePortrait viewBox fit (own positions → bounds incl. glow → pad 8% → `meet`), mat `28·k`,
rule `6·k`, panel radius `18·k`, safe `4%`, 1:1 crop, light only, `@2x` (2400×1260). Same generator
as the unfurl card, one extra argument: the baseline timestamp.

The fit never re-frames between periods — week 4 sits in exactly the frame week 3 sat in.

## Ink

| Tier | Treatment |
|---|---|
| New (this period) | full done: halo, kind fill, specular — identical to in-app |
| Settled (done before) | `34%` kind fill, `50%` ring, no halo, crown at `42%` |
| Available | white disc + kind ring at `55%` |
| Locked | `12%` kind fill, `28%` ring |
| Edge into a new node | that node's kind, full alpha, `1.25·E` |
| Other lit edges | bark at `34%`, `0.8·E` · dormant `50%`, `0.65·E` |

- Stroke widths are ratios of `E`, the renderer's lit-edge stroke, never literal pixel figures, so
  the route out-weighs bark at every fit.
- The three edge tiers are exhaustive. A cross-branch (second-parent) edge takes its tier and
  nothing else — the in-app `0.8` secondary fade sits out here.

## Strip — `120·k` (min 104px)

```
STAMP    76·k square · radius 20·k · kind-soft fill, kind-deep numeral 34·k ("+3")
ROW 1    period chip (mono 12·k, .1em, kind-deep on kind@16%) · title 27·k Baloo, ellipsis
ROW 2    n/m mono 15·k · gradient bar 110·k · "steps done" 14·k
RIGHT    ledger (≤6 ticks) over the watermark — "Made with Windmill →", wordmark terracotta
```
- The delta leads, the title follows: the stamp is the headline, not the title.
- Hue = dominant kind among the **new** nodes (tie → terracotta), not among all done. Tints rule,
  chip, stamp and the current ledger tick.
- Ledger: one tick per elapsed period (≤6), `6·k` wide, height ∝ delta capped at `30·k`, current in
  the period hue, past in warm neutral. A quiet period is a floor tick — shown, never scolded.
  Default on; one toggle in the sheet turns it off, remembered per tree. It publishes quiet weeks
  too, which is the one privacy call worth naming.
- Contents are centred. The strip stays `120·k` and holds the unfurl card's `FLOOR` (`16·k`); `4%`
  is the panel's inset, not the strip's. Re-measure the clearance whenever the strip changes.
- No step labels, ever — the portrait is a silhouette, so a private tree can be posted without
  leaking its contents.

## Baseline & label

- "New" = completed since your last posted card; if there is none, since the period start. Skip a
  week and the next card carries both — the sub-line reads `done · since week 3` and the stamp
  counts everything.
- "Week N" by default, "Day N" by choice — one segmented control in the share sheet, remembered per
  tree. N counts from planting, never the calendar week. Period length is 7 days.

## The offer moment

No new surface. It rides the welcome-back recap (motion §7) and speaks in the milestone toast's
grammar:

```
WHEN    first open after a period closes · after the recap's last beat +120ms
TOAST   "Week 3 · 3 steps lit"  + [Share the week]   · hold 6000 · replace 150
SHEET   the share sheet, second segment · the card is rendered before it opens
```
- A quiet period offers nothing — no card, no toast, no "0 new this week."
- Two declines in a row retire the offer for that tree: permanently, silently, no confirmation. A
  toast that fades unanswered is a decline, which is why retirement may only arm where a standing
  verb exists (the share menu's "Share this week" on desktop, the action-lane Share button on a
  phone — `mobile.md` §10). No door, no retirement.
- Never on the first period, never mid-session, never on a timer, never twice.
- Owners only — visitors get no toasts. A fork's clock starts at its own planting.
- If a milestone lands in the same window the milestone wins and the week offer is dropped, not
  queued.
- Reduced motion: the recap collapses to one 280ms cross-fade; the toast fades without rising.

## Never

- Video — the card is a still.
- A before/after split frame; two half-size trees read as neither.
- Streaks, badges or "you're on fire." The ledger is a record; step counts and earned light are the
  whole celebration vocabulary.
- Growing the strip for the safe box. `48·k` is the panel inset; the strip holds `FLOOR` instead,
  and the height belongs to the portrait.

## Open

- The 7-day period is an assumption; the same recipe re-labels for a daily rhythm with no redesign.
- The ledger's 6-tick window is a guess at a season of posting.

## Phone

The offer toast sits in the top transient lane, under the plaque — not the undo lane, which belongs
to undo (`mobile.md` §10). It never stacks with a milestone toast. Sharing hands off to the OS via
`navigator.share` with the PNG attached; the in-app sheet (Download / Copy, the Week/Day segment,
the ledger toggle) is the desktop form, and on a phone those settings live in the sheet that opens
before the hand-off.
