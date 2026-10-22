# Fix set on steppers, Delete set in red

**Figma:**
- 03.3 Fix set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29581) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34337)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514` (load numeral at 56, and reps)
  - `Android / Equipment icon` `337:2025`
  - `Android / Button` `210:181`: Filled (Save fix), Text · Tone=Error (Delete set)
  - `Android / Menu` `342:2725` (the Effort dropdown)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `FixSheet` (`ui/FixSheet.kt:69`) opens from a landed ledger row (`ui/LoggerScreen.kt`) or a set on workout detail (`ui/SessionScreen.kt`).
  - *Fix set* (:123) and *{movement} · Set {n}* (:125).
  - Load and reps open the keypad sheet (:104), with `LadderRow` and 56 dp ± keys.
  - *Effort* (:189), a `DropdownMenu` (:201): *Not rated*, *RPE 6* … *RPE 10* in half steps.
  - The note field is a `BasicTextField` (:218) with *Add a note* (:232); its spoken state is *A record for you — not an instruction to Coach.* (`domain/Training.kt:555`, used at `ui/FixSheet.kt:225`).
  - **Save fix** / *Saving…* (:276). Refusal *The log didn’t answer — that set wasn’t changed.* (:259) in `alarmInk` (:215).
  - **Delete set** is a `TextButton` in **ink** (:277-281).
  - Footer *{routine} keeps its planned targets.* (:283).
- The kind is passed through unchanged (`kind = set.kind`, :249).
- Fixing a set emits no event.

**Change**
- Subtitle row: the equipment icon (08), then *{movement} · Set {n}*.
- Load: the same `NumberStepper` as the rack (07, 09), with the numeral at 56 and the unit by equipment, then the ladder.
- Reps: the reps stepper.
- *Effort*: a filled `ExposedDropdownMenuBox` with the same options (*Not rated*, *RPE 6* … *RPE 10*).
- Note: a filled `TextField`, label *Set note*, placeholder *Add a note*. The board draws no caption under it; keep the spoken state until 9n is ruled.
- **Save fix** stays the 64 dp primary.
- **Delete set**: Text · Tone=Error (`TextButton` in `colorScheme.error`, 02/04). It deletes at once (05).
- Footer *{routine} keeps its planned targets.* stays.
- No kind control; `SetFix` has no kind (06).

**Out of scope:** the stepper and keyboard (07); immediate delete (05); This workout (11).

**Done when**
- Screenshots of 03.3 match in Dark and Daylight; the rig (01) adds `03.3-fix-set-dark/light`.
- New `gym_action` with `screen` `workout` or `session`, `action` `fix`, `outcome` `ok` / `refused` / `failed`, content-free. Delete set keeps the 05 event (`action` `delete`).
- Unexpected failures still report under `gym.fixSet` and `gym.deleteSet`.
- `ui/FixSheetLayoutTests.kt`, `ui/FixSheetStateTests.kt`, `ui/FixSheetEffortTests.kt` and `ui/FixSheetKeypadTests.kt` pass with the steppers; a test asserts Delete set is painted `colorScheme.error`.

**Depends on:** 05, 06, 07, 08.

**Ledger:** 11d, 9c, 9n; dogfood `android-gym-target-page`.
