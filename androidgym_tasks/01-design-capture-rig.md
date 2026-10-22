# An emulator capture script that screenshots every board's state in Dark and Daylight

**Figma:** none. This is the tool every later task uses for its "screenshot matches the board" check. The target is the [Android page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `app/`)
- There is no capture tool. `apps/android/tools/` holds only `release.py` and `schema_gen.py`.
- Tests are Robolectric and Compose UI tests (`apps/android/gym/build.gradle.kts:53-55`). They draw no PNG of a real screen.
- The debug build reaches a local backend with `-Pwindmill.apiBase=http://10.0.2.2:<port>` (`apps/android/app/build.gradle.kts:14`). A malformed value falls back to production, so the base must be checked in the generated `BuildConfig` (`WM_API_BASE_URL`).
- The app follows the system appearance only (`isSystemInDarkTheme()`, `app/MainActivity.kt:86`). Every Dark/Daylight switch recreates the activity.
- Engine reads run on the main thread, so captures stall:
  - `GymRuntime` runs on `Dispatchers.Main.immediate` (`store/GymRuntime.kt:25`).
  - `TrainingStore.connect` (`store/TrainingStore.kt:511`), `refreshEngine` (:624), `loadProgress` (:1238) and `loadLog` (:1589) call `EngineTraining.details()` (`store/EngineTraining.kt:233`) and `sessions()` (:261), which parse every replica row.
  - With about 14 workouts, a cold start takes 20 s or more, and every appearance switch shows *Windmill isn't responding*. With a workout open, the main thread stays busy even when idle.
  - Snackbar Undo windows ran out while the screen was frozen.

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

**Out of scope:** the screens themselves (02–44).

**Done when**
- The script runs green on a Pixel emulator (API 36 or newer) in Dark and Daylight, with one PNG per capture named with its board number.
- A cold start with the fixture account reaches Routines in under 3 s, and an appearance switch shows no ANR.
- No event changes. A failed background read still reports under its existing operation (`gym.loadLog`, `gym.loadProgress`, `gym.refreshWorkout`).
- `store/EngineLifecycleStoreTests.kt` and `store/TrainingStoreTests.kt` pass, with a new test that a read does not run on the main thread.

**Depends on:** none.

**Ledger:** 11a; dogfood `android-gym-target-page`, `android-engine-reads-off-main`.
