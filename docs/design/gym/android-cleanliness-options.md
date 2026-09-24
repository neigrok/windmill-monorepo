# Android target entry — the open concern

Status: design only, nothing built. This is the one Android cleanliness concern still open; the
other four (routine screen, create movement, rest timer, the log) are decided and live as canonical
boards on the Figma page **Android · Screens** — Routines / Detail `813:4935`, Routines / Edit
`820:5572`, Create · Routine · Ready `814:5104`, Account / Gym settings `816:5410`, Log / History
`837:14824`, Log / Moment expanded `837:14932` — with the written canon in the briefs
(`15-the-routine.md`, `18-progress.md`, `11-bodyweight.md`) and the build drift in
`../consistency.md`.

The boards are in the Figma file **Windmill · Gym** (`vdmdiKWrmZoS1FtcvJRf6O`), page
**Android · Screens**, section `Cleanliness & usability options · 2026-09-24` (`813:4817`), concern
frame `03 · Target entry` (`815:5196`). Every board is 412 × 915 in Instrument (night) mode. The
Today board is an unedited clone of the canonical target sheet. A is the standing recommendation
until the owner picks; the round-3 verdicts say where each ranks.

## 03 · Target entry (`815:5196`) — open

This concern covers setting a movement's target in create or edit. Four sets means eight inputs
(reps and kg for each set), and most of them repeat a default. The data stays a per-set scheme.
Each option draws two cases: uniform 4 × 10 · 60 kg, and a 60 / 70 / 80 / 80 ramp. The chosen
create sheet (`814:5104`) carries A's scheme block as drawn, under one annotation, until this
concern is decided.

Round 2 row `823:5322`:

- Today `823:5324`: clone of target sheet `673:2567`.
- **A · One line, fans out** (recommended) — uniform `823:5414`, ramped `823:5545`. One scheme
  line with Sets, Reps and kg steppers. When a set differs, kg fans out by runs: equal neighbours
  share a row (Sets 3–4), so the ramp takes three rows. Ramp up fills from set 1 to the top load in
  plate steps, and Same for all folds the runs back. If reps differ per set, Vary by set opens the
  full per-set ladder. Why it wins: the common case is the prefill plus one or two taps, the ramp
  shows only what differs, it reuses Ramp up, and the same block lives in the create sheet.
- B · Copy-down — uniform `823:5709`, ramped `823:5880`. Every set has a row. Each value flows down
  until the lifter edits a lower set (faint means "follows"). The ramp takes three edits. The
  trade-off is that the sheet always draws every set and the follow rule has to be learnt.
- C · Wheels in the sheet — uniform `823:6062`, ramped `823:6206`. Three wheels, plus a set segment
  to edit one set. A ramp takes four trips, and the wheel is a custom Compose build.
- Components: `Android / Stepper row` `821:5325` and `Android / Mini stepper` `821:5344` (variants
  Own and Follows), on the page **Android · Components**.
- Workout rack, parked as drawn for the owner's wheel test: Today `815:5201` and Wheels `815:5367`.

Round 3 row `836:5727` (subheading `836:5725`, brief `836:5726`), under the round-2 row and above
the rack row. Each option is cloned from A's uniform board, so the editor backdrop, sheet chrome
and commit band are identical; only the sheet content differs.

- **D · Type the scheme** — column `837:5725`, uniform `837:5732`, ramped `837:5886`. One text
  field with a grammar (`sets × reps kg`; loads per set with `/`; a range like `60–80` ramps up
  in plate steps; a leading `–` is band-assisted). The big readout is the live parse, with a token
  per parsed set under it. The field sits on the logger's own keypad, which gains `× / –` and `kg`
  keys, so no letters and no system keyboard; it opens prefilled with last time. Costs: common 0–7
  keys, the ramp 16 keys but exact; keys 87 × 52. TalkBack: text field plus a live region reading
  the parse; a fault is a spoken sentence. Trade-off: the grammar is learnt once and a single
  load is retyped rather than nudged. Ranked below A and E, above B, C, F.
- **E · Your schemes, one nudge** — column `838:5821`, uniform `838:5828`, ramped `838:5953`.
  A wrap row of the lifter's own schemes as FilterChips, counted from their routines and log (most
  used first, six at most, Last time preselected, generic `3 × 10 · 4 × 8 · 5 × 5` on a cold
  start), then exactly one Stepper row for the load (for a ramp it moves every set by the same
  step; the board shows `Top kg · 80`). `Edit sets ›` opens the full editor, which should be A's
  fanned line rather than today's ladder. Costs: common 0–2 taps, a known ramp 1 tap, a new ramp
  A's cost plus one. TalkBack: chips announce selected state. Trade-off: a layer over an editor,
  not an editor, and the chip row needs a rule. Ranked above A: most targets are ones the lifter
  has used before, and recalling one is cheaper than building it.
- **F · Drag the bars** — column `839:5916`, uniform `839:5923`, ramped `839:6064`. A vertical
  slider per set: height is the load, snapped to the band's plate step with a haptic tick, the
  number on top, a `× 10` reps token under it that opens the keypad, a dashed ghost column that
  adds a set. Hold a bar to level every set after it; drag below the floor to remove. The track
  spans a 60 kg window so a plate step is 8 px. Costs: common two gestures (or none from the
  prefill), the ramp three drags. TalkBack: slider semantics per bar. Trade-off: 8 px per step is
  fine motor work, reps are still typed, custom Compose build. Ranked below A, E, D and B, above C.

Designer's order: E · A · D · B · F · C. E wins the common case by recall and needs A behind its
Edit sets; A is the best standalone editor; D writes any shape fastest but must be learnt; B always
draws every set; F is the only one where the picture is the input, and it is less precise than a
stepper; C is four trips and a custom wheel.

## Not verified

These are static boards. The motion, haptics and TalkBack behaviour in the captions are proposals.
No option has been prototyped or tested on a device. The boards were screenshot-checked for
legibility, overflow and black-on-black paints; the parser grammar, the chip-counting rule and the
slider snapping are proposals, none prototyped.
