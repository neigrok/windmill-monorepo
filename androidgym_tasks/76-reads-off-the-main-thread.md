# Nothing the engine reads runs on the main thread

**Status:** Not started. Performance; nothing visual changes.

**Context:** a long training history once made Android cold-start in tens of seconds and raise ANRs, because every engine read ran on the main thread. The bulk reads have since moved off main. The refresh loop, a few reads and the first session open still run there, and no one has measured a cold start with a long history since task 68 split the store.

**Current implementation** (paths under `apps/android/`)
- `TrainingSeat.readTraining` runs the log, programme, open-workout and progress reads on `readDispatcher` (`gym/…/store/TrainingSeat.kt:57`), which is `Dispatchers.Default` by default (`TrainingStore.kt:44`).
- The store's scope is `Dispatchers.Main.immediate` (`app/…/WindmillApplication.kt:71`), so `observeEngine`'s refresh loop runs on main (`TrainingStore.kt:209-223`).
- These reads bypass `readTraining`:
  - `readCatalogue` and `adoptReceipts` (`RoutinesStore.kt:59,63`);
  - `readSeries` (`BodyweightStore.kt:45`);
  - `training.settings()` and `recoverAcceptedSets`.
- `Application.onCreate` opens SQLite (`WindmillApplication.kt:118`) and decrypts the session through the Keystore (`:124`) on main.

**Change**
- Measure first, before and after the change. Use a release build on the Pixel API 34 image with a 200-workout history, and record cold start (`am start -W`) and skipped frames.
- Every engine read goes through the seat's read dispatcher. Compose state and writes stay on main.
- The refresh loop reads off main and publishes on main.
- The first session open and the credential presence check move out of `onCreate`. An undecryptable credential still pauses auth, as it does today.
- A test with an injected dispatcher proves that no engine read runs on the main dispatcher.

**Done when**
- The task report records cold start and skipped frames at 200 workouts, before and after.
- StrictMode in a debug build reports no engine disk read on main during a cold start and a log scroll.

**Depends on:** 68. Tree: `android-engine-reads-off-main`.
