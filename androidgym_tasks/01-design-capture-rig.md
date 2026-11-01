# An emulator capture script that screenshots every board's state in Dark and Daylight

**Figma:** none. This is the tool every later task uses for its "screenshot matches the board" check. The target is the [Android page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2).

**Current implementation**
- `apps/android/tools/design_capture.py` builds and validates a local-only debug APK, creates an isolated fixture database and Pixel emulator, and captures the current board states in both appearances. The [runbook](../apps/android/tools/DESIGN_CAPTURE.md) documents recipes, deterministic model responses, private debug sign-in, readiness, profiling and cleanup.
- History, session, progress and program reads use the training stores' injected background dispatcher. The engine lock protects a parsed-log cache keyed by replica and complete engine revision; auto-close deadlines also invalidate it.
- The workout's pending-status getter uses a published read and current local set values. Recomposition performs no engine query. Superseded reads cannot publish into another account; the observer resumes pending connections and manual reads retain a retryable state.
- The debug-only, non-exported readiness provider measures process start through a rendered frame with the fixture routines loaded. The rig independently verifies body content, preserves the APK hash and source state, enforces the 3-second budget, and records ANR/fatal failures in its manifest.

**Verification**
- The integrated Pixel 8 / API 37 run captures ten PNGs in Dark and Daylight, including deterministic Coach answers. Rendered Routines readiness is 1,655 ms; the independent accessibility selector completes in 3,898 ms. No ANR, fatal exception or capture failure is recorded.
- The comparable baseline and task01 APKs use the same debug readiness probe and fixture. Cold readiness is 9,205 ms versus 1,821 ms; ten-second idle traces record 649.977 ms versus 369.043 ms on main, with no engine-read or pending-set query sampled on main in the final trace.
- The integrated gym Debug suite passes 1,167 tests with 17 opt-in live-wire skips; sync-engine Debug and Release each pass 183 tests. Four capture-tool tests pass. Native event intake, structured writes and a content-free installed-app `gym.storage.read` Sentry envelope are verified in the [batch record](../docs/engineering/android-implementation.md).

**Change**
- Move engine reads off the main thread.
  - Run `EngineTraining` reads (`details`, `sessions`, `progress`) on a background dispatcher. Publish the results to Compose state on main.
  - Keep one parsed log per replica revision, so a recreation does not parse again.
  - Find and stop the idle main-thread work while a workout is open (measure with a CPU profile before and after).
- Add `apps/android/tools/design_capture.py`:
  - Builds the debug app against the local stack and checks `WM_API_BASE_URL` before it installs. It refuses to run against production.
  - Seeds one fixture account through the local sync and MCP doors: Push A, Pull A, Legs, 12 workouts over 4 weeks, 6 weigh-ins, 2 notes. A second, empty install covers the signed-out boards.
  - Starts the backend with `ANTHROPIC_BASE_URL` pointing at a deterministic local stand-in, so Coach answers, proposals and tool receipts are the same on every run.
  - Reaches each state, switches appearance with `adb shell cmd uimode night yes|no`, waits for the screen to settle, and saves `adb exec-out screencap -p`.
  - Names every capture with its board number, e.g. `02.1-routines-dark.png` / `02.1-routines-light.png`, and writes `capture-manifest.json` (board, mode, file).
- States that do not survive a recreation (dialogs, menus, snackbars, swipes in progress) are captured in each mode after the switch, not across it.
- Each later task adds its own captures to this script.

**Out of scope:** the screens themselves (every later task).

**Done when**
- The script runs green on a Pixel emulator (API 36 or newer) in Dark and Daylight, with one PNG per capture named with its board number.
- A cold start with the fixture account reaches Routines in under 3 s, and an appearance switch shows no ANR.
- No event changes. A failed background read still reports under its existing operation (`gym.loadLog`, `gym.loadProgress`, `gym.refreshWorkout`).
- `store/EngineLifecycleStoreTests.kt` and the training store suites pass, with a test that a read does not run on the main thread.

**Depends on:** none.

**Ledger:** 11a; dogfood `android-gym-target-page`, `android-engine-reads-off-main`.
