# Accessibility pass: status lines are announced, targets are 48 dp, labels say each thing once

**Status:** 🚀 On main (`ef0f05fb`), in Android 0.14.0. Conformance; the one drawn change is the taller "What Coach read" row.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- **Status lines:** the room's `note` line (`GymRoom.kt`) and the routine sheet's failure line (`ui/RoutinesScreen.kt`) are polite live regions, so TalkBack says what the eye reads as it changes. The snackbar host keeps the transient with its window; `note` stays the line about the screen you are on, so the two are not merged.
- **Target:** "What Coach read" (`coach/CoachSources.kt`) is a 48 dp clickable row; its 13 sp line and 18 dp chevron are drawn as before, centred in the row, so the answer below it sits lower.
- **Each thing once:**
  - A `NumberStepper` describes itself by its label, with the unit only when it adds to the label ("Sets", "Reps", "Load, kg total"); the drawn label and unit are silent, and TalkBack reads the typed value from the field: "3, Edit box, Sets".
  - The outlined Name and Equipment fields keep their description ("Routine name", "Movement name", "Equipment"); their drawn floating labels are silent.
  - The account seat says "Your account" without its initial or dot.
  - The routine editor's back names where it goes: "Back to Routines" from the list, "Back to Push A" from a routine's sheet, else the screen or tab beneath. `GymRoom.wayBackTo` names a pushed screen's way back the same way.
- **Spoken pass:** recorded in `apps/android/README.md`, with what is still said twice.
- Tests: `ui/RoutineSaveTests` (the room's line is a polite live region), `coach/CoachAnswerTests` (the 48 dp target), `ui/NumberStepperTests` (label, value and unit each once), `ui/RoutineEditorTests` (the back description from the list and from a routine).

**Change**
- Give the `note` line `liveRegion = LiveRegionMode.Polite`, or move its messages into the snackbar host. Pick the one that leaves a single message channel.
- "What Coach read" reaches a 48 dp touch target, through `minimumInteractiveComponentSize` or padding, without changing its drawn size.
- Steppers announce "Sets, 3" and "Reps, 8". Back's description names the actual destination ("Back to Routines" when opened from the list).
- Run a spoken TalkBack pass on the emulator over Routines, the editor, the rack, Finish and Coach, and record the result in the README in place of the "unverified" line.

**Done when**
- Semantics tests cover the live region, the 48 dp target, the stepper labels and the back description.
- The README records the TalkBack pass.

**Depends on:** 03, 07.
