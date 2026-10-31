# Accessibility pass: status lines are announced, targets are 48 dp, labels say each thing once

**Status:** ✅ Conformance (no visual change). Not started.

**Current implementation**
- **Status line not announced:** the room's status `note` line in `GymRoom.kt` (e.g. "Finish this session", "Your draft couldn't be saved") is plain `Text` with no `liveRegion`, so TalkBack does not announce it. It also runs as a second message channel beside the `SnackbarHost`, which does announce.
- **Small target:** "What Coach read" (`coach/CoachSources.kt`) is about 22 dp tall: 13 sp text with 4 dp top padding.
- **Semantics nits** (from the uiautomator review):
  - "Sets, sets" and "Reps, reps": each label equals its unit.
  - New routine's back reads "Back to the routine you were on" when it was opened from the list.
- **Not yet verified:** spoken TalkBack acceptance has never been run. `apps/android/README.md` says so.

**Change**
- Give the `note` line `liveRegion = LiveRegionMode.Polite`, or move its messages into the snackbar host. Pick the one that leaves a single message channel.
- "What Coach read" reaches a 48 dp touch target, through `minimumInteractiveComponentSize` or padding, without changing its drawn size.
- Steppers announce "Sets, 3" and "Reps, 8". Back's description names the actual destination ("Back to Routines" when opened from the list).
- Run a spoken TalkBack pass on the emulator over Routines, the editor, the rack, Finish and Coach, and record the result in the README in place of the "unverified" line.

**Done when**
- Semantics tests cover the live region, the 48 dp target, the stepper labels and the back description.
- The README records the TalkBack pass.

**Depends on:** 03, 07.
