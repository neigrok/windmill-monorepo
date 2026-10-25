# The routine editor's History, and *· yours* on a movement the lifter made

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 02.13 Routine editor, History: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39087) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39184)
- 02.2 Routine summary draws the *· yours* row: *Landmine Press · yours* / *3 × 10 · 20 kg total* (board linked from 08).
- iOS ships both and is the model: History in `apps/ios/App/Sources/Gym/Routines/RoutineBuilder.swift:173-180` over `routineHistory` (`RoutinesTab.swift:262-264`); *· yours* in `RoutinesTab.swift:128-129`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The editor (`RoutineBuilder`, `ui/RoutineBuilder.kt:144`) ends with **Add movement** (:441); it has no History.
- The routine sheet's rows print the movement name with no mark for a movement the lifter created (`RoutineSheet`, `ui/RoutinesScreen.kt:274`, rows at :326-330).
- The seed list exists in the domain module: `SeedExercises` (`apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/SeedExercises.kt:5`).

**Change**
- 02.13, History in the outer routine editor, under **Add movement**: a section *History* with the routine’s last 20 finished workouts, newest first. Combined movement Add/Done stages only; this read-only section must not trigger metadata writes or bypass 18’s atomic outer Save. It does not create a separate Targets route.
  - Each row: the day as its title (*Tue, Oct 20*) and its facts (*15 working sets · 5 movements*). This approved wording counts every set under 06, without kind filtering.
  - Shown only once the routine has a finished workout; rows are read-only. A new routine has none.
- 02.2, *· yours*: in the routine sheet, a movement whose id is not in `SeedExercises` reads *{name} · yours*. Apply the same rule wherever iOS does (the summary), nowhere else.

**Out of scope:** the editor's rows and units (08); the picker (02.4).

**Done when**
- Screenshots of 02.13 match in Dark and Daylight, and 02.2's *Landmine Press · yours* row matches; the rig (01) adds `02.13-editor-history-dark/light` and recaptures `02.2-routine-summary-dark/light` with a custom movement in Push A.
- No new events for the read-only section and label. Routine staging and Save events remain 18’s responsibility; History must not emit a save or discard the outer draft.
- Tests: `ui/RoutineEditorTests.kt` (History hidden for a new routine, 20 rows newest first, the facts line), `ui/RoutineSheetTests.kt` (*· yours* only on a non-seed movement).

**Depends on:** 06, 08, 18.

**Ledger:** 12i; dogfood `android-gym-target-page`.
