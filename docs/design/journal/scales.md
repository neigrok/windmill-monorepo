# Journal — the two scales (mood & energy)

Canon for the mood and energy control: what it is, what the numbers mean, how every downstream glyph
reads them, and how the motion behaves.

---

## 1. The two scales

Mood and energy, each **0–10**, are the only structure Journal asks for, and both are optional
forever. Nothing asks for them, blocks on them, or counts a page without them as incomplete.

## 2. The control

Two rows, one per scale, in a three-column grid:

```
MOOD     ●━━━━━━━━━━━━━━━━━━━◯· · · · · · ·        7
ENERGY   ▮━━━━━━━━━▮· · · · · · · · · · · ·        3
         [ label ][      track      ][ numeral ]
```

Identity is carried three times over, so no cue is load-bearing alone:

1. **The word.** A permanent mono `MOOD` / `ENERGY`.
2. **The hue.** Mood is the warm-gold ramp; energy is olive.
3. **The head shape.** Mood's head is a **circle**, energy's an upright **capsule**. Never swap
   them; never use one shape for both.

**A snapping scrubber, not eleven taps.** One track, eleven stops; tap anywhere or drag. A tap
resolves to the nearest stop and a drag corrects in place. The 44px touch rule is honoured by the
**row**, not by the step: row height 24px on a pointer, 44px on a phone, the whole row a hit area
even though the drawn track is 6–8px.

**Clearing is the numeral.** Press it, or press Backspace/Delete on a focused track.

**Stop pitch is `(track − head width) / 10`** — across the head's travel, not across the bed:
52.2 / 23.0 / 16.3px.

## 3. Zero is a value

**`0` is a real answer on both scales.** Unset is a third state, stored as SQL `NULL`, never as `0`.
**Set-but-zero must be distinguishable from unset everywhere the value is drawn.**

| | on the strip | on a day glyph |
|---|---|---|
| unset | hollow head, one size smaller, parked at 0; no fill | pip at 26% ink; tick with **no** baseline |
| **0** | **filled, glowing** head at 0; no fill (there is nothing to fill) | pip in `--mood-0` with its hairline; tick with **the baseline** |

**1. The energy tick carries a 1px olive baseline** under its three bars whenever energy is set at
all, including 0. No baseline means never answered.

**2. Every mood swatch carries a permanent 1px edge — no exemptions**, the strip's own head
included. By day `--mood-0` is `#EDDFB7` on the `#F7F7F5` ground: 1.24:1 against the sheet, 1.02:1
against the track bed. `.journal-zoom-cell.is-written` must stop dropping its border.

**3. The ring carries the boundary at the FLOOR; the fill carries it at the CEILING** — one of the
two is always doing the work, and which one changes across the ramp. Measured on the built strip,
night's ring runs 3.31:1 against the fill at v=0 down to **1.21:1 at v=10** (day 4.81 → 1.83), while
ring-vs-bed climbs 6.04 → 13.65. That is the intended trade: at the ceiling a `mood-10` head is
17.9:1 on the night canvas and separates itself, so the ring is cosmetic there; at the floor the
ring is the only thing working. One colour cannot serve both ends. *This read "carried by its ring
at every value in both themes" until a render sampled the whole ramp — a universal asserted from one
cell, which is §8's error in its purest form.*

The set head's ring is always stronger than the unset head's. *Set* beats *unset* on four monotone
axes at once:

| | unset | set |
|---|---|---|
| ring | `--journal-swatch-edge` | `--journal-head-ring` — stronger in both themes |
| fill | none | the value colour |
| glow | none | yes |
| size | 12px / 16px | 14px / 18px |

Both edges are **ink** mixes — never lamp, never the value.

| Token | Night | Day |
|---|---|---|
| `--journal-swatch-edge` — unset head, day pip, week square, year cell | ink 34% → `#55595C`, 2.76:1 vs canvas | ink 46% → `#99958F`, 2.78:1 vs canvas |
| `--journal-head-ring` — the set head, always | ink **78%** → `#BEBBB3` · **10.17:1** vs canvas · 7.75 vs bed · **4.25 vs a `mood-0` fill** | ink 68% → `#6C655F` · **5.34:1** vs canvas · 4.22 vs bed · **4.32 vs a `mood-0` fill** |

Night's ring was `ink 55%` until a build measured it on composited pixels: fine against the canvas
and the bed, but only **2.29:1 against the `mood-0` fill it exists to separate from**. **The fill is
the ground that matters at the floor**, and it is the one the first draft never sampled. The ring
merges with a bright fill at the top of the ramp in both themes and that is intended — at the
ceiling the fill separates itself, so the ring is optimised for the floor, where it is the only
thing working. One colour cannot serve both ends.

At mood-0 the fill is 1.02:1 against its bed; the boundary is carried on both sides at **>4:1**.

**Journal has no glows by day.** Every glow in the product — the head, the surge's arc, the lit mood
dot, the lit energy bar, the recording pulse, the echo tabs — is a **bloom by night and an ink
shadow by day, at the same radius**. Only the material changes; radii, timings and keyframes are
authored once. **A glow is never counted toward legibility in either theme**; the ring is the
legibility.

**Focus never touches the head.** The ring is two-tone with a **ground-coloured 2px spacer** between
it and the head, so the outer ring is only ever judged against the canvas — 12.78:1 night, 10.24:1
day, identical at every value. `0 0 0 4px` is a *spread*: the ink band is 2px thick, spanning
2→4px from the head's edge (phone `0 0 0 5px`, a 3px band). Anything that must clear the focus ring
clears that 2→4px band.

**And "the head's edge" means the border-box outer edge.** The focus ring lives on a pseudo-element,
and `inset: 0` there resolves to the **padding** box — inside the head's own 1.5px ring — so both
spreads start 1.5px in and the canvas spacer paints straight over the head's ring, erasing it. Built
that way the ink band measured edge +1.00 → +2.88 and the head's ring was absent from the composite.
The consequence is not cosmetic: with the ring gone, §3's four monotone axes collapse to fill + size
for as long as the head is focused — always, for a keyboard user — and at day mood-0 the fill is
1.02:1 against the bed, so **the inversion §3 exists to close comes back under focus**. The
pseudo-element must be sized to the border box. *"Additive, never a replacement" is not a geometry a
builder can implement; name the box.*

Two more things make that invariance real, and both were found by building it. **The focus colour is a
solid hex, never a mix with transparent** — at `ink 88%` the missing 12% lets the head's glow
through and the ring's contrast starts tracking the value again, which is the one thing this
construction exists to prevent. And **the paint order is part of the contract**: the glow is the
head's own `box-shadow` and the focus ring is the `::after`, never the reverse, or the glow paints
over the ring and re-introduces the dependence by another route. A build that swaps them passes a
colour audit and fails the behaviour.

**Hover previews, press compresses.** On a pointer, a ghost head at the stop under the cursor shows
where a tap would land. Press moves the head and scales it to 0.94; release lets go into the commit
bloom. Under reduced motion the press drops the glow radius instead of scaling.

## 4. The ramp — eleven to enter, five to read

> **Mood is one hue in ELEVEN steps where the value is entered, and one hue in FIVE bands
> everywhere it is read.**

The five shipped anchors are pinned at the **odd** positions 1/3/5/7/9, the evens are their
midpoints, and 0 and 10 extend the slope one more step at each end. Stored values migrate
`new = 2·old − 1`; energy 1/2/3 → 2/5/8; stored `0` → `NULL`.

**Read-only glyphs quantise. One rule, no exceptions:**

```
moodBand(v)    0,1 → --mood-1   2,3 → --mood-3   4,5,6 → --mood-5   7,8 → --mood-7   9,10 → --mood-9
energyBars(v)  0..3 → 0 bars    4..6 → 1         7,8 → 2            9,10 → 3
```

Precision lives where the value is entered, and in the export (`mood 7/10`, `energy 4/10`, never
words).

Energy has **one** colour at every value; its magnitude is carried by the fill length and the
numeral, never by hue. There is no olive ramp and there must not be one.

## 5. Motion — the ladder, and the U-curve that governs it

**The extremes are events; between the ends is the quiet baseline.**

| | floor (0) | steps 1–9 | ceiling (10) |
|---|---|---|---|
| **energy** | **the ground** — the charge leaves, the bed shows its whole empty range once, the head sets down, a ground rule strikes and stays | *the ember settle* | **the surge** — lightning arcs across the charged track in three crackle beats, the fill runs hot, the head keeps a wider glow |
| **mood** | **the hold** — the ember dims almost to nothing and comes back; one ring contracts inward; stillness | *the ember settle* | **the flare** — the lamp opens: rings expand (two on desktop, **one on the phone**), light runs the track *backwards* out of the head, six motes rise |

**The ember settle** is the baseline for every commit: a head bloom, a light sweeping the lit part
of the track behind it, the numeral rising into the lamp, and the row's own label warming to the
lamp and back — the label answer says *this is the one you just set*.

### The U-curve

> **Intensity is `k = |v − 5| / 5` — zero at the middle of a scale, one at BOTH ends.**

Every property of the baseline scales by `k`: bloom size, glow, wash alpha and duration, how far the
label reaches toward the lamp, and the iOS commit haptic.

### Bounce and celebration

- **Nothing bounces.** `--journal-ease-catch` is a *single* soft overshoot
  (`cubic-bezier(.34, 1.4, .64, 1)`); there is no oscillation, no spring train, no elastic anywhere
  in this product.
- **The ends of a scale are events, and an event is not a celebration.** They are wordless,
  soundless, fire as readily at zero as at ten, and none of them counts anything.
- **At most one infinite loop on screen, and the scale ladder adds none.** Everything in the ladder
  terminates. *This said "exactly one — today's breathing ember", which is true on iOS
  (`DayGlyphs.swift` breathes today's pip) and false on web, where the canvas draws no glyphs for
  today at all and journal owns no `wm-ember`. Stated as a budget rather than an inventory, because
  the inventory is surface-dependent — and the underlying disagreement about whether today's marker
  draws glyphs is filed as its own drift, not settled here.*

### The permanent marks — two luminous, two structural

Each of the four events leaves a mark that persists while the value stands.

> **A permanent mark is either LUMINOUS or STRUCTURAL, never "a bigger blur."**

| | mark | kind |
|---|---|---|
| energy 10 · the surge | charged sheen on the fill **+** glow at raised alpha | structural + luminous |
| mood 10 · the flare | glow at raised alpha | luminous |
| energy 0 · the ground | the ground rule — 1px olive, full track width | structural |
| mood 0 · the hold | **the held ring** — static 1px `--journal-head-ring`, centreline +6 from the head's edge | structural |

A luminous mark is legitimate only where the value's own colour is bright enough to carry light —
the ceilings, and only the ceilings. A structural mark is a drawn line: ink or olive, high-contrast
in both themes by construction, independent of the value's luminance. **A floor is never lit in the
lamp hue to make it bright.**

Glow alpha ladders with `k` alongside the radius: night 45% → 78%, day 14% → 26%, authored as two
literal tokens per theme — `--journal-head-glow` (rest) and `--journal-head-glow-end` (the ends) —
nothing multiplied at runtime. By day "luminous" means **lifted**: a deeper shadow, not a brighter
bloom. The hold animates alpha `45% → 0 → 45%` at a **constant 6px** radius and leaves no glow mark,
and closes into the held ring at 1020ms.

**The held ring's stroke centreline sits 6px outside the head's edge**, 1px thick, clearing the
focus ink band's +4 by 1.5px on every surface and both breakpoints. That is the geometry. The
*declaration* differs by platform and differing is correct: web uses a **`head + 13px`** box with a
1px border, because CSS draws a border **inside** its box; iOS uses a **`head + 12px`** path with a
**centred** `.stroke`, which already straddles +6. Both land the band at +5.5…+6.5. **Do not
reconcile 13 and 12** — they are one geometry in two stroke models, and reconciling them breaks one
surface. **A structural mark has to clear what is drawn on top of it**, and this is the second time
the held ring was eaten by the focus ring before it did.

The four marks are equal in **presence**, not in **extent**: the ground rule spans the full track
and the held ring is an 82px circumference, so the rule is the largest mark on the strip in both
themes.

**Extent is not visibility, and the two rank differently by theme.** At Night the rule is 536px at
~3.0:1 against the canvas and the ring 82px at 5.47:1 — the rule leads on length at about half the
ring's local contrast. By Day it inverts further: the rule is a pale olive hairline under 2:1 while
the ring is a hard dark donut, so the ring is the crisper mark and the rule leads only by being
long. The honest form is *the ground rule is the most extensive mark, not the most visible one, and
which mark reads crispest depends on the theme.* Device 3 rests on **presence** because presence is
the only property that holds across both themes and all four marks; *equally emphatic*, and any
fixed visibility ranking, are claims this design cannot support.

### The arc is built differently in the two themes

Night is two-pass, a hot core in olive, 14 nodes; branch 0.75px against a 1.25px main.

**By day the arc is a single pass**: one struck opaque `--surge-core` stroke, 7 nodes, all three
beats taking the sparse composition (1 main + 2 branches), with a `drop-shadow(0 0 2.6px …)` on the
group rather than a second set of strokes. Branch weight **1.6px against a 2.2px main**.

**The arc's offset alternates sign (`i % 2`) and carries a floored magnitude
(`0.55 + 0.45·rng()`)** — a discharge, not a random walk; realized peak-to-peak 15.4–28px on the
amplitude-14 main. The sparse day composition depends on it: never ship one without the other, and
no fire may need a hand-picked seed.

### Reduced motion loses the theatre, never the event

**A blanket reduced-motion clamp defeats this, and journal was not the only surface at risk.**
`styles/global.css` used to force `animation-duration: 0.001ms !important` on everything under
`prefers-reduced-motion`. Every *still* form here is authored as a finite animation, so the blanket
rule collapsed them all and removed both blooms on an instant `animationend` — measured, a
reduced-motion reader completing the pair spent the once-a-day key and saw an empty layer. **Fixed
2026-08-23** (the duration nuke gone, iterations and transitions still bounded, the shared waveforms
stilled at the token layer), and verified against the counterfactual. The standing rule, which is
why this survives the fix: **a site-wide clamp must permit finite durations rather than nuking
them** — the next surface to author a still form will come looking here for why theirs did
nothing.

And a rule for anything rationed: **never spend a once-a-day key on an animation that did not
play.** Write the key on `animationstart`, treat a computed duration under 50ms as not played, and
the moment survives a clamped duration, a hidden ancestor or an interrupted mount alike.

Lightning degrades into a **still photograph of lightning**: the densest arc set drawn static, faded
in and out. The flare's rings are drawn at their final radius rather than expanding. The ground rule
appears instantly instead of drawing from the centre. The hold keeps its whole gesture.

Every **permanent mark** — the wider resting glows at the ends, the surge's charged sheen, the
ground rule — is a static style rather than an animation, so it is byte-identical under reduced
motion.

### The phone

**No transient in the strip may paint into the other scale's row.** A transient's outer radius stays
within `rowPitch / 2 − 1px` — 23pt on the phone, where the pitch is 48pt. The flare's rings were
specified at `head + 56px`, which reaches 37pt and crosses into the ENERGY row and its surge arcs;
they are clamped to **`head + 28px`** on the phone, **and the phone drops to a single ring**. This is not a cosmetic rule: **two scales
visually merging is the precise failure this whole redesign exists to fix**, and a mood event
bleeding into the energy row attacks the first of the three asks directly.

Transients *may* overflow the strip **upward** into the writing field — nothing there competes for
meaning, and the flare's motes already rise into it by design. That is allowed and is not a bug.

**Why one ring, and why not an asymmetric one.** Measured on device the clamp holds exactly (outer
radius 22.83pt, clearing the energy row by 3.3pt), but two rings 120ms apart at 2.5 head-radii merge
as a pair — and at each end of their own timeline for a *different* reason. Frozen: at 180 and
300ms they are **a bullseye** — two crisp concentric edges plus the head's own, three rings of
decreasing radius around a filled dot, which is a target or a ripple and not a lamp opening; by
450ms they are mush, overlapping into one fuzzy thickness that is *dimmer* than the single ring
because each is separately fading. At rest the two builds are the same pixel to within a few units,
so the second ring was buying nothing at this radius.

> **At a small radius, concentric rings read as a bullseye, not as an opening.** A target is a thing
> you aim at; an opening is a thing that widens.

That rule is about a *gesture* that must read as opening, and it says nothing against concentric
**static marks**: the held ring sits outside the head's own ring by exactly the same anatomy and
reads correctly, because a mark is allowed to look like a target. Do not delete the held ring in its
name.

**When the ground shrinks, reduce the
count; never crowd the same count into less room** — the identical ruling the Day arc got, for the
identical reason. An upward-biased expansion was proposed and rejected even though the carve-out
would permit it: *opening is radially symmetric*, and biasing it upward turns the gesture into
**rising**, which is what the motes already say — the flare would say one thing twice and lose the
contrast between its own parts. Every way of drawing it also imports vocabulary this product
forbids (an ellipse growing faster vertically is squash-and-stretch; an offset circle reads as
detaching). **On the phone the motes lead and the ring supports, deliberately.** Do not restore the
second ring; it was removed on measurement, not overlooked.

Desktop's `head + 44px` is left as drawn. On arithmetic it also exceeds half-pitch, but it has been
rendered across eleven boards without a reported collision while the phone number had never been
drawn at all and a device found it immediately. Render desktop and apply the same rule if it
crosses; do not shrink it on arithmetic. (See §8 — that is the error this canon keeps making.)

iOS pairs each event with Core Haptics: three transients on the surge's three crackle beats then a
discharge ramp; a swell for the flare; a set-down and its echo for the ground; a dim-and-return for
the hold. The commit haptic carries the U-curve. **Never a
`UINotificationFeedbackGenerator(.success)`.**

## 6. The rules that keep it honest

1. **The U-curve.** `k = |v−5|/5`. **A zero pays exactly what a ten pays.** There is no direction a
   value can move in to be rewarded more.
2. **Both ends of both scales carry a named, full-production event** — the surge *and* the ground,
   the flare *and* the hold — of equal duration and equal permanence of mark, different in texture.
   **Never build the surge without the ground and the hold.**
3. **Every end of every scale carries a permanent mark, and the middle carries none.** Values 1–9
   rest unmarked.
4. **The numeral is never dressed up.** `--lamp-400` at every set value on both scales, no exception
   at the ends.
5. **No streak, no scarcity, no combination bonus.** 10/10 gets nothing 0/0 doesn't. The once-a-day
   pair bloom is capped because completion happens once. The four extreme events are uncapped.
6. **You cannot farm it.** Re-committing the value you are already on fires nothing.
7. **No copy praises a value.** No "nice", no "great day", no emoji, no sound.
8. **Nothing reacts to the *combination* of the two values.** The interface never interprets.

## 7. What must not regress

Checkable claims. Each is a defect if it stops being true.

- No `requestAnimationFrame` loop anywhere in this feature, on either surface. Web animation is
  declarative CSS; the arcs are an SVG overlay built once per fire and removed on `animationend`;
  iOS draws four `Canvas` frames and stops.
- No permanently-composited layer. The overlay elements do not exist at rest, and `will-change` is
  never in a static rule.
- Nothing here animates a layout property, so nothing here reflows.
- Every end of every scale rests with a visible mark and every middle value with none.
- The arc generator's offset is signed and floored. If a fire can come out straight, it is the wrong
  generator.
- The held ring survives focus. If focusing a mood-0 head hides its mark, the ring is inside the
  focus band.
- An answered zero never looks quieter than an unanswered scale, in any of the four
  theme × breakpoint cells. Checkable with a contrast sampler.
- No transient paints into the other scale's row. Upward into the writing field is fine.
- The head ring clears 4.1:1 against the `mood-0` **fill** in both themes — not just against the
  canvas.
- The focus ring's contrast against the canvas does not vary with the value. If it does, the
  ground-coloured spacer has been dropped.
- Nothing fires on mount, load, scroll or hydration. Scrolling back onto a day already at an extreme
  draws the resting marks in silence.
- The scale ladder adds no infinite loop, on either surface.
- The permanent marks are absent for the **whole duration** of a drag, not merely un-triggered by
  one. Gating on the committed value misses a drag that *starts* at an extreme — iOS shipped a
  ceiling glow burning under a mid-value fill all the way down from 10. Every mark takes
  `dragging == nil` as a precondition. The ordinary rest glow is not a mark and does the opposite:
  it follows the shown value.
- The focus ring is additive. If focusing a head erases the head's own ring, the pseudo-element is
  sized to the padding box instead of the border box, and the four monotone axes have collapsed to
  two for every keyboard user.

## 8. Three rules for writing this canon

**An offset names the stroke's centreline, measured from the border-box outer edge; you must know
which face your number names before choosing an API; when two declarations have to agree
geometrically, express both in units the platform cannot round differently; and canon states
GEOMETRY while a platform states a DECLARATION derived from it.** Every platform's convenient default
tucks the drawn band *inward* from the geometry you named: CSS `inset: 0` on a pseudo-element
resolves to the padding box; SwiftUI `strokeBorder` insets the band inside the path, and
`strokeBorder(…).scaleEffect(k)` scales the stroke *width* as well, so a ring that lands by scaling
arrives thinner than authored — an offset error that moves during the animation rather than sitting
still. And Blink **floors a `1.5px` border to `1px` while honouring a `1.5px` inset**, drifting the
whole focus band *outward* to +3→+5: nothing was tucked, the platform simply honoured one of two
numbers that had to agree and rounded the other. That is why the head's ring is pinned at a **whole
pixel** — a fractional border makes the focus geometry engine-dependent, which is worse than being a
pixel off in one engine, and hand-tuning the inset to cancel the rounding would have written that
engine's behaviour into canon. **Fix the cause, not the number that moved because of it:** the held
ring briefly went to +14px chasing the drifted band, and pinning the width put the band back where
it belonged. And a CSS `border` draws **inside** its box, so the held ring declared as a
`head + 12px` box sat a half-pixel in from its stated centreline — 1px of clearance on desktop
instead of 1.5, and on the phone it **abutted the focus ring with no canvas between them**, the
second time that mark has been eaten by that ring. Six defects on two platforms, every one found by
rendering and none by reading.

**Two platforms carrying different numbers for the same geometry is not drift.** The held ring is
web `head + 13px` and iOS `head + 12px`; both put the stroke's centreline at +6. Reconciling them
would break one. Last round two surfaces were nearly left permanently divergent by chasing a
declaration that had moved for an unrelated reason, and this round the same pair looks like drift
and is not — so **write the geometry down first and let every platform number be visibly derived
from it**, or the next reader has no way to tell a correct difference from a bug.

This is not a rule against any API. `strokeBorder` is wrong for the held ring, whose clearance is a
centreline, and **right for the flare's rings**, whose clamp is on the outer face. Pick the API that
puts the stated face on the number, and where a figure here means something other than the
centreline, it says so.


**Specify a cue against what it is drawn on top of** — the head's fill against its bed, the arc's
core against its halo, a mark's glow against the scale's own middle, the held ring against the focus
band, the head ring against the *fill* rather than the canvas, the flare's rings against the row
below. A value can be checked by reading; a **relationship** cannot. Every defect ever found in this
design has been one of these, and the sharpest form of the rule is: **when you quote a contrast
figure, name the ground.** "5.47:1" was true and useless; the ring was 2.29:1 against the thing it
had to separate from.

**A claim observed in one condition is a claim about that condition until it is measured in the
others.** This has now bitten three times on the theme axis — the arc's density inversion, the
loudness ordering of the four marks, and the head ring's floor contrast — and once on the
breakpoint axis, where every motion board was drawn at desktop and the flare's phone radius went
into the other scale's row unnoticed until a device ran it. Journal has two grounds of opposite
polarity and two geometries; **a number is only as measured as its narrowest condition.** Write the
condition into the sentence, or measure the others before writing it unqualified.

The corollary that keeps costing the most: **do not "fix" a number in a condition you have not
rendered.** Desktop's flare radius fails the same arithmetic the phone's did and is deliberately
left alone, because eleven boards drew it without a reported collision. Correcting it from a
calculation would be this same error wearing the opposite face.
