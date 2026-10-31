# The rack fits its number, scrolls as one at large text, and keeps a typed value when focus moves

**Status:** ✅ Ready for dev. The owner approved 03.34 and 03.35 on 2026-10-31; 03.2 is approved already. Not started.

**Figma:**
- 03.34 Rack, the numeral fits first: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-40960) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41112)
- 03.35 Rack at 320 dp / 200 %: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41245) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1742-41402)
- 03.2 Rack with the keyboard: [board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28178)

**Current implementation**
- **Unit wraps:** a real 22.5 kg total wraps "kg total" onto its own line, so the rack panel grows about 80 px and the layout jumps while stepping (step a barbell load from 20 to 22.5 kg in a live workout).
- **Keyboard up:** the set list collapses to a clipped sliver, and the current row is cut mid-glyph (the rig's `03.12` rack-keyboard capture).
- **Large text:** at 320 dp / 200 % the list is clipped the same way (`adb shell wm size 840x1866` plus `settings put system font_scale 2.0` gives 320 dp / 200 % on a Pixel 8 profile).
- **Typed value lost:**
  - `ui/NumberDraft.kt` `focus(active)` calls `cancel()` when focus leaves.
  - A typed load is therefore thrown away when the lifter taps Reps instead of the keyboard's Done; it reproduces every time.
  - iOS commits a typed value on focus loss (iOS task 61's fix).

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
