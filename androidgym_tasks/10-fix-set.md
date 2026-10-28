# Fix set on steppers, Delete set in red

**Approved flow:** [Workout / Fix set](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.3 Fix set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29581) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34337)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514` (Display load numeral at 88 sp, and regular reps), as drawn in [approved 03.3](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29581)
  - `Android / Equipment icon` `337:2025`
  - `Android / Button` `210:181`: Filled (Save fix), Text · Tone=Error (Delete set)
  - `Android / Menu` `342:2725` (the Effort dropdown)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `FixSheet` opens from a landed rack row or workout detail. Its equipment subtitle and load unit use the same catalogue reading as the rack.
- Load uses the 88 sp Display `NumberStepper`, the established ladder bands and native signed input; reps use the regular stepper. Raw buffers, caret, refusal and cancellation follow 07.
- Effort is a filled exposed menu with *Not rated* and *RPE 6* … *RPE 10* in half steps.
- Set note uses the native text editor with the M3 filled container, a fixed small label and *Add a note* placeholder. It preserves raw bytes and the spoken state *A record for you — not an instruction to Coach.*
- Save fix is at least 64 dp; Delete set uses the M3 error role with a 48 dp minimum target and the immediate-delete path from 05. The routine footer remains.
- A store-owned settled job reports one `gym_action` result for a live or historical fix. Expected refusals emit no Issue. Unexpected fix/import failures report under `gym.fixSet`.
- Once the correction is persisted, a failed presentation refresh cannot change its result to failed. A controls-file failure retains the recovery sentence; account/workout guards prevent late publication into a different rack.
- Affected Debug and Release gates pass 101 cases each. The final adapter ownership/accepted-result pass has 36 focused cases in each variant. Six API 37 Dark/Daylight captures and an IME-open Save preserve the exact signed load, note and effort. The final controls-fault probe retains the accepted correction, one successful fix event and one `gym.fixSet` Issue; restart and a separate recovered edit succeed. The final fault/observer regression passes eight cases in each variant.

**Change**
- Subtitle row: the equipment icon (08), then *{movement} · Set {n}*.
- Load: the same `NumberStepper` as the rack (07, 09), with the approved Display numeral at 88 sp before system text scaling, the 04 overflow behavior, and the unit by equipment, then the ladder.
- Reps: the reps stepper. Assisted load entry uses the native keyboard’s minus key as specified in 07. Preserve the approved sizing and the last committed values when an edit is cancelled.
- The rack behind this sheet uses 09’s compact headerless ledger and visual position indicator; no main Add or paging arrows are reintroduced by the backdrop.
- *Effort*: a filled `ExposedDropdownMenuBox` with the same options (*Not rated*, *RPE 6* … *RPE 10*).
- Note: a native text editor in the M3 filled field container, label *Set note*, placeholder *Add a note*. The board draws no caption under it; keep the spoken state until 9n is ruled.
- **Save fix** stays the 64 dp primary.
- **Delete set**: Text · Tone=Error (`TextButton` in `colorScheme.error`, 02/04). It deletes at once (05).
- Footer *{routine} keeps its planned targets.* stays.
- No kind control; `SetFix` has no kind (06).

**Out of scope:** the stepper and keyboard (07); immediate delete (05); This workout (11).

**Done when**
- Screenshots of 03.3 match in Dark and Daylight; the rig (01) adds `03.3-fix-set-dark/light`. Include focused signed load, inline refusal and keyboard-open small-height checks; Save and the focused field remain reachable. Verify negative decimal entry and commit through the native keyboard on the target emulator.
- New `gym_action` with `screen` `workout` or `session`, `action` `fix`, `outcome` `ok` / `refused` / `failed`, content-free. Delete set keeps the 05 event (`action` `delete`).
- Unexpected failures still report under `gym.fixSet` and `gym.deleteSet`.
- `ui/FixSheetLayoutTests.kt`, `ui/FixSheetStateTests.kt`, `ui/FixSheetEffortTests.kt` and `ui/FixSheetNumberEntryTests.kt` pass with the steppers; a test asserts Delete set is painted `colorScheme.error`.

**Depends on:** 05, 06, 07, 08.

**Ledger:** 11d, 9c, 9n; dogfood `android-gym-target-page`.
