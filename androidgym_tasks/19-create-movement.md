# Create movement: name, equipment, dumbbells lifted

**Figma:**
- 02.9 Create movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29027) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45281)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Equipment icon` `1247:2247` (Machine is Kind=Machine `1263:34603`)
  - `Android / Menu` `1260:2608` (the Equipment options)
  - `Android / Number stepper` `1247:2736`
  - `Android / Keyboard` `1247:2625`
  - `Android / Button` `656:6699`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `CreateMovementSheet` (`ui/MovementPicker.kt:379-449`), in a `ModalBottomSheet` (:336-347):
  - *Create movement* with *Cancel*; a name field, `PlanningNameField`, described to TalkBack as *Movement name* (:408).
  - *Equipment* as a 2×2 radio grid, *Barbell*, *Dumbbell*, *Machine*, *Bodyweight* (:410-432), from `Exercise.loadings` (`domain/Training.kt:45`), capitalised from the wire word.
  - In the editor, `TargetBlock` with the old 56 dp ± keys; *Choose at least one set.* in alarm ink (:433-437).
  - Button *Add to routine* / *Create and add* / *Creating…* (:441-447).
- No dumbbell count. `TrainingStore.create` (`store/TrainingStore.kt:1154-1177`) passes none, and `EngineTraining.createExercise` (`store/EngineTraining.kt:122-128`) builds the record without `loadCount`, so a new dumbbell movement gets the default.
  - The domain already takes it: `CreateExercise` writes a `loadCount` override (`apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/Catalogue.kt:90-98`).
- Defect: after a Dark/Daylight switch recreates the activity, the sheet sits under the status bar with its drag handle over the clock.

**Change**
- Name: an M3 `OutlinedTextField` *Name* (for example *Dumbbell Shrug*), focused with the keyboard up as today.
- Equipment: an M3 exposed dropdown (`ExposedDropdownMenuBox`) *Equipment*, with the equipment icon (08) leading the field and each option.
  - Options: *Barbell*, *Dumbbells*, *Bodyweight*, *Machine*. Use these display words everywhere, the picker rows included; the wire stays `dumbbell`.
- For Dumbbells only: *Dumbbells lifted* as an M3 `SingleChoiceSegmentedButtonRow`, *One* / *Two*, with the hint *Enter the weight of one dumbbell. Volume counts both.*
  - Default to the domain's default count; pass the choice through `create` → `ExerciseWrite` → `CreateExercise`.
- Targets use the shared steppers (18), with the suffix of the chosen basis: 02.9 reads *Sets* 3 *sets* · *Reps* 10 *reps* · *Load* — *kg each*.
- Button *Add to routine* (Primary, 56 dp); *Create and add* from the logger; *Creating…* while busy.
- *Choose at least one set.* uses the error role (02).
- Fix the recreation defect: the sheet must respect the status-bar inset after the activity is recreated (check `WindmillSheetWindow()` and the sheet's `contentWindowInsets`). The same defect in other sheets is 25's.

**Out of scope:**
- The Targets block (18), the picker list (02.4 matches today, apart from the *Dumbbells* word).
- Edit exercise on an existing movement (20).

**Done when**
- Screenshots of 02.9 match in Dark and Daylight; the rig (01) adds `02.9-create-movement-dark/light`, and one capture taken after a mode switch with the sheet open.
- A created dumbbell movement with *One* stores `loadCount` 1, and volume counts one dumbbell (`domain/Training.kt:197`).
- Create movement emits no event today. Add `gym_action` with `screen=routine_editor` (or `workout` from the logger), `action=create`, `outcome=ok` / `refused` / `failed`. List the new action in `docs/ANDROID_OBSERVABILITY.md`.
- Failures still report as `gym.create`.
- Tests: `ui/CreateMovementTargetTests.kt`, `ui/PickerOptionsTests.kt`, `store/PlanningWritesTests.kt` (the count reaches the replica), and a domain vector for `CreateExercise` with `loadCount`.

**Depends on:** 04, 08, 18.

**Ledger:** 11e; dogfood `android-gym-target-page`, `android-sheets-after-recreation`.
