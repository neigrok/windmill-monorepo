# Split TrainingStore into feature stores; screens take state and events, not the store

**Status:** Refactor; nothing visual changes. 🚀 On main (`c124425c`). A local-stack regression pass over sign-in, workouts, the log, routines, notes, Coach, sharing and an account switch found no behaviour change. The rig recaptures have not been re-run.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- **Feature stores (`store/`):** each takes the shared `TrainingSeat` (whose replica is in hand, whether this phone may write it, the one guarded `readTraining`, `tried`, `reportFailure`, the refresh nudge) by constructor; upward edges are named lambdas, as `CoachStore` already used.
  - `WorkoutSession`: rack, sets, movement walk, start, finish, save state and stranded sets, and fix, delete and discard of a set or workout already on the log, because the live workout's controls follow every such change.
  - `HistoryReads`: the log's pages and foot (`Older`, `Pulls`, the `first_pull` events, the walked-range refresh), retained details, record, routine history, progress, movement edit. `loadLog` keeps its lock around the live workout's follow of the replica's open one (`followOpenWorkout`).
  - `RoutinesStore`: routines, movement catalogue, proposals and their settling.
  - `RecoveryStore`: imports and On this phone.
  - `DeletionsStore`: the routed set, routine and note delete, and the weigh-in's engine hold with its Undo. `HeldDeletes` (`WithheldDelete.kt`) holds the holds and the room's settled set deletes.
  - `BodyweightStore`, `NotesStore`, `SharingStore` (connected log and share links), and the existing `CoachStore`.
  - `TrainingStore` is the composition root: it builds the seat and the stores and moves them together in `connect`, `refreshEngine`, `observeEngine`, `prepareEngineTransition`, `eraseDeletedOwner` and `restoreWorkout`; `clearRefusals` and `initialGymEmpty` span several stores. Write outcomes live in `WriteOutcomes.kt`.
- **Screens:** each screen file declares a `@Stable` `…State` of live getters, an `…Events` interface and a stateless `…Binding` over the feature stores; `GymRoom` remembers one binding per store. No screen composable takes `TrainingStore`; the room does (`GymRoom`, `GymModule`), and so do the room's flows in `RoomSheets.kt` (`ReviewFlow.Sheet`, `FinishFlow.FollowTheLog`, `FinishFlow.CarryShareToCoach`, `FinishFlow.Sheet`). Every screen previews its main states in Dark and Daylight (`@DarkAndDaylight`, `GymPreview` in `ui/GymMaterial.kt`), themed from the system appearance as the app is.
- **Room:** `RoomSheets.kt` holds `FinishFlow` (the finished session and its saver, the sheet, closing, the queued share, the first signed-out receipt's Keep, read from `gym-receipts` only when a receipt opens) and `ReviewFlow` (the open review, busy, looked-at, receipts). `RoomChrome.kt` holds `FrameChrome`, `TabRail`, `RailLabels` and `railIcon`. Each `Frame` declares `hostsTransient`: the Log and Routines tabs and the logger host the room's transient above their floating button; every other frame's chrome hosts it. `GymRoom.kt` is about 980 lines.
- **Lint:** no `AutoboxingStateCreation` and no `FrequentlyChangedStateReadInComposition`; `AssemblySheet` derives its drag edge with `derivedStateOf`.
- **Held deletes:** every held delete is a weigh-in's engine hold. The store's timed session hold, its explicit settle and abandon, and the filters only it fed (Coach threads, note moves, routine history, the log's `recent`) are gone.
- **Tests** mirror the stores: `store/WorkoutSessionTests`, `RoutinesStoreTests`, `HistoryReadsTests`, `NotesStoreTests`, `DeletionsStoreTests`, with seat changes, restore and Coach through the store left in `TrainingStoreTests`; the room's in `RoomSheetsTests` and `RoomChromeTests`.

**Observations**
- `WorkoutSession` is about 790 lines. Fix, delete and discard of a logged workout read and redraw the live workout's controls, so there is no clean seam between live and logged corrections yet; a split would first need the live workout to follow a correction by observation rather than by call.
- `AskState` carries the whole `CoachStore`, because `CoachComposer` and `CoachPhoto` take it. Narrowing it means giving the composer its own state and events (about ten members) and the conversation's remaining Coach reads their own; worth doing with the next Coach screen change.
- The bindings' secondary `TrainingStore` constructors are a convenience for the room and the tests; the primary constructors name the exact stores each screen reads.
- `HistoryReads`, `RecoveryStore` and `WorkoutSession` reach back into the composition through lambdas (`followOpenWorkout`, `refresh`). They mark where a feature still triggers a room-wide re-read; an observed engine revision could replace them.

**Change**
- **Feature stores:** split `TrainingStore` in the same constructor-injected style:
  - `WorkoutSession`: rack, log and finish
  - `HistoryReads`: log, record and progress
  - `RoutinesStore`
  - `RecoveryStore`: imports and On this phone
  - `DeletionsStore`: withhold and undo
  - the existing `CoachStore`
- **Screens:** each takes a narrow state class and an events interface. Add `@Preview`s for each screen's main states, Dark and Daylight.
- **Room:** move the finish and review sheet choreography into their own composables, and move the SharedPreferences readers out of composition. Inline `FinishReceipts` (19 lines, one consumer).
- **Lint:** fix the autoboxing and the `layoutInfo` read in composition.
- **Room chrome:** `TabRail`, `RailLabels` and the frame chrome move out of `GymRoom.kt` into their own file.
- **Transient host:** a screen with a floating action button declares that it hosts the room's transient, in place of the room deciding by frame type (`RoomFrame.screenTransient`).
- **Timed store hold:** `TrainingStore.withhold`/`armDelete` (`Deletion.Session`) runs only in tests, because every live delete is an engine hold. `DeletionsStore` drops it.

**Done when**
- The whole gym test suite passes. Behaviour tests move with their code, and the test tree mirrors the new layout.
- Rig recaptures are unchanged.
- No screen composable takes `TrainingStore`.
- Lint shows no `AutoboxingStateCreation` and no `FrequentlyChangedStateReadInComposition`.

**Depends on:** 53.
