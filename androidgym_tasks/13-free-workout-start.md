# Remove the free workout

**Figma:** none. Board 03.9 is deleted: every workout starts from a routine (02.2's **Start workout**). Routines (02.1, 02.7) draw no *Start logging*, the receipt has no *Save a routine* (03.7, 03.8), and the Quick Settings tile with no workout open opens Routines (16).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- *Start logging*, a pinned accent box on Routines (`ui/RoutinesScreen.kt:162-177`, `onJustStart` at :74, the comment at :66), opens the logger with no routine: `onJustStart = { open(null) }` (`GymRoom.kt:1188`) into `TrainingStore.start(routineId: String? = null)` (`store/TrainingStore.kt:660`).
- The logger then opens on the movement picker (`pickerUp`, `ui/LoggerScreen.kt:245`), titled *What are you starting with?* on the first workout, otherwise *What are you lifting?* (:364). Signed out on the first workout the picker adds the dashed card *Have a written program? An agent can build it — sign in first.* / *Build my routine →* (`BuildMyRoutine`, `ui/MovementPicker.kt:452-475`, shown at :319, wired to `onSignIn` at `ui/LoggerScreen.kt:371`).
- The receipt of a workout with no routine offers *Save a routine* (`FinishedSession.offersRoutine`, `ui/FinishScreen.kt:166-168`; `KeepAsRoutine`, :364-411, with *Routine name*, *Today’s weights become next week’s targets.* and *Save routine*), then *Kept as {name}.* (`Finish.keptAs`, :68). The room keeps the write in `keep` (`GymRoom.kt:780-799`, state at :280-287) over `TrainingStore.keep` (`store/TrainingStore.kt:862-869`).
- A workout with no routine is titled *Free session*: `Readout.noRoutine` (`domain/Readout.kt:90`) and its own literals in `ui/LoggerScreen.kt:320`, `ui/AssemblySheet.kt:119`, `ui/FinishScreen.kt:261`, `coach/CoachAnswer.kt:151,188` and `domain/WorkoutNotification.kt:54`.

**Change**
- Delete *Start logging*, `onJustStart`, and the `open(null)` path. `TrainingStore.start` takes a routine id, not an optional one.
- Delete *Save a routine*: `offersRoutine`, `KeepAsRoutine`, `Finish.keptAs`, `FinishScreen`'s `keptName` / `onKeepRoutine`, the room's `keep` with `keepingRoutine` / `keptRoutine`, and `TrainingStore.keep` with its failure line *the routine wasn’t kept*.
- Delete the *What are you starting with?* title and the `BuildMyRoutine` card (`firstSession` and `signedIn` leave the picker if nothing else reads them). The picker stays for **Add movement** in the editor (02.4) and in This workout.
- A workout with no routine can still reach this phone: a connected agent's `start_session` takes an optional `routineId` (`backend/products/gym/adapters/mcp/GymToolCatalog.cpp:318-327`), and the log holds earlier ones. Title it `Readout.noRoutine`, which reads *Free workout*, the word iOS's shared readout uses (`apps/ios/Domain/Sources/GymDomain/TrainingReads.swift:334`). Every literal above reads `Readout.noRoutine` instead of its own *Free session*. Such an open workout still opens on the picker titled *What are you lifting?*; no board draws it, so ask the designer before changing it.

**Out of scope:** the rest of Routines (17); the rest of the receipt (14); the tile (16); the picker's rows (02.4 matches today).

**Done when**
- No screen starts a workout without a routine: a Routines test finds no *Start logging*, and a store test shows `start` needs a routine id.
- No receipt offers *Save a routine*, a workout with no routine included (`FinishSheetTests.kt`, `ui/FinishScreenTests.kt`).
- `gym_session_started` still fires once per start, from **Start workout**; `gym_screen_viewed` `workout` is unchanged.
- `ui/PickerOptionsTests.kt`, `ui/LoggerScreenTests.kt` and `domain/ReadoutTests.kt` (*Free workout*) pass.

**Depends on:** none.

**Ledger:** 12b, 9z; dogfood `android-gym-target-page`.
