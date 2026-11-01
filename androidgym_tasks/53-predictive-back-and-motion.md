# Predictive back and navigation motion: pushed screens follow the gesture, sheets keep the stock preview

**Status:** 🚀 On main (`70ec2dbe`), not yet in a published release. Boards 00.5 and 00.6 are 🚀 In production.

**Figma:**
- 00.5 Pushed screen, predictive back (swipe starts · mid swipe · release): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1743-26713) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1743-27031)
- 00.6 Sheet, predictive back: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-25871) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-26174)

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `GymNavigator.kt` holds the room's navigation: `Tab`, the `Away` stack and its saver, `Standing` (what Back means and which `Frame` stands), `BackMeans`, `BackGuard` and `KeepOnBack`. `GymRoom.kt` draws each frame through `GymStage`, which keeps each frame's saved state under the frame's key.
- `GymStage` drives Back with one `PredictiveBackHandler`. A gesture on a pushed screen, the logger or the routine editor shrinks the standing frame toward 90 % with 28 dp corners over the frame its release returns to; the release slides it out and the frame below settles; a cancelled gesture restores it. A Back that lands during a release cannot stop the pop it committed to, and it waits for the stage to settle before it acts. The stage holds the room's latest `onBack` by identity, not equality: the room passes `::goBack`, and two references to one local function compare equal whatever they captured, so an equality check would keep the first composition's.
- Push and pop use the shared X axis and tab switches fade through, 300 ms with emphasized easing (`platform/.../design/NavigationMotion.kt`). With *Remove animations* on, every transition is a cut (`animationsOn()`).
- `BackGuard` lets a screen veto the preview and ask instead of leaving; only the standing frame's guard counts. The routine editor registers one (task 56). Screen-local `BackHandler(busy) {}`s swallow Back and the gesture. `KeepOnBack` keeps the logger's typed rack entry before Back hides the workout.
- Every sheet is a `WindmillSheet` (`:platform` design), which previews Back from its own window's dispatcher (see **Change**). A close it has begun finishes even when another Back arrives.
- The rig's `tools/capture-recipes/predictive-back.json` captures 00.5 and 00.6. Tests: `GymNavigatorTests`, `platform/design/WindmillSheetTests`.

**Change**
- **Pushed screens (00.5):**
  - Every in-app pushed screen follows the back gesture: it shrinks to 90 %, takes 28 dp corners and follows the finger. On release it exits and the screen below settles. A cancelled gesture restores the screen.
  - Pushes and pops use the M3 shared axis X. Tab switches use fade-through. Both run 300 ms with emphasized easing.
  - With the system's *Remove animations* on (`Settings.Global.ANIMATOR_DURATION_SCALE == 0`), every transition is a plain cut.
- **Structure:**
  - Move the room's navigator out of the `GymRoom` composable: the `Away` stack, its saver, the back rules and `BackMeans` go into one `GymNavigator`.
  - Drive back with `PredictiveBackHandler`, or with `NavDisplay` from Navigation 3 if it fits the existing stack without a second source of truth.
  - Give a screen a way to veto the preview while it holds unsaved work, for example a `backGuard` the screen registers. Task 56's dirty routine draft uses it: no preview, and Back asks instead.
- **Sheets (00.6):**
  - Every sheet previews Back with the stock motion: it shrinks toward 90 %, anchored at its bottom, and a release closes it.
  - `WindmillSheet` draws that preview from the sheet window's own dispatcher rather than keeping `ModalBottomSheet`'s built-in one, because a busy sheet's `BackHandler(busy) {}` and a nested step the content registers must win: Material's window callback outranks them, so it would close a busy sheet or skip the step.

**Out of scope:** nav-bar labels and the top app bar (54); sheet keyboard insets (55); the routine editor's question (56).

**Done when**
- Mid-gesture stills match 00.5 and 00.6 in Dark and Daylight. Capture them on the emulator by holding a back swipe (`adb shell input motionevent DOWN/MOVE`). The rig (01) gains `00.5-*` and `00.6-*` recipes.
- Tests:
  - A gesture on a pushed screen pops it.
  - A cancelled gesture keeps the screen.
  - *Remove animations* gives cuts.
  - A busy screen's Back is swallowed.
  - Sheet Back closes the sheet.
  - Restoring the activity keeps the stack.
- Existing navigation events keep firing as listed in `docs/ANDROID_OBSERVABILITY.md`.
- Not verifiable on the emulator: the 120 Hz feel on a real device. Say so in the report.

**Depends on:** 03.

**Context:** the 2026-10-31 emulator review ranked missing predictive back first among non-native experiences. System Settings on the same emulator scales and peeks; the app showed only the chevron on every screen, sheet and tab return.
