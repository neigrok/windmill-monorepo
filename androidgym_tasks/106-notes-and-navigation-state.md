# Notes and navigation state

**Status:** On main. Checked on the local stack (debug build, API 37 emulator): note A and then note B save as two separate notes and A keeps its words; a fast vertical swipe that starts on a note's drag handle scrolls the list without reordering or sending a move; a long press on the handle reorders, saved once with one `gym_note_moved`. Not driven on a device: a failed notebook read with Try again, because the debug build has no read-fault switch.

**Context:** pushed screens need a saved-state identity for each visit, note handles must arbitrate scrolling before claiming a drag, and notebook reads need a guarded failure boundary.

**Current implementation**
- `GymNavigator.kt` owns serializable visit entries, the owned-key computation and `rememberFrameStates`, shared by `GymRoom.kt` and the retirement regression. Its composition effect retires pushed and closed-draft state while retaining root tabs and session-keyed workout state. A seat change gets a new holder. Restored entries keep their identities; legacy route arrays receive fresh identities silently.
- `ui/NotesScreen.kt` arbitrates handle gestures on the Main pass: vertical slop releases to scrolling, sideways slop guards against deletion, and a long-press timeout starts reorder ownership.
- `store/NotesStore.kt` reads notes, readiness and refusals through one guarded snapshot and publishes only successful reads. List failures return the existing retry outcome and report `gym.readNotes`; refresh failures propagate to `gym.refreshWorkout`. Superseded reads and cancellation exceptions are unreported. Actual coroutine cancellation propagates; a cancellation exception in an active coroutine returns the existing failure outcome.
- Regression coverage lives in `GymNavigatorTests`, `NotesStateTests`, `NotesScreenTests` and `NotesStoreTests` under `:gym`. The animated pop test calls the production holder wiring, checks the departing editor remains drawn mid-transition, then restores and re-provides its key to check the old value is absent.
- Structural review: frame state has one shared retirement owner, and notebook reads have one snapshot publisher. Seat isolation comes from the keyed holder; no explicit disposal cleanup is needed. WP-G/113 should call `reread` directly without a second `readTraining` wrapper.
- Follow-up tree node `android-notes-reorder-followups` tracks active-reorder edge scrolling and drag-start haptics; neither is in this package.

**Done when**
- Separate new-note visits create distinct records and preserve the first note's words, including during animated exits.
- Popped/reset entries and closed drafts retire saved state exactly once; recreation retains active visit identities and typed values.
- A fast vertical handle swipe scrolls without changing order or emitting a move; long-press drop saves once, cancellation restores, and sideways handle swipes do not delete.
- Read failures preserve the prior notebook, report once under `gym.readNotes`, and allow the existing Try again action to recover.
- The orchestrator's Gradle checks and native/local-stack acceptance pass.

**Depends on:** 26. Tree: `android-task-106`. Coordination: 113 consumes the guarded `reread` as is.
