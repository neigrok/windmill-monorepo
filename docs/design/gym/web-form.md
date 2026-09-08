# Gym web — form

How the gym web surface is composed and how a number is drawn. Binding on every board of
`Web · Proposed UX` (`vdmdiKWrmZoS1FtcvJRf6O`, `466:132`) and on the implementation that follows it.

Obeys `../brand-foundations.md`, `../guidelines/motion-language.md`, `../guidelines/text-budget.md`,
`briefs/15-the-routine.md`, `briefs/16-the-workout.md`, `briefs/17-set-targets.md`,
`briefs/18-progress.md`.

## The fault

One measure carries every screen. A 1024px column holds a routine name, three movement rows and a
button, so a movement's name and its own Target control sit 700px apart and the eye travels the
width of the page to join two things that belong together. Below the last row, 500px of canvas is
empty. That distance — not the palette, not the type — is what reads as scattered.

Under it, three habits:

- **Words do numbers' work.** `3 movements · 9 sets`, `Remove` nine times, `Set` as a column of
  ordinals, `kg` on every row, `Every set / Set by set` as a mode switch.
- **Repetition stands in for pattern.** Three identical set rows print `8 · 60 kg` three times where
  the scheme says `3 × 8 · 60` once, and the one set that differs looks like the two that do not.
- **Nothing has state.** One focus underline across the whole page. No hover, no pressed, no
  changed, no saved.

## Measures

Three, and nothing between them.

| measure | width | carries |
|---|---|---|
| **read** | 640 | prose, list rows, cards, a conversation |
| **figures** | 420 | a ladder, a set table, a stat trio, a form |
| **desk** | full, split | the log and the routine editor on desktop only |

A board is wrong if its content is shorter than two thirds of its frame. The answer is never a wider
column — it is the split. On desktop the routine editor is **movements left (read), the selected
movement's ladder right (figures)**; there is no sheet. Narrow keeps the sheet.

Vertical: 8px grid. Row heights 44 and 56 only. Section gap 32. Page top 96. The action band sits at
the foot of the **content**, not the viewport, and never floats over empty canvas.

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

## What comes off

| off | on |
|---|---|
| the `#` / `Set` ordinal column | the rail |
| `Every set` / `Set by set` toggle | both sections on the sheet, always — `briefs/17-set-targets.md` forbids the mode |
| the `Sets` field in the head | the ladder is the count; `Add set` is its last row, delete is its trailing `×` |
| `Remove` as a word, nine times | one `×` at the row's trailing edge, faint until the row is hovered or focused |
| `Edit` on a routine card | the card is the door; `⋯` on hover holds Duplicate and Delete |
| `kg` on every row | once, in the column head |
| `3 movements · 9 sets` **and** the movement names | the names, with the set count as a grouped rail |
| `Plan here. Train on your phone.` under every visit | the phone fact belongs where a lifter reaches for a Start that is not there, once |
| a filter pill that reads its own name when set | a set filter reads its value — `2024`, `Bench Press` — and carries a clearing `×` |

Dropping the `Sets` field costs the lifter who wants six sets two taps of `Add set` instead of one
keystroke. The sheet opens on three rows, which is the common count, so the tax falls on the outlier
and buys a field and a column back on every sheet.

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

Every board is drawn at 1440 and 390, in Instrument and Daylight, bound to `gym/*` variables, on the
one fixture of `web-figma-proposal.md`.

1. **Plan** — Routines, Routines empty, Routine editor (desktop split · narrow), Target sheet
   (straight · ladder · open), New routine, stale-save recovery.
2. **Record** — The log, workout reader, past workout, saved-set correction, movement record.
3. **Coach** — conversation, inline proposal, applied and dismissed receipts, Notes.

The shared symbols — the set row, the editable number, the rail, the readout, the row action — are
authored once and instanced by all three.
