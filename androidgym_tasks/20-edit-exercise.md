# Edit movement replaces Rename movement

**Approved flow:** [Routine editor metadata contract](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25. This task’s standalone Record editor is distinct from routine staging. Its existing drawings below cover four equipment examples; new Cable/Kettlebell visuals still need designer approval (08).

**Figma:**
- 05.9 Edit movement, name and Dumbbells: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-6349) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31338)
- 05.10 Edit movement, the Equipment menu: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-6469) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31377)
- Components (Design System library, Android page):
  - `Android / Equipment icon` `337:2025` (Kind=Machine `343:2377`, Material Symbol `table_rows`)
  - `Android / Menu` `342:2725`
  - `Android / Button` `210:181`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The Record's *Rename* opens `RenameSheet` (`ui/RenameSheet.kt:20-63`) titled *Rename movement* (`ui/RecordScreen.kt:94`):
  - *Name*, one field.
  - *Renames this movement everywhere.* / *Your logged sets and records keep the same movement.* (`ui/RenameSheet.kt:51-52`)
  - Signed in: *Old name: {from}\nSearchable as an alias.* (`ui/RenameSheet.kt:53`)
  - *Rename* / *Renaming…* (`ui/RenameSheet.kt:59`); a refusal reads *That movement kept its name.* (`ui/RecordScreen.kt:103`).
- Name only. `TrainingStore.rename` (`store/TrainingStore.kt:1534-1550`) calls `EngineTraining.renameExercise` (`store/EngineTraining.kt:129`), which runs the domain's `RenameExercise` (`apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/Catalogue.kt:103-120`).
- The model already holds equipment and the dumbbell count: `ExerciseName` carries `equipment` and `loadCount` overrides (`…/domain/sync/Catalogue.kt:31-47`), `Exercise.loadCount` (`domain/Training.kt:42`).

**Change**
- Rename `RenameSheet` to an Edit movement sheet (one file, `ui/EditMovementSheet.kt`), opened from the Record's ⋮ (21).
- 05.9:
  - Title *Edit movement*.
  - `OutlinedTextField` *Name*, with the note *The new name shows in your routines and history. Search still finds the old name.*
  - Exposed dropdown *Equipment* with the leading equipment icon (08).
  - For Dumbbells: *Dumbbells lifted*, M3 segmented button *One* / *Two*.
  - Help for Dumbbells: *Enter the weight of one dumbbell. Volume counts both. Changing equipment updates past volume. Your logged weights do not change.*
  - Filled **Save** (56 dp); *Saving…* while busy. Enabled only when something changed.
- 05.10 draws four menu examples: *Barbell*, *Dumbbells*, *Bodyweight*, *Machine*, each with its approved icon and a check on the chosen one. They do not exhaust supported stored records. A Cable/Kettlebell record must retain its actual selected value and name-only editing must preserve equipment/load count; never default or coerce it. Preserve its existing presentation pending 08’s explicit designer follow-up for new icons/options/load-basis wording.
  - Help for Bodyweight: *Enter the added weight, or a negative number for help from a band. 0 means bodyweight only. Volume counts only the added weight. Changing equipment updates past volume. Your logged weights do not change.*
- Delete *Renames this movement everywhere.*, *Your logged sets and records keep the same movement.* and the *Old name … Searchable as an alias.* line.
- Domain (use the `domain-feature` skill): the standalone `EditExercise` action is still missing; `SaveRoutinePlan` already exists only for the routine’s atomic save. Implement one `EditExercise(id, name, equipment, loadCount)` action that writes only changed fields, retains the alias/stale guards, supports all six stored equipment values and permits a count override only for dumbbells. Add shared vectors before wiring this standalone Save; do not replace the routine’s SaveRoutinePlan or use this action during routine staging.
- Store: `TrainingStore.edit(exerciseId, name, equipment, loadCount)` replaces `rename`; invalidate progress and volume reads, as `rename` does today.
- A refusal shows under the fields in the error role (02), keeping the server's sentence.

**Out of scope:**
- The Record's ⋮ menu and subhead (21).
- Coach changing a movement (35).

**Done when**
- Screenshots of 05.9 and 05.10 match in Dark and Daylight; the rig (01) adds `05.9-edit-movement-dark/light` and `05.10-edit-movement-equipment-menu-dark/light`.
- Rename emits no event today. Add `gym_action` with `screen=record`, `action=edit`, `outcome=ok` / `refused` / `failed`; no name or equipment in properties. List it in `docs/ANDROID_OBSERVABILITY.md`.
- The failure operation `gym.rename` becomes `gym.editExercise`. Name-only saves on seeded Cable and Kettlebell keep equipment, load basis, raw set values and volume unchanged; cancelling writes nothing. Equipment changes preserve logged weights and apply the existing domain volume rule only after Save. New visual options remain blocked on 08’s designer follow-up.
- Tests: `store/EngineTrainingTests.kt`, `store/TrainingStoreTests.kt`, `ui/SheetDismissTests.kt` (rename cases become edit cases), and the domain tests next to `CataloguePreferencesTests.kt` in `apps/android/gym/domain/src/test/`.

**Depends on:** 08.

**Ledger:** 11e, 9z; dogfood `android-gym-target-page`.
