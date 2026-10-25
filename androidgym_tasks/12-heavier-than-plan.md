# Remove the Heavier than the plan sheet

**Figma:** none. Board 03.6 is deleted on both phones: lifting more than the plan never offers to change the routine. The workout logs what was lifted; routine targets change through explicit routine-editor Save (18) or accepted Coach proposals (08.21, task 33).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `DeviationOffer.leaving` (`domain/Deviation.kt:32-53`) raises an offer when the lifter walks off a movement lifted heavier than planned.
- The logger holds it: `LoggerSheet.Deviation` (`ui/LoggerScreen.kt:133`), `pendingDeviation` and `asked` (:177-178), the offer raised in `move` (:221-225) and presented once the old sheet is down (:240-242).
  - While an offer is pending, a second walk is refused with *{movement} first — that question is still open.* (`LiveLines.oneAtATime`, `domain/LiveSession.kt:62`; said at `ui/LoggerScreen.kt:211-217`).
- `DeviationSheet` (`ui/DeviationSheet.kt`): *Heavier than the plan*, *Today’s {movement} ran at {w} against a planned {p}. Today’s session already has it. {routine} does not.*, **Save {w} to {routine}** or **Save today’s sets** (`domain/Program.kt:103`), and *Today only*.
- **Save** writes the routine through `TrainingStore.save` (`store/TrainingStore.kt:872-889`, `Routine.retargeting` at `domain/Training.kt:319`), reporting `gym.save`; the logger calls it from the sheet branch at `ui/LoggerScreen.kt:500-514`.
- Tests: `ui/DeviationSheetTests.kt`, `domain/DeviationSheetTests.kt` (class `DeviationTests`), and `ui/LoggerWalkRefusalTests.kt`, which pins the refused second walk.

**Change**
- Lifting above the plan just logs. Nothing asks, nothing writes to the routine, no alert and no sheet.
- Delete `ui/DeviationSheet.kt` and `domain/Deviation.kt`.
- In the logger, delete `LoggerSheet.Deviation`, `pendingDeviation`, `asked`, the offer in `move`, its presentation, the sheet branch and the refused second walk. `move` keeps only the `goingTo` guard.
- Delete `LiveLines.oneAtATime`, `TargetEntry.saveTodaysSets`, and `TrainingStore.save` with `Routine.retargeting` once nothing else calls them (today nothing does). `TrainingStore.saveRoutine` and the editor stay.
- Delete the three test files above; keep any walk test that does not depend on an offer, moved into `ui/LoggerScreenTests.kt`.

**Out of scope:** Coach proposing a heavier load (33); the receipt (14).

**Done when**
- A workout where every set beats the plan walks movement to movement and finishes with no sheet, no alert and no write to the routine (a logger test asserts the routine's revision is unchanged).
- `gym_set_logged` still fires once per set; the Sentry operation `gym.save` goes with `TrainingStore.save`.
- `./gradlew :gym:testDebugUnitTest` passes with the deleted tests gone.

**Depends on:** none.

**Ledger:** 12a; dogfood `android-gym-target-page`.
