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
against the track bed. The zoom grid keeps this border on written cells.

**3. The ring carries the boundary at the floor; the fill carries it at the ceiling.**
The floor ring must separate from the head fill, not only from the canvas.

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
| `--journal-swatch-edge` — unset head, day pip, week square, year cell | ink 34% → `#595B5F`, 2.84:1 vs canvas | ink 46% → `#99958F`, 2.78:1 vs canvas |
| `--journal-head-ring` — the set head, always | ink **78%** → `#BEBEBD` · **10.37:1** vs canvas · **4.38 vs a `mood-0` fill** | ink 68% → `#6C655F` · **5.34:1** vs canvas · 4.22 vs bed · **4.32 vs a `mood-0` fill** |

**Journal has no glows by day.** Every glow in the product — the head, the surge's arc, the lit mood
dot, the lit energy bar, the recording pulse, the echo tabs — is a **bloom by night and an ink
shadow by day, at the same radius**. Only the material changes; radii, timings and keyframes are
authored once. **A glow is never counted toward legibility in either theme**; the ring is the
legibility.

**Focus never touches the head.** The ring is two-tone with a **ground-coloured 2px spacer** between
it and the head, so the outer ring is only ever judged against the canvas — 13.12:1 night, 10.24:1
day, identical at every value. `0 0 0 4px` is a *spread*: the ink band is 2px thick, spanning
2→4px from the head's edge (phone `0 0 0 5px`, a 3px band). Anything that must clear the focus ring
clears that 2→4px band.

The head edge is its border-box outer edge. Size the focus pseudo-element to that box.
Use a solid focus colour so its contrast cannot change with the glow underneath. The glow is
the head's `box-shadow`; the focus ring is `::after` and paints above it.

**Hover previews, press compresses.** On a pointer, a ghost head at the stop under the cursor shows
where a tap would land. Press moves the head and scales it to 0.94; release lets go into the commit
bloom. Under reduced motion the press drops the glow radius instead of scaling.

## 4. The ramp — eleven to enter, five to read

> **Mood is one hue in ELEVEN steps where the value is entered, and one hue in FIVE bands
> everywhere it is read.**

The five shipped anchors are pinned at the **odd** positions 1/3/5/7/9, the evens are their
midpoints, and 0 and 10 extend the slope one more step at each end.

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
- **At most one infinite loop on screen, and the scale ladder adds none.** Every ladder event
  terminates. Today's glyph differences between iOS and web remain in `../consistency.md`.

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
surface. A structural mark must clear the focus band.

The four marks persist equally but differ in extent and local contrast. The ground rule spans
the full track; the held ring stays around its head. Do not claim one is most visible in both themes.

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

Site-wide reduced-motion rules must permit finite, still animations. Record a once-a-day key
on `animationstart`, and treat a computed duration under 50ms as not played. A clamped duration,
hidden ancestor or interrupted mount must not consume the event.

Lightning degrades into a **still photograph of lightning**: the densest arc set drawn static, faded
in and out. The flare's rings are drawn at their final radius rather than expanding. The ground rule
appears instantly instead of drawing from the centre. The hold keeps its whole gesture.

Every **permanent mark** — the wider resting glows at the ends, the surge's charged sheen, the
ground rule — is a static style rather than an animation, so it is byte-identical under reduced
motion.

### The phone

**No transient in the strip may paint into the other scale's row.** Its outer radius stays
within `rowPitch / 2 − 1px`: 23pt at the phone's 48pt pitch. Phone flare uses one ring at
`head + 28px`; motes lead and the ring supports. Expansion remains radially symmetric.
Transients may overflow upward into the writing field.

Desktop uses `head + 44px`. Check its rendered row clearance before changing that value; the
phone limit does not establish desktop acceptance.

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
  one. Every mark takes
  `dragging == nil` as a precondition. The ordinary rest glow is not a mark and does the opposite:
  it follows the shown value.
- The focus ring is additive. If focusing a head erases the head's own ring, the pseudo-element is
  sized to the padding box instead of the border box, and the four monotone axes have collapsed to
  two for every keyboard user.

## 8. Geometry and acceptance

- Specify an offset from the border-box outer edge and name whether it locates a stroke's centreline
  or outer face. Use whole-pixel head borders so border rounding cannot move the focus band.
- Derive platform declarations from that geometry. Web's held-ring box is `head + 13px` because CSS
  borders paint inside; iOS's centred stroke uses `head + 12px`. Both place the centreline at +6px.
  Flare-ring clamps describe the outer face, so an inset stroke is appropriate there.
- Measure contrast against the cue's actual ground: head ring against fill, focus ring against
  canvas, arc against halo. A glow does not establish legibility.
- Check Night and Day at desktop and phone widths, focused and unfocused, dragging and committed,
  with ordinary and reduced motion. State which conditions were rendered; a single specimen does
  not establish the other themes or sizes.
