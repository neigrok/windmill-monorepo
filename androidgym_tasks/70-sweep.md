# Sweep: deprecated APIs, dead code, warnings and the last known flake

**Status:** Cleanup. Not started.

**Current implementation**
- **Deprecated APIs:**
  - `LocalClipboardManager` in `GymRoom.kt`, `coach/CoachBubble.kt`, `sharing/WorkoutShareCard.kt` and about 10 tests.
  - `lifecycle.whenResumed` in `app/.../MainActivity.kt`.
  - The framework `android.media.ExifInterface` in `coach/CoachPhotos.kt`, which has known bugs on API 26–28.
- **Dead code and resources:**
  - `GymGlyph.openInNew` (`ui/GymSkin.kt`).
  - Drawables `gym_open_in_new.xml`, `gym_photo.xml`, `gym_settings.xml`. Library modules skip lint's `UnusedResources`, so lint never flags them.
  - `Finish.discard = "Discard session"`, used only by absence asserts.
  - The unused `AskThread` import and the dead string `Threads.past`.
- **Compiler warnings:** "Condition is always 'true'" (about 10 in `coach/CoachStore.kt` and one in `GymRoom.kt`) marks dead defensive branches. Also "Redundant creation of Json format" in `WorkoutControls.kt`.
- **`MainActivity`:** it re-runs `enableEdgeToEdge` from a `SideEffect`; `DisposableEffect(dark)` states the intent.
- **Flaky test:** `HeldWeightLifecycleTests.aRefusedReleasedDeleteRestores…` (release variant) failed once locally on `store.refusals == []`. `engine.notices` can trail the sync that just ran, and the test pins a moment instead of waiting for a condition.

**Change**
- **APIs:** replace the deprecated ones: `LocalClipboard` with the suspend API, `repeatOnLifecycle`, and AndroidX `ExifInterface`.
- **Dead code:** delete the dead code, resources, branches and strings.
- **Lint:** turn on `UnusedResources` checking for the library modules, or a check that covers them.
- **`MainActivity`:** use `DisposableEffect(dark)`.
- **Flake:** make the test wait for the refusal notice as a condition.

**Done when**
- `./gradlew build` shows no Kotlin warnings in main sources.
- Lint is clean of the items above.
- The flaky test passes 50 runs in a loop.

**Depends on:** none.
