# Sweep: deprecated APIs, dead code, warnings and stale references

**Status:** Done on `android-native-wave-a`; not yet on main.

**Current implementation**
- **Deprecated APIs:** clipboard writes go through `LocalClipboard`'s suspend `setClipEntry` (`GymRoom.kt`, `coach/CoachBubble.kt`, `sharing/WorkoutShareCard.kt`); the two on-tap copies start undispatched, so the copy lands in the same frame as before. Their tests fake `Clipboard` and read the platform clip. `MainActivity` asks for keyguard dismissal through `withResumed`, the one-shot replacement for `whenResumed`; `repeatOnLifecycle` would ask again on every resume. Coach photos read orientation with AndroidX `ExifInterface`.
- **Dead code:** gone — the `gym_photo` and `gym_settings` drawables, `Finish.discard` (its absence asserts now check the live *Discard*), `Threads.past`, `Ask.notesDoor`, `SetEffort.rpeLabel`, AskScreen's and ThreadScreen's unused `onNotes`, `gymFieldColours`, `dashedEdge`, `GymColors.weightInk`, `RowDeleteGround`, platform's `ActionCapsule`, `GymEngineSession.anonymousCounts`, `gymLineageCounts`, `TrainingStore.retryImport`, `WorkoutImports.replaceStartAndRetry`, and the unused imports in `:gym` main and tests.
- **Compiler warnings:** none in `:app`, `:platform` or `:gym` main sources. CoachStore's always-true `seat` checks are gone, and the strict workout decoder is one `workoutJson` in `WorkoutControls`. Two remain in `:sync-engine` (`AndroidSqlite.kt` `setIdleConnectionTimeout`, `Transport.kt` `onFailure` parameter name), outside this sweep's files.
- **Lint:** the app's lint reads its dependencies (`checkDependencies`) and fails the build on `UnusedResources`. The tile's pre-34 `startActivityAndCollapse(Intent)` branch suppresses `StartActivityAndCollapseDeprecated`, which the app-level lint raises as an error.
- **`MainActivity`:** `enableEdgeToEdge` runs from `DisposableEffect(dark)`.
- **Ledger:** 9k, 9r, 11c and 12c in `docs/design/consistency.md` point at the code that holds those parts now; 9r no longer says Android ships Gym settings.
- **Large-text tests:** unchanged. Compose 1.8's `Density(density, fontScale)` already applies Android's non-linear curve (16 sp sets at 28 dp, 40 sp at 46.9 dp at `fontScale` 2), the same as `RuntimeEnvironment.setFontScale(2f)`.

**Change**
- **APIs:** replace the deprecated ones: `LocalClipboard` with the suspend API, `repeatOnLifecycle`, and AndroidX `ExifInterface`.
- **Dead code:** delete the dead code, resources, branches and strings.
- **Lint:** turn on `UnusedResources` checking for the library modules, or a check that covers them.
- **`MainActivity`:** use `DisposableEffect(dark)`.
- **Ledger:** point the `SettingsScreen` lines at the code that holds those settings now, with the ledger's owner.
- **Large text:** move the large-text tests to the real font-scale curve where the linear one tests a layout no phone draws.

**Done when**
- `./gradlew build` shows no Kotlin warnings in main sources.
- Lint is clean of the items above.

**Depends on:** none.
