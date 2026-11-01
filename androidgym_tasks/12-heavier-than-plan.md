# Remove the Heavier than the plan sheet

**Figma:** none. Board 03.6 is deleted on both phones: lifting more than the plan never offers to change the routine. The workout logs what was lifted; routine targets change through explicit routine-editor Save (18) or accepted Coach proposals (08.21, task 33).

**Implementation status**
- The logger has no heavier-than-plan offer, pending question or implicit routine-save path. Movement changes wait only for the active sheet to close and an in-flight move to settle.
- Routine edits use `RoutinesStore.saveRoutine` or accepted Coach proposals. The logger cannot retarget a routine.
- `LoggerScreenTests` covers an over-plan workout through each movement and Finish, unchanged routine content and revision, no dialog or message, and one content-free `gym_set_logged` per set. Pager tests retain drag, reversal and cancellation coverage; explicit routine saves retain proposal-supersession coverage.
- All 156 targeted tests pass with zero skips. The integrated gym Debug suite passes 1,167 tests with 17 opt-in live-wire cases skipped. Native acceptance logs eight above-plan sets through both movements and Finish, keeps the entire routine readback unchanged, and delivers one first-party set event per set. See [implementation status](../docs/engineering/android-implementation.md).

**Contract**
- Lifting above the plan just logs. Nothing asks, nothing writes to the routine, no alert and no sheet.
- Ordinary movement navigation remains available; it clears any previous transient message.
- Explicit routine-editor Save and accepted Coach proposals remain the routine-edit paths.
- Every logged set emits `gym_set_logged` once, without workout values.

**Out of scope:** Coach proposing a heavier load (33); the receipt (14).

**Done when**
- A workout where every set beats the plan walks movement to movement and finishes with no sheet, no alert and no write to the routine.
- `./gradlew :gym:testDebugUnitTest` passes, including the routine-content/revision and event assertions.

**Depends on:** none.

**Ledger:** 12a; dogfood `android-gym-target-page`.
