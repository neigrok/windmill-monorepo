# Windmill The week-N progress card (og-progress-card)

The **recurring** share artifact (#20). `milestone-share-beat` fires **once** — a
limb or the tree completes. This is the one that fires **again**: a "week 3" /
"day 47" image a user posts on a cadence, so a retained user keeps manufacturing
something worth showing long after the first milestone. It extends
**og-tree-cards** (#12) into a **diff poster**. Live specimens:
`explorations/og-progress-card.html`. Physics: `motion-language.md` (X1).

> **One tree, two ink levels.** Everything done *before* the period sinks to a
> memory; this period's completions keep the ordinary full-light done treatment
> and their edges light in their kind. No new node chrome — "newly lit" simply
> *is* what lit looks like, and the past is what a memory looks like.

## The frame — inherited from #12, unchanged
Same **TreePortrait** viewBox fit (own positions → bounds incl. glow → pad 8% →
`meet`), same mat `28·k`, rule `6·k`, panel radius `18·k`, safe `4%`, 1:1 crop,
**light only**, `@2x` (2400×1260). Same generator, one extra argument: the
baseline timestamp.

**The fit never re-frames between periods.** Week 4 must sit in exactly the frame
week 3 sat in, or a feed of cards flickers instead of progressing.

## The ink — the whole mechanism
| Tier | Treatment |
|---|---|
| **New** (this period) | full done: halo, kind fill, specular — identical to in-app |
| **Settled** (done before) | `34%` kind fill, `50%` ring, **no halo**, crown at `42%` |
| **Available** | white disc + kind ring at `55%` |
| **Locked** | `12%` kind fill, `28%` ring |
| **Edge into a new node** | that node's kind, full alpha, **`1.25·E`** — the week's route, drawn |
| **Other lit edges** | bark at `34%`, **`0.8·E`** · dormant `50%`, **`0.65·E`** |

- **Stroke widths are world units, and every one is a ratio.** `E` is the
  renderer's lit-edge stroke (however it's derived — a fraction of the node radius
  is right), and the three widths above are ratios of it, so the route out-weighs
  bark at **every** fit. At the card's clamped fit `1.25·E` lands near `2.4·k`;
  that is a *reading* of the spec, never the spec. A literal `2.4·k` would thin
  the route on a small tree — small trees fit larger, so the strokes around it
  grow while it doesn't — which is backwards.
- **The three edge tiers are exhaustive.** A cross-branch (second-parent) edge
  takes its tier and nothing else: the in-app `0.8` secondary fade must sit out
  here. A faded route reads as less of a route, and at thumbnail size the path has
  to be unambiguous.

## The strip — `120·k` (min 104px), one line taller than #12's 96
```
STAMP    76·k square · radius 20·k · kind-soft fill, kind-deep numeral 34·k ("+3")
ROW 1    period chip (mono 12·k, .1em, kind-deep on kind@16%) · title 27·k Baloo, ellipsis
ROW 2    n/m mono 15·k · gradient bar 110·k · "steps done" 14·k
RIGHT    ledger (≤6 ticks) over the watermark — "Made with Windmill →", wordmark terracotta
```
- **The delta leads, the title follows.** On the milestone card the title is the
  30px line; here it's the stamp. The news really is the number.
- **Hue = dominant kind among the *new* nodes** (tie → terracotta) — not among all
  done. Tints rule, chip, stamp and the current ledger tick.
- **Ledger:** one tick per elapsed period (≤6), `6·k` wide, height ∝ delta capped
  at `30·k`, current in the period hue, past in warm neutral. A quiet period is a
  **floor tick** — shown, never scolded. Default on; one toggle in the sheet
  turns it off, remembered per tree. It is the single element that makes a series
  read as a series — and the one privacy call worth naming: it publishes your
  quiet weeks too.
- **The strip's contents are centred, and the extra `24·k` over #12 buys the type
  *more* bottom clearance, not less.** Measured on the built card: the stamp's
  fill clears the card's bottom edge by `21·k`, the watermark by `23·k`, the
  readout row by `30·k` — against #12's readout at `17·k`. The strip stays
  `120·k`; #12's `FLOOR` (`16·k`, the 2:1-crop number) is the rule it must hold,
  and `4%` is the panel's inset, not the strip's.
- **No step labels, ever.** The portrait is a silhouette, so a private tree can be
  posted without leaking its contents (same rule as #12).

## Baseline & label
- **"New" = completed since your last posted card**; if there is none, since the
  period start. Skip a week and the next card carries both — the sub-line reads
  `done · since week 3` and the stamp counts everything.
- **"Week N" by default, "Day N" by choice** — one segmented control in the share
  sheet, remembered per tree. `#100DaysOfCode` needs the day number to match the
  hashtag; nobody else should have to think about it. **N counts from planting**,
  never the calendar week. Period length is **7 days**.

## How it reads differently from the milestone card
1. Whole tree lit ↔ **one constellation lit** in a dimmed tree.
2. Title leads ↔ **delta leads**.
3. Hue = dominant of all done ↔ **dominant of the new** (diverges by construction).
4. Once, ever ↔ **again next week** — only the recurring card carries the ledger.

Everything else — mat, rule, panel, watermark, fit — is deliberately identical.
It must stay unmistakably the same postcard.

## The offer moment
No new surface. It rides the **welcome-back recap** (motion §7) and speaks in the
milestone toast's grammar:

```
WHEN    first open after a period closes · after the recap's last beat +120ms
TOAST   "Week 3 · 3 steps lit"  + [Share the week]   · hold 6000 · replace 150
SHEET   X2's share sheet, second segment · the card is rendered before it opens
```
- **A quiet period offers nothing** — no card, no toast, no "0 new this week."
- **Two declines in a row retire the offer** for that tree: permanently, silently,
  no confirmation. A toast that fades unanswered **is** a decline — that is
  intended, and it is why the standing verb matters: **retirement may only arm
  where that verb exists** (the share menu's "Share this week" on desktop, the
  action-lane Share button on a phone — X8 §10). No door, no retirement. An
  accelerator may never turn out to be the only door and then close it.
- **Never on the first period**, never mid-session, never on a timer, never twice.
- **Owners only** — visitors get no toasts (X5 §6). A fork's clock starts at its
  own planting.
- **If a milestone lands in the same window the milestone wins** and the week
  offer is dropped, not queued: one pride moment per open, and the bigger one is
  the milestone.
- **Reduced motion:** the recap collapses to one 280ms cross-fade; the toast fades
  without rising.

## Decided
- **Still, not video.** #19 declined per-unlock clips; a *weekly* render bill is
  worse, and a diff is a state comparison rather than a growth.
- **No before/after split frame** — two half-size trees read as neither.
- **No streaks, badges or "you're on fire."** The ledger is a record, not a
  scoreboard; step counts and earned light stay the whole celebration vocabulary.
- **The strip does not grow for the safe box** (build finding 2, 2026-07-25). The
  `48·k` figure is the panel inset; no card ever held it at the bottom edge, and
  the recurring card already clears the bottom by more type-margin than #12 does.
  Growing the strip would make the *recurring* card the conservative one and cost
  the portrait — the dim-tree-with-a-bright-route picture needs that height most.
- **Open:** the 7-day period is an assumption about the beachhead (the same recipe
  re-labels for a daily rhythm with no redesign), and the ledger's 6-tick window
  is a guess at "a season of posting."

## On a phone (X8)

The offer toast sits in the **top transient lane**, under the plaque — *not* the
undo lane, which belongs to undo (X8 §10: an invitation you can accept later sits
off the verb rail; a 4s undo sits in the thumb's). It never stacks with a milestone
toast (the milestone wins).
**Sharing hands off to the OS**: `navigator.share` with the PNG attached, so the
user posts wherever they already post. The in-app sheet (Download / Copy, the
Week/Day segment, the ledger toggle) is the **desktop** form of the same sheet;
on a phone those settings live in the sheet that opens *before* the hand-off.
