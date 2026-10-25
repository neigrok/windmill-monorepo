# Create movement in a routine draft or an active workout

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25. The live-workout picker/custom-create return is covered by the approved [Workout flow](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036).

**Figma:**
- 02.9 Create movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29027) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45281)
- Components (Design System library, Android page):
  - `Android / Equipment icon` `337:2025` (Machine is Kind=Machine `343:2377`)
  - `Android / Menu` `342:2725` (the Equipment options)
  - `Android / Number stepper` `337:2514`
  - `Android / Keyboard` `337:2403`
  - `Android / Button` `210:181`

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
- Reuse the combined Name/Equipment/Targets form from 18 for routine creation. Name is an M3 `OutlinedTextField`; Equipment is an exposed dropdown with the existing approved icons. The four drawn new-movement choices are *Barbell*, *Dumbbells*, *Bodyweight* and *Machine* (`dumbbell` remains the wire value). This creation menu is not an exhaustive stored-equipment domain; existing cable/kettlebell records must remain selectable from the catalogue and keep their metadata (08).
- For Dumbbells, use the approved **One**/**Two** segmented count and its helper text. Initialize from the domain default, retaining an explicit choice in the draft; the correct load basis follows 08. Number/Decimal input and assisted negative-entry behavior follow 07/18.
- Routine context: **Add** stages new identity, equipment, load count and targets in the outer routine draft. No `store.create` / `CreateExercise` call occurs here. Only outer **Save** invokes the existing `SaveRoutinePlan` (18). Cancelling custom creation returns to the picker; cancelling the outer routine leaves no created movement or metadata write.
- Live-workout context is separate: enter via movement name → **This workout** → **Add movement** (11). This context has no outer routine Save. **Create and add** owns its existing create/append boundary, passes the chosen load count through the store/engine adapter into `CreateExercise`, then adds/selects the movement in the current workout and returns to the preserved rack. Do not stage this work in an unrelated routine draft or modify the source routine’s targets.
- Persist the creation identity and known result across recreation/retry, and distinguish catalogue creation from workout insertion. An uncertain receipt is not a known success or a safe fresh create: reconcile the same identity/result before retrying or reporting an outcome. If creation succeeds but insertion refuses, retain that known result and retry only the remaining insertion; never claim nothing was created or create a duplicate on retry. Before a successful create, Cancel writes nothing. Custom-create Cancel returns to the picker; picker Cancel returns to This workout. Existing workout ID, sets and rack drafts survive every return path.
- Use the error role for validation and retain typed values after refusal. Fix sheet presentation and navigation so selection/creation never leads to a grey screen. Respect status/navigation insets after mode switch or activity recreation (`WindmillSheetWindow`/`contentWindowInsets`), and keep the focused field, error and primary action reachable above the IME.
- New Cable/Kettlebell chooser/icon/load-basis drawings are a designer follow-up (08), not an invitation to coerce their stored values or invent approved visuals.

**Out of scope:** the outer routine write implementation (18); standalone Record editing (20); the This workout management sheet (11).

**Done when**
- Capture the approved routine form and live custom-create/return states in Dark and Daylight, including keyboard, validation and recreation. Existing catalogue selection, custom Cancel and picker Cancel all return to their stated parent without a blank surface.
- Routine Add → outer Cancel yields no new catalogue/alias/routine writes. Outer Save persists the chosen count and targets atomically through 18. Test One/Two with correct volume and preserve existing cable/kettlebell records on selection/name-only edits.
- Live creation → insertion succeeds once and preserves the rack. Verify refusal before creation, creation succeeded/insertion refused, retry, recreation and cancellation; the routine remains unchanged. Reuse existing domain creation/load-count vectors rather than duplicating the action.
- Track content-free `gym_action` steps separately: routine staging is `stage`, live creation/add has actual `ok|refused|failed` outcomes. No create-success event on routine Add. Document bounded labels in `docs/ANDROID_OBSERVABILITY.md`; no names, search text, equipment, targets or IDs. Unexpected creation failures retain `gym.create`; insertion failures use their static store boundary operation.
- Update `CreateMovementTargetTests`, picker navigation, planning-write and engine-adapter tests for context-specific write ownership and loadCount propagation.

**Depends on:** 04, 08, 11, 18.

**Ledger:** 11e; dogfood `android-gym-target-page`, `android-sheets-after-recreation`.
