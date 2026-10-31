# Predictive back and navigation motion: pushed screens follow the gesture, sheets keep the stock preview

**Status:** Implemented, awaiting merge. `GymNavigator.kt` holds the room's navigation (tab, `Away` stack, saver, `Standing` back rules, `BackMeans`, `BackGuard`) and `GymStage` draws it; every sheet is a `WindmillSheet` (`:platform` design). Material 1.3's own sheet preview cannot be kept: its window callback outranks the sheet's dispatcher, so it would close a busy sheet or skip a nested step. `WindmillSheet` draws the same bottom-anchored shrink from the dispatcher instead. The boards are 00.5 and 00.6, approved 2026-10-31.

**Figma:**
- 00.5 Pushed screen, predictive back (swipe starts · mid swipe · release): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1743-26713) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1743-27031)
- 00.6 Sheet, predictive back: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-25871) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1745-26174)

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `GymRoom.kt` claims system Back with one root `BackHandler(enabled = means != BackMeans.LeaveTheApp)`. Pushed screens (the `Away` stack) pop instantly. Back shows only the legacy edge chevron; nothing previews or scales.
- Push, pop and tab switches are hard cuts: `GymRoom.kt`, `GymScreen.kt` and `:platform` have no `AnimatedContent`, `Crossfade` or `AnimatedVisibility`.
- `PredictiveBackHandler` is used only in `ui/onboarding/OnboardingPager.kt`.
- Sheets: `platform/.../design/WindmillMaterial.kt` `WindmillSheetBack` installs a plain `BackHandler(onBack = onDismiss)`, which overrides `ModalBottomSheet`'s built-in predictive-back scale. Its users: `YouSheet`, `LogScreen`, `BodyweightScreen`, `SessionScreen`, `MovementPicker`, `RoutineBuilder`, `LoggerScreen`, `RecordScreen`.
- Screen-local `BackHandler`s that swallow Back while busy (`BackHandler(saving) {}` and the like in Notes, Log, Record, Bodyweight, RoutineBuilder and FixSheet) stay. They must keep blocking the gesture's commit.
- The manifest sets `enableOnBackInvokedCallback`; system-level back-to-home already previews.

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
  - Delete `WindmillSheetBack`'s `BackHandler`, so `ModalBottomSheet`'s stock predictive back (shrink toward 90 %, anchored at the bottom) runs on every sheet.
  - A sheet that must not close while busy keeps its own `BackHandler(busy) {}`.

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
