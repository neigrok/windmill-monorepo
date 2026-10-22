# The Log: Weigh in extended FAB, discard by swipe, workout wording

**Figma:**
- 05.1 The Log, Weigh in FAB: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-4666) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30839)
- 05.2 The Log, discard by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27527) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30907)
- 05.11 A moment expanded in place: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30237) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31437)
- 05.12 Empty log: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30325) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31496)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / FAB` `1247:2332` (Extended)
  - `Android / Swipe row` `1247:2439`
  - `Android / Menu` `1260:2608`
  - `Android / Top app bar` `1260:2948`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- *Weigh in* is a full-width `raised` button, 56 dp, pinned under the list (`ui/LogScreen.kt:148-150`, `WeighInChip` at `ui/BodyweightScreen.kt:82-90`).
- Workout rows (`SessionRow`, `ui/LogScreen.kt:241-267`): no swipe. A long press gives the haptic and a menu, *Share this workout* / *Discard session* (`Finish.discard`, `ui/FinishScreen.kt:64`); the same two are TalkBack actions. The click label is *Open session*.
- Discard is a held delete, nine seconds behind *Session deleted.* + *Undo*, with no confirmation (`GymRoom.kt:643-647`).
- Share from the row mints and copies a link, then *Link copied — anyone who has it can read this workout* (`GymRoom.kt:811-826`).
- *Session* on screen: *Free session* (`domain/Readout.kt:90`, used by `domain/LogReadout.kt:39`), *No sessions yet* (`ui/LogScreen.kt:114`), *Last 12 weeks · {n} sessions* in an open moment (`ui/LogScreen.kt:222`), *First session · {date}* (`ui/LogScreen.kt:273`).
- The door *Saved workouts need review (N)* sits above the navigation bar in alarm ink (`GymRoom.kt:980-982`).
- Defect: the timeline shows only the first weigh-in. One moment is chosen per week (`domain/LogTimeline.kt:71-74`), and a weigh-in has the lowest priority (`domain/LogTimeline.kt:35`), so it loses to a best or a month in the same week. Read from code, not yet confirmed on the emulator: that is why later weigh-ins, today's included, are missing.

**Change**
- Replace `WeighInChip` with an M3 `ExtendedFloatingActionButton`: icon `monitor_weight`, label *Weigh in*, bottom end.
  - 16 dp above the navigation bar; 12 dp above the review door when it shows. The door keeps its text and colour.
  - The list's bottom padding grows so the FAB never covers the foot.
  - Delete `WeighInChip`.
- Swipe a workout row end-to-start on `DeleteSwipeRow` (04), a11y label *Discard workout*.
  - Past the threshold, the same dialog as 03.14 (14): title *Discard this workout?*, body *Its 5 sets leave your log for good.* (*Its {n} sets leave your log for good.*), **Cancel** / **Discard** (error role, 02).
  - Discard removes the workout at once, with no hold and no Undo. Cancel puts the row back.
- The long-press menu keeps both items: *Share this workout* / *Discard workout*. Discard opens the same dialog. Change `Finish.discard` to *Discard workout* so every door says it.
- Words: *Free workout*, *No workouts yet* (body *Your training will land here.* unchanged), *Last 12 weeks · 6 workouts* (from 21's `sessionCount`), *First workout · {date}*, click label *Open workout*.
- 05.11: moments expand in place as today; only the FAB and *workouts* are new.
- The weigh-in defect: the boards draw one weigh-in moment per week, so do not change the one-per-week rule on your own. Bring the case (six weigh-ins in four weeks, one shown) to the designer, and change `logTimeline` only after a ruling.

**Out of scope:**
- The discard dialog itself (14); the shared swipe row (04).
- The Bodyweight screen and the weigh-in sheet (24; 06.1 matches today).
- The Record (21).

**Done when**
- Screenshots of 05.1, 05.2 (mid-swipe and the dialog), 05.11 and 05.12 match in Dark and Daylight; the rig (01) adds `05.1-log-weigh-in-fab-dark/light`, `05.2-log-discard-swipe-dark/light`, `05.11-log-moment-expanded-dark/light`, `05.12-log-empty-dark/light`.
- Discard and share emit nothing today. Add `gym_action` with `screen=log`:
  - `action=discard`, `state=shown` when the dialog opens, then `outcome=ok` / `cancelled` / `refused` / `failed`
  - `action=share`, `outcome=ok` / `refused` / `failed`.
- Failures still report as `gym.discard` and `gym.share`; a refused discard puts the row back and the note line says why.
- Tests: `ui/LogRowMenuTests.kt`, `ui/LogRowLayoutTests.kt`, `ui/LogStateTests.kt`, `ui/LogMomentTests.kt`, `LogTransientTests.kt` (no Undo snackbar), `domain/LogReadoutTests.kt`.

**Depends on:** 04, 05, 14, 21.

**Ledger:** 9q, 9z, 11b; dogfood `android-gym-target-page`, `android-log-and-record-reads`.
