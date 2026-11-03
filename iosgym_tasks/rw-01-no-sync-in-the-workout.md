# Nothing about sync in the workout

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** none to draw: the workout's approved boards (Gym iOS 03) already draw no sync mark. Where sync lives instead: rw-02.

**Context:** owner ruling 2026-11-03: a workout says nothing about sync. A set it saved is expected to sync; sync state lives in one static place reached from You (rw-02). The log's rows carry no sync mark either.

**Current implementation** (paths under `apps/ios/App/Sources/`)
- `Gym/Workout/WorkoutScreen.swift` `WorkoutLedgerRow`: a logged set that `GymModel.unsentSets` holds draws the `iphone` symbol in ink-dim instead of the done checkmark (`:377`), and its VoiceOver label ends ", on this phone" (`:401`); `WorkoutScreen` passes `unsent` per row (`:243`, `:259`).
- `Gym/Log/LogTab.swift` `LogEntryLabel`: `unsent` draws the `iphone` symbol labelled "On this phone" (`:248`), fed by `GymModel.sessionIsUnsent` (`:157`).
- `WindmillApp.swift` `UpdateRequiredAlert.present(for:)` (`:142`–`:166`) presents the *Update required* alert over whatever is in front, a running workout included.

**Change**
- Every logged ledger row shows the done checkmark; the row's VoiceOver label drops ", on this phone". Remove the `unsent` parameter from `WorkoutLedgerRow` and `LogEntryLabel`.
- `GymModel.unsentSets` / `sessionIsUnsent` lose their view consumers; keep them only if rw-02 reads them, otherwise delete them.
- The update alert is not presented while the workout screen is up; the update state shows through You (rw-02, 16j/16n) and the account button's dot (rw-03). Whether the alert stays outside a workout is decided in rw-02.

**Done when**
- A set logged offline shows the checkmark in the ledger and no mark on the log row; VoiceOver reads "Set 2, logged, 80 kilograms, 5 reps".
- A 426 received mid-workout presents no alert; after Finish the state is visible in You.
- UI tests cover both; `client_update_required` keeps its events with no new `state`.

**Depends on:** rw-02 for where the state moves. Tree: `ios-rw-01-no-sync-in-workout`, under `ios-review-wave-parity`.
