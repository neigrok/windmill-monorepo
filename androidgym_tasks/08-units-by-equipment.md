# Loads read kg each / kg total / kg added, with the equipment icon

**Figma:**
- 02.2 Routine summary: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28969) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44488)
- 02.5 Routine editor, always sortable: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30313) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44882)
- Components (Design System library, Android page): `Android / Equipment icon` `337:2025` (Barbell, Dumbbells, Bodyweight, Machine; Machine is `343:2377`, the Material Symbol `table_rows`).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The model is on main: `Exercise.equipment` is `"barbell" | "dumbbell" | "machine" | "bodyweight"` and `loadCount` is 1 or 2 (`domain/Training.kt:38-45`). Volume already multiplies by `loadCount`.
- Every screen outside Coach prints plain *kg*:
  - `Readout.targetWithUnit` appends *kg* with no space: *3 × 5 · 80kg* (`domain/Readout.kt:51-52`). Used by the editor (`ui/RoutineBuilder.kt:431`), workout detail (`ui/SessionScreen.kt:167`), the finish receipt (`ui/FinishScreen.kt:287`, :385) and the review sheet.
  - The routine summary appends *" kg"* itself (`ui/RoutinesScreen.kt:329`), e.g. *3 × 8 · 75 kg*.
- Only Coach's draft card knows the basis, with its own rule: *" each"* for two dumbbells, *" total"* for barbell, *" added"* / *" assisted"* for bodyweight, nothing for machine (`coach/CoachAnswer.kt:94-108`).
- No equipment icon is drawn anywhere.
- The editor's dragged row is painted `raised`, with no shadow (`ui/RoutineBuilder.kt:400`).

**Change**
- One load rule in the domain, next to `Readout` (with tests and shared vectors):
  - Dumbbells, two: *kg each*. Dumbbells, one: *kg*.
  - Barbell and Machine: *kg total*.
  - Bodyweight: *kg added*. A negative number is band help and still reads *kg added* (e.g. *−10 kg added*).
  - Always a space before the unit.
- Use it everywhere a load is printed: `targetWithUnit` takes the exercise, the routine summary drops its own *" kg"*, and Coach's draft card drops its private rule.
  - 02.2: *3 × 8 · 75 kg total* (barbell, machine), *3 × 10 · 24 kg each* (dumbbells).
  - 02.5: the same strings under each movement in the editor.
- One equipment word list: *Barbell*, *Dumbbells*, *Bodyweight*, *Machine*.
- Build `ui/EquipmentIcon.kt` from `Android / Equipment icon`. Machine draws `table_rows` (a weight stack). Later tasks place it (09, 10, 19, 20, 21, 23).
- 02.5: the lifted row is raised with a shadow (`Modifier.shadow`, M3 level 3); handles stay always shown.

**Out of scope:** the rack (09); Create movement (19); Edit movement (20); the picker rows (02.4 matches today); *· yours* on the summary's rows (50).

**Done when**
- Screenshots of 02.2 and 02.5 match in Dark and Daylight; the rig (01) adds `02.2-routine-summary-dark/light`, `02.5-editor-sortable-dark/light`.
- No new events: copy only. `gym_screen_viewed` `routine` and `routine_editor` still fire.
- `domain/ReadoutTests.kt` covers each basis, and `ui/RoutineSheetTests.kt`, `ui/RoutineEditorTests.kt` and `coach/CoachAnswerTests.kt` assert the new strings in full.

**Depends on:** 02.

**Ledger:** 11e; dogfood `android-gym-target-page`.
