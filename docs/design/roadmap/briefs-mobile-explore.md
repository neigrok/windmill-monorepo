# Windmill — design tasks from the explore wave · 25 July 2026

Three asks (**21–23**) that came out of shipping the phone's explore primitives
(`guidelines/mobile.md` §4, reconciled the same day). They continue the numbering in
`briefs.md`; nothing here supersedes that file's open batch (10–17).

All three are **findings, not speculation** — each was measured or reproduced on a real
build, and each is stated with what was measured so you can disagree with the evidence
rather than with me. Two are small. The third (#23) is a ruling that binds #16 at arming
time, and is best made before tending goes live rather than after.

---

## 21 · The dim fruit can't carry tier in daylight — *new, small but load-bearing*

**Status:** measured, not guessed. Found while shipping the explore primitives
(`guidelines/mobile.md` §4/§6, 2026-07-25).

**Why:** X8's audit was right that **tier belongs to the fruit** rather than to the row
title's colour — locked titles were `#928165` on cream, 3.5:1, under the floor, on the most
numerous row type on the screen. That's fixed: titles are back at `--text-secondary` (5.7:1)
and the lock glyph moved inside the fruit. But moving the whole "locked" signal into the
fruit exposed that **the fruit doesn't carry it**. Measured across all six kinds, both
themes:

| | lock glyph vs fruit fill | fruit fill vs canvas | fruit ring vs canvas |
|---|---|---|---|
| light | 2.75 – 3.03 | **1.14 – 1.29** | 1.34 – 1.85 |
| dark | 3.49 – 4.04 | **1.14 – 1.29** | 1.37 – 1.85 |

The locked fill is `color-mix(kind 18%, surface)`. At 1.2:1 it is *invisible* against the
canvas, so a **locked plum step and an available plum step differ by an 11px smudge** on a
phone in daylight. Five of six kinds also put the lock glyph under the 3:1 floor for a
meaningful non-text graphic; we lifted the glyph to `--text-secondary` as a patch, but the
treatment underneath is what's thin.

This predates the wave and ships today on every locked row.

**Not a token swap.** Raising contrast naively turns every locked step into a loud dot and
inverts the visual hierarchy — locked steps are the *majority* of a healthy tree and must
stay quiet while still being **distinguishable at arm's length**. The likely shape is a
solid ring at full kind strength with the *fill* carrying the dimming, but that's yours.

**Design:** the three fruit tiers (done / available / locked) as they read on a phone in
daylight, both themes, all six kinds, at 24px. **Deliver:** the treatment + the measured
contrast for each pair. Related: the same wave found a locked row is byte-identical to an
available one for a screen reader — that half is fixed (state is in the row's accessible
name), so this is purely the sighted case.

---

## 22 · The phone type ramp vs iOS's 16px zoom floor — *new, small, one ruling*

**Why:** Safari zooms the entire page whenever a focused input renders under 16px, and the
user has to pinch back. Our two oldest phone text surfaces are both **13.5px** — `EditField`
(every inline rename and describe in the list) and the need-picker's filter. So *the*
canonical mobile edit — tap a row, rename it — punts the viewport on a real iPhone.

The picker's search field is fixed (it's a search field, like §4's new one, which is 16px
and therefore fine). `EditField` is the ruling: it sits **inside a row**, so bumping it to
16px changes the row type ramp the X8 audit measured, and a row whose text grows on entering
edit mode is its own kind of wrong.

**The question:** does the list's row text move to 16px (a ramp change, applied
consistently), or does the edit field render at 16px and get **visually** scaled back to sit
in the row (honest to the platform, at the cost of a transform), or is there a third answer?

**Design:** the ruling plus, if the ramp moves, the corrected phone type scale. **Deliver:**
one paragraph and, if needed, the ramp. This is small and it blocks nothing — but it is a
real defect on the primary platform, and it will keep being rediscovered until it's ruled.

---

## 23 · One input or two? The search field and the Tend bar want the same screen — *new, medium, ties to 16*

**Why:** `guidelines/mobile.md` §7 now forbids two text inputs being up at once, because
with the keyboard raised a header search field and the Tend bar bracket a **~200px sliver**
of results and both read as "type here". That rule is a *guard*, and guards are what you
write when you haven't decided the thing. Tending is dark today, so the collision isn't live
— which makes this exactly the right moment to rule it.

The guard says: typing in the header is a **lookup** (read), the Tend bar is **intent**
(write), so they must not co-exist. Defensible. But there is a bolder answer worth ruling on
before #16 arms:

> **One input at the bottom.** Typing filters the list live; **send** hands the same
> sentence to the agent. Typing is read, send is write — one surface, one teachable split.

It would dissolve the collision rather than police it, put the field where the thumb
actually is (the top of a scrolling list is the far end of the reach — §5's own argument),
and solve a discoverability problem the guard leaves standing: a magnifier means *recall*
("I can name the thing"), while the more common phone question is *recognition* ("show me the
backend stuff"). It would also mean the header stops needing a search affordance at all,
which buys back the one slot §5 grudgingly spends above the fold.

**The counterweight,** and why this is a ruling and not a foregone conclusion: it overloads
one field with two outcomes distinguished only by whether you press send — and a mistaken
send is a *write*, where a mistaken filter is nothing. It also puts a filter behind an
affordance that looks like a chat composer, which is precisely the "wrapper around a chatbot"
failure #16 is written to avoid.

**Design:** rule it — one input or two — and if one, the surface: how a live filter and a
pending sentence share a field, what send looks like versus what typing looks like, and how
the results and the theatre share the screen. **Deliver:** the ruling, and the surface if it
goes that way. It binds #16's arming, so earlier is better.
