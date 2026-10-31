# Split TrainingStore into feature stores; screens take state and events, not the store

**Status:** Refactor; nothing visual changes. Not started. Land it after 53, which moves the navigator out of `GymRoom`, to avoid a double rewrite.

**Current implementation**
- **`store/TrainingStore.kt` (~2,300 lines)** is one class with about 75 functions and about 50 Compose `mutableStateOf` fields. It mixes:
  - repository and view-model work
  - the recovery flow and deletion/undo
  - Coach composition
  - preferences, bodyweight, notes and progress

  Compose runtime state lives in the store layer.
- **`GymRoom.kt` (~1,400 lines)** is mostly one `@Composable` with about 30 `remember`/`rememberSaveable` states:
  - the finish-sheet choreography, the review sheet and receipts
  - Coach selection and the notification permission
  - SharedPreferences reads in composition (`FinishReceipts`)

  Any store read at its top re-executes the whole body.
- **Screens and previews:** about 20 screen entry points take `store: TrainingStore` directly (`LogScreen`, `LoggerScreen`, `AskScreen`, …), so no screen hoists its state and there are **0 `@Preview`s**. Design iteration depends on the emulator rig.
- **Lint flags:**
  - `AutoboxingStateCreation` ×11: use `mutableLongStateOf`/`mutableIntStateOf`.
  - `FrequentlyChangedStateReadInComposition` in `AssemblySheet.kt`, where `layoutInfo` is read during composition and recomposes every drag frame.

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

**Done when**
- The whole gym test suite passes. Behaviour tests move with their code, and the test tree mirrors the new layout.
- Rig recaptures are unchanged.
- No screen composable takes `TrainingStore`.
- Lint shows no `AutoboxingStateCreation` and no `FrequentlyChangedStateReadInComposition`.

**Depends on:** 53.
