# Gym web — form

How the gym web surface is composed and how a number is drawn. Binding on every board of
`Web · Gym` (`vdmdiKWrmZoS1FtcvJRf6O`, `466:132`) and on the implementation that follows it.

Obeys `../brand-foundations.md`, `../guidelines/motion-language.md`, `../guidelines/text-budget.md`,
`briefs/15-the-routine.md`, `briefs/16-the-workout.md`, `briefs/17-set-targets.md`,
`briefs/18-progress.md`.

## Composition

Center each outer content container within the viewport. Text, movement names and numeric groups
remain left-aligned within it. The amount of content determines the page's height; a short form or
empty state does not need filler to occupy the viewport.

Outer layout and intrinsic content measure are separate rules. A wider workspace may contain a
640px reading region and a 420px numeric form without stretching either one.

| Desktop layout | Outer width | Composition |
|---|---:|---|
| Figures | 420 | Standalone Fix set form; x510 at 1440 |
| Focused | 640 | Routines, routine choice and standalone sharing forms; x400 at 1440 |
| Routine editor | 812 | 360px movement index +32px gap +420px selected-movement task; x314 at 1440 |
| Comparison | 872 | Two 420px regions +32px gap for Edit workout or routine conflict; x284 at 1440 |
| Log | 1024 | 320px history index +24px gap +680px detail; x208 at 1440 |
| Coach and Notes | 1024 | 640px main +32px gap +352px context/navigation rail; x208 at 1440 |
| Past workout form | 1024 | 420px form +32px gap +572px reference; x208 at 1440 |

The reading measure is at most 640px; figures are at most 420px. These are content limits, not
compulsory control widths. The routine editor and movement picker share the selected-movement
pane on desktop; narrow keeps its target and picker sheets.

Related controls stay with their subject. The routine editor groups Cancel and Save with a 24px
gap at the foot of its 420px task pane. Movement totals sit beside their name.
Desktop Apply buttons fit their label and padding; narrow buttons may fill the available width.
A pending routine change belongs inside that routine's card, with its review state and diff.

Narrow is 358 at 16px margins — the width `Gym / Set row` carries. The shared app header uses
12px side insets at narrow widths. The three Gym navigation controls form a centered group
in a 64px bottom panel; the panel also consumes the bottom safe-area inset.

Vertical: 32px between sections, 24px inside sections, and 8/12/16px between related elements,
using auto-layout gaps and padding. Editable and movement row heights are 44 and 56; the history
index uses 48. Card radius is 16; editable rows, progress cards and action-band buttons retain 12.
Authenticated boards carry the `Web shell`; their content starts one section
gap below the 52px header, at y84 on desktop and narrow screens. The content scroll region ends
above the bottom navigation panel. Public recipient and preview boards use their
own header and content measurements. The action band sits at the foot of the **content**, not
the viewport. The narrow Log keeps its entry actions in an 86px footer directly above the
bottom navigation: Weigh in beside Add past workout, both 54px high. On desktop the pair sits
in the Log header. Share log is a 20px share icon in a 44px target, with an accessible name.

## The numeric row

One primitive, drawn the same everywhere a load meets a rep count.

> **One set is `60 × 8`** — load, the multiplication sign, reps. JetBrains Mono, tabular figures,
> the `×` at `--gym-ink-faint` and the numerals at `--gym-ink`. The nulls print as `last` and `max`.
>
> **A scheme is `3 × 8 · 60`** — sets, reps, load, per `briefs/17-set-targets.md`. A column whose
> sets disagree prints its range: `5 × 1–5 · 60–100`.

The unit is named once per surface — in a column head or the movement line — never on a row. The two
vocabularies are never mixed on one line.

**The rail.** A set's identity is its position, so the ordinal column comes off and a rail of ticks
takes it: one 2px tick per set at the row's leading edge, lit for a set that landed, outlined for the
set in hand, faint for a set still to come. The rail says *set 3 of 5* in 10px of width and reads at a
glance, which a column of `1 2 3 4 5` never did.

**Agreeing sets collapse.** A movement whose sets agree prints one line — `3 × 8 · 60` with a
three-tick rail — and expands on click. A movement whose sets disagree prints its rows, because the
difference *is* the content. This is the rule that empties the workout reader.

## Controls

- Both Every set and Set by set remain visible on web; the ladder supplies the count.
- Add set is last. A trailing `×` removes a row and appears on hover or focus.
- The routine card opens its editor; More holds Log past and Delete.
- Movement names and grouped set rails provide the routine summary without a repeated count line.
- Units appear once per column. A selected filter shows its value with a clearing `×`.
- Explain phone-only logging at the relevant entry point, without a permanent planning caption.

## Microinteraction

Feedback class throughout — immediate, never queued, inside the ceilings of
`../guidelines/motion-language.md`. Reduced motion keeps every colour ramp and drops every spatial one.

| moment | the beat |
|---|---|
| row hover | surface lifts to `--gym-surface`, the trailing `×` and the `⋯` fade in — 150ms `--ease-standard` |
| number focus | the underline grows from centre to full width, 180ms `--ease-soft`; tabular figures, so nothing shifts |
| the `×` between load and reps | `--gym-ink-faint` at rest, `--gym-ink-dim` while its row is hovered or focused — it is the row's own focus mark |
| a number changes | the numeral ink-lifts to `--color-brand` and settles back over 280ms `--ease-standard`; no background flash |
| `Add set` | the row enters `wm-fade-in-up`, 280ms `--ease-soft`; its rail tick draws in behind it |
| delete a row | the row collapses its height over 180ms `--ease-standard`; the rail re-ticks |
| save | the button's label is replaced by its own readout — `Saved · 3 × 8 · 60` — for 900ms, then returns. No toast |
| a proposal applies | the old value dims and the new brightens across the `→`, 280ms; the row keeps its place |
| the slot in hand | the outlined tick and nothing else. No loop — the calm ceiling spends its one loop on the roadmap's crown |

## The boards

Every state is drawn at 1440 and 390, bound to `gym/*` variables, on the fixtures of `log-exploration.md`.
Compare every state in both Instrument and Daylight; `web-build-contract.md` owns acceptance requirements.

1. **Plan** — Routines, Routines empty, Routine editor (desktop split · narrow), Target sheet
   (straight · ladder · open), New routine, stale-save recovery.
2. **Record** — The log, workout reader, past workout (`briefs/20-past-workout.md`), saved-set correction,
   movement record.
3. **Coach** — conversation, inline proposal, applied and dismissed receipts, Notes.

The shared symbols — the set row, the editable number, the rail, the readout, the row action — are
authored once and instanced by all three.
