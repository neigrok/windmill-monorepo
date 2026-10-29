# Hide workout: the logger can be left, the workout bar brings it back, and the notification's swipe only turns it off

**Status:** On main at `a06d1b54` in batch `b40dd5e0`; the shipped canonical states are 🚀 In production. The coordinated app release remains pending.

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — human-approved 2026-10-25. The management-sheet Add movement entry remains; the main rack has no standalone Add button.

**Figma:**
- 03.5 Hide workout, the workout waits above the tabs: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41318) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41409)
- 03.4 This workout draws the *Hide workout* item and the *Notification off* · *Show* row (board linked from 11); 00.1 draws the workout bar's anatomy (board linked from 03).
- Components (Design System library, Android page):
  - `Android / Workout bar` `349:2488`: 412 × 48, the routine and the time since start, `keyboard_arrow_up` trailing
  - `Android / Top app bar` Type=Workout `342:2941`: **Finish**, the routine, ⌄ Hide
- The iOS build is the model: *Hide workout* in This workout (`apps/ios/App/Sources/Gym/Workout/WorkoutSheets.swift:59`, `hideWorkout` at `Workout/WorkoutState.swift:750`) and the hidden workout's tab-bar accessory (`HiddenWorkoutAccessory`, `apps/ios/App/Sources/Gym/GymRoom.swift:214`).

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `WorkoutControls.Held.loggerHidden` remembers logger visibility in the existing owner/workout-scoped phone controls. The serialized `hidden` field continues to mean notification off. Rack drafts and set offers stay separate from logger visibility.
- Hide in the workout bar, Hide workout in management and system Back return to the originating tab. A 48 dp minimum `WorkoutBar` stands above the rail on tab roots while hidden; pushed screens and editors omit it. Opening it restores the same logger state.
- Notification swipe changes only notification off. The management sheet supplies Notification off · Show; Gym settings has no visibility row. Show keeps its static `gym.showWorkout` failure boundary.
- Notification opening requests retain their originating owner/workout key and are consumed after navigation. Stale requests cannot reopen another owner's workout or replay after activity restoration.
- Source compilation, the affected controls/runtime/navigation tests and 31 capture parser checks pass. Paired native appearance and four-set lifecycle/raw-buffer checks are accepted on `8d844b43` (APK `6d3ad11a…`). The client event policy admits Hide, workout-bar Open and notification Show with only bounded labels; a same-owner update to `6e365786` (APK `4bd6d92e…`) delivers each requested step exactly once to the first-party intake. Retained post-reset runtime and app exit history show no product fatal/ANR; the pre-reset boot log was not separately exported. Native technical failure injection is not claimed. Its canonical task states are marked 🚀 In production.

**Change**
- Hide (03.5):
  - The logger's bar ends with ⌄ **Hide**: `IconButton(Icons.Rounded.KeyboardArrowDown)`, content description *Hide workout* (the slot 03 left).
  - This workout (03.4) gains the list item **Hide workout** (leading `keyboard_arrow_down`) under **Add movement**.
  - Hide, **Hide workout** and system Back all leave the logger with the workout running and show the tab the lifter came from. `BackMeans.StayInTheWorkout` goes; back from the logger hides it.
  - Remember the hidden state on this phone with the workout, so a restart with a hidden workout opens the tabs, not the logger.
- The workout bar (03.5), new `ui/WorkoutBar.kt` from `Android / Workout bar`:
  - Shown on every tab root while a workout runs and the logger is hidden, in the Scaffold's bottom bar right above the navigation bar.
  - One `Surface(onClick)` row, 48 dp min, surface container, 1 dp `border/subtle` top edge: the accent `fitness_center` glyph, *Push A* (bold, ellipsis) and *· 12:34*, the time since start in tabular figures, ticking each second; `keyboard_arrow_up` trailing.
  - A tap opens the same preserved logger/rack draft with 09’s compact headerless ledger and visual movement position. Content description *{routine}, in progress*.
  - Not shown on pushed screens, in the editor, or while the logger is up.
- The notification's swipe (03.4, 04 header):
  - Swiping the notification away only turns it off. Rename the state *notification off*; it never hides the workout.
  - This workout shows the row **Notification off** (leading `notifications`) with a quiet text button **Show**, only after the swipe. **Show** posts the notification again (today's `showWorkout(key, false)` path).
  - Delete *Workout hidden* / *Show workout* from Gym settings (46 deletes the screen).

**Out of scope:** the bar's chrome (03); This workout's other rows (11); the notification's content (15); Gym settings (46).

**Done when**
- Screenshots of 03.5 match in Dark and Daylight, and 03.4 matches in full with its two new rows; the rig (01) adds `03.5-hide-workout-dark/light` and recaptures `03.4-this-workout-dark/light`.
- A test leaves a live workout with Hide and with Back, sees the workout bar on Routines, The log and Coach, taps it, and lands in the logger with the same rack. Another test recreates the activity with the workout hidden and finds the bar, not the logger.
- Events: `gym_action` with `screen=workout`, `action=hide`; `screen=workout_bar`, `action=open`; `screen=workout`, `action=show_notification`, `outcome=ok` / `refused`. List them in `docs/ANDROID_OBSERVABILITY.md`. The time and the routine name are never event properties.
- A failed Show still reports under `gym.showWorkout`.
- Tests: `GymTabsTests.kt`, `GymRailTests.kt` (the rail and the bar stand together while hidden), `ui/LoggerScreenTests.kt`, `notification/WorkoutNotificationsTests.kt` (the swipe turns the notification off and leaves the workout shown).

**Depends on:** 03, 11.

**Ledger:** 12c, 9r; dogfood `android-gym-target-page`.
