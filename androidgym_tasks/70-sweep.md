# Sweep: deprecated APIs, dead code, warnings and stale references

**Status:** Cleanup. Not started.

**Current implementation**
- **Deprecated APIs:**
  - `LocalClipboardManager` in `GymRoom.kt`, `coach/CoachBubble.kt`, `sharing/WorkoutShareCard.kt` and about 10 tests.
  - `lifecycle.whenResumed` in `app/.../MainActivity.kt`.
  - The framework `android.media.ExifInterface` in `coach/CoachPhotos.kt`, which has known bugs on API 26–28.
- **Dead code and resources:**
  - Drawables `gym_photo.xml`, `gym_settings.xml`. Library modules skip lint's `UnusedResources`, so lint never flags them.
  - `Finish.discard = "Discard session"`, used only by absence asserts.
  - The unused `AskThread` import and the dead string `Threads.past`.
- **Compiler warnings:** "Condition is always 'true'" (about 10 in `coach/CoachStore.kt` and one in `GymRoom.kt`) marks dead defensive branches. Also "Redundant creation of Json format" in `WorkoutControls.kt`.
- **`MainActivity`:** it re-runs `enableEdgeToEdge` from a `SideEffect`; `DisposableEffect(dark)` states the intent.
- **Stale ledger references:** `docs/design/consistency.md` 9r and three other lines cite `ui/SettingsScreen.kt`, which no longer exists; 9r also says Android ships *Gym settings*.
- **Large-text tests:** most scale text with `Density(x, 2f)`, which is linear. Android 14's 200 % is non-linear (16 sp draws at 28 dp), so those tests check a harsher layout than a phone shows; `RuntimeEnvironment.setFontScale(2f)` gives the real curve.

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
