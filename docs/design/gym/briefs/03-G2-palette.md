# G2 · Gym's palette and visual identity

**Blocks:** every gym surface. Land it with or immediately after `G1`.
**Precedent:** journal's scoped palette (`web/src/products/journal/journal.css`) — a product that
owns its surface without touching the global theme.

## The decision to make

Windmill's brand is light-only by standing decision. Journal broke that deliberately and correctly:
its canvas is night by default and day by choice, scoped inside `.journal-root[data-theme]` so the
global theme is untouched and the design system's ramps still resolve inside it.

**Gym gets the same right, and should probably use it.** A gym is dim, the phone is at arm's length,
the user is looking at it for two seconds between efforts. Make the call and justify it: does gym
read as a warm daylight tool, a dark high-contrast instrument, or — like journal — one surface with
two skins?

Whatever you choose, it is **scoped to `.gym-root`**. It never changes the shell, the account seat,
the settings page, or the other two products.

## What the palette has to carry

- **A number that reads at arm's length.** The weight is the largest, highest-contrast thing in the
  product, seen in bad light by someone slightly out of breath.
- **A single accent** for the primary action. Roadmap is terracotta/gold, journal is one warm gold in
  five steps. Gym needs its own and it should not be a third gold.
- **A "done" state** for a set already logged — quiet, settled, not celebratory.
- **A "target" state** for what the plan says versus what happened. Two weights on one line.
- **Exactly one loud state**, reserved for a genuine PR. One line, not confetti.
- **No red for ordinary things.** A missed rep is not an error. Reserve any alarm colour for actual
  failure states (a write that could not save).

Journal's rule is worth stealing verbatim: *nothing here uses brick/red — a day is never an error.*
Gym's version: a bad session is not an error either.

## The relationship to the other two products

Three products in one superapp, one switcher, one account. A user moving from roadmap to gym must
feel the same brand and a different room. Roadmap is ceremony; journal is quiet and warm; **gym is
matter-of-fact** — a tool, not a companion. Show the three side by side and prove they are siblings.

## Type and density

The design system's type scale is in `../tokens/typography.css`. Gym needs one very large numeral
treatment (the weight) that the scale probably does not have yet — propose it. Numerals should be
tabular wherever they sit in a column, so a log of sets doesn't shimmer.

Density: dense but not cramped. A session detail is a list of numbers a person scans, not reads.

## What to deliver

- The scoped palette as tokens, in journal's shape: one block per skin, every colour named for what
  it *is* in the product (`--set-done`, `--target-ink`) rather than for its hue.
- The numeral treatment and the type ramp gym actually uses.
- A one-screen proof: the `G1` logging surface rendered in the palette, in both skins if you choose
  two.
- The three-product family shot.

---

## Resolved — steel is retired; gym is lit by iris (2026-08-07)

**Raised 2026-07-30, closed 2026-08-07 by the owner.** The problem, for the record: the v2 palette
named its own move honestly ("Steel is the palette's Tuscan-sky, promoted from info to brand"), but
promoting a hue does not vacate its old seat. `--color-info` still pointed at the same ramp, so
inside `.gym-root` a primary button and an informational state resolved to *the identical value* in
the dark skin, and `--target-ink` was that colour too.

Three exits were on the table — author a steel ramp, re-point `--color-info` inside the room, or
accept and document the collision. **A fourth was taken:** gym's brand hue changed.

**Gym is lit by IRIS** — the giaggiolo, Florence's own flower, already authored to
`guidelines/system-architecture.md` §4's recipe as the worked example of a new hue. It sits ~65°
from sky, so it can never be read as info; the semantics are untouched; no new ramp was needed.

It came with the answer to this brief's first question, which had never really been answered either
— *does gym read as a warm daylight tool, a dark instrument, or one surface with two skins?*

**One surface with two skins, and the surface is stone.** Gym's place is Tuscan pietra: warm pale
stone in the sun by day, volcanic **basalt** at night. That is what four failed grounds (warm soil,
steel-tinted soil, graphite, cement) were missing — they were hues, not places. The room is warm at
both hours and iris is the only cool thing in it, which is §4a's temperature rule: *a warm ground
carries a cool light.*

Both skins live in `themes/brands.css` under `[data-brand="gym"]`; `gym/gym-tokens.css` restates the
hue so a `.gym-root` works outside that scope and keeps the product names (`--set-done`,
`--target-ink`, `--weight-ink`) pointing at semantics. Everything this brief asks for below still
stands — only the hue and the ground are decided.

**One thing this did NOT settle:** a "sea" reading of basalt — coral, breeze, wave — was considered
and rejected on register rather than on colour. Gym is mass and effort; that palette is the
vocabulary of release. Recorded so it is not re-proposed as new.