# The quiet set count: the owner's open questions

**Status:** Waits for the owner's rulings and their boards: design brief item QW4.

**Figma:** 05.3b *Quiet set count* ([Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1782-26943) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1782-27019), 🚀 In production). Any revision comes from QW4 ([design brief](design-brief-quality-wave.md)).

**Context:** the workout page's set rows lead with a faint 1..N count in logged order, by the owner's ruling of 2026-11-01 (ledger 11u, task 23). Four questions were left open:
- whether the live logger's rows keep *Set 1*;
- whether Android takes iOS's stronger marker colour;
- whether Daylight's tertiary text is strong enough for the count;
- what a two-digit count does at 200 % text, where it widens its 24 dp column and pushes that row's load inward.

**Current implementation**
- The workout page: `ui/SessionScreen.kt` (`Performed.Row.position`), passed to `ui/FixSheet.kt` for *Set N*.
- The live logger's ledger rows still read *Set 1*, *Set 2* (`ui/LoggerScreen.kt`).
- The count draws in `text/tertiary`, JetBrains Mono 12/16 on the boards, in a 24 dp column.

**Change**
- Build only what the owner rules and QW4 draws: the logger's row label, the marker colour, the Daylight tone, and the two-digit column at large text.
- Keep the counting rule (1..N per movement in logged order; rows renumber after a delete).

**Done when**
- Each ruled item matches its board in Dark and Daylight, at default and 200 % text.
- Tests cover a two-digit count at 2.0 font scale.

**Depends on:** 23, design brief QW4. Tree: `android-quiet-set-count-followups`.
