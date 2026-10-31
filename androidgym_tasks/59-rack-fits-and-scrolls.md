# The rack fits its number, scrolls as one at large text, and keeps a typed value when focus moves

**Status:** Implemented, awaiting merge. The boards flip to 🚀 after merge.

**Figma:**
- 03.34 Rack, the numeral fits first: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41112)
- 03.35 Rack at 320 dp / 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41245) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41402)
- 03.2 Rack with the keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178)

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/ui/`)
- **Numeral:** `NumberStepper.kt` fits the Display numeral beside its unit by measurement, from 88 sp down to 64 sp, and keeps the 88 sp line, so stepping between 20 and 22.5 kg keeps the rack panel's height. Only below 64 sp does the unit go under the number.
- **Large text and keyboard:** `LoggerScreen.kt` scrolls the movement head, the ledger and the rack as one page above the pinned Log set band; the ledger's window holds three whole rows. While a number is typed, the page scrolls so the whole rack stands on the band above the keyboard.
- **Focus:** leaving a `NumberDraft` field commits a valid typed value the way Done does; an invalid one keeps its refusal and the committed value (rack, Fix set, targets). The logger owns the rack's entry (`RackEntry`), so Hide, Finish, Back and a move to another movement commit a valid typed value first.
- Tests: `LoggerScreenTests` (panel height between 20 and 22.5 kg, the typed load kept on Reps, Hide, Finish and a move), `FixSheetNumberEntryTests`, `NumberStepperTests`. The rig's `compact-rack.json` captures 03.34 and 03.35.

**Change**
- **Numeral (03.34):** fit the load numeral inline first, from 88 sp down to a 64 sp floor. Only below 64 sp does the unit go under the number, so "22.5 kg total" no longer grows the panel.
- **Large text (03.35):** when the rack and the ledger don't fit, the page scrolls as one. Rows wrap and are never cut, and Log set stays pinned at the bottom.
- **Keyboard (03.2):** the set list never shrinks to a clipped sliver; it scrolls with the rack.
- **Focus loss:**
  - A valid typed value commits when focus leaves, the same as Done; an invalid one keeps today's inline refusal and the old value.
  - This applies to every `NumberDraft` (rack, Fix set, targets), not only the rack.

**Done when**
- 03.34 and 03.35 match in Dark and Daylight, and 03.2 matches with the keyboard up.
- Tests:
  - Stepping between 20 and 22.5 kg keeps the panel height constant.
  - At 200 % font every ledger row is fully visible by scrolling, and Log set stays visible.
  - Typing 82.5 then tapping Reps keeps 82.5.
  - Typing junk then tapping Reps keeps the old value and shows the refusal.
- Events are unchanged.

**Depends on:** 07, 09.
