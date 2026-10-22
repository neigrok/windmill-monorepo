# The log: its head, rows and moments as iOS draws them, Weigh in FAB, discard by swipe

**Figma:**
- 05.1 The log, Weigh in FAB: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39988)
- 05.2 The log, discard by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27527) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40892)
- 05.12 Empty log: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30325) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31496)
- Components (Design System library, Android page):
  - `Android / FAB` `337:2110` (Extended)
  - `Android / Swipe row` `337:2217`
  - `Android / Menu` `342:2725`
  - `Android / Top app bar` `342:2953`
- The iOS log is the reference: `apps/ios/App/Sources/Gym/Log/LogPresentation.swift` (the head's line, a session's facts, a new best's line, the month line, and the record dot at :136).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The root is titled *Log* (03 renames it). No head: the list starts with the first month.
- Workout rows (`SessionRow`, `ui/LogScreen.kt:241-267`):
  - the second line is the record when the workout set one, *Record · Bench Press 84 × 5*, otherwise the minutes (`domain/LogReadout.kt:30-42`); a record is also woven in as a *new best* moment, so it is said twice;
  - *On this device* under a row the account has not taken (`ui/LogScreen.kt:258`);
  - no swipe. A long press gives the haptic and a menu, *Share this workout* / *Discard session* (`Finish.discard`, `ui/FinishScreen.kt:64`); the same two are TalkBack actions. The click label is *Open session* (:249).
- Moments (`MomentRow`, `ui/LogScreen.kt:178-238`) are outlined rows with a sparkline that expand in place to a chart, *Last 12 weeks · {n} sessions*, the best, the heaviest and *Open record ›*; a weigh-in moment opens Bodyweight. The month moment reads *Trained 4 of 4 weeks* (`domain/LogReadout.kt:56`).
- *Weigh in* is a full-width `raised` button, 56 dp, pinned under the list (`ui/LogScreen.kt:148-150`, `WeighInChip` at `ui/BodyweightScreen.kt:82-90`).
- Discard is a held delete, nine seconds behind *Session deleted.* + *Undo*, with no confirmation (`GymRoom.kt:643-647`).
- Share from the row mints and copies a link, then *Link copied — anyone who has it can read this workout* (`GymRoom.kt:811-826`).
- *Session* on screen: *Free session* (`domain/Readout.kt:90`), *No sessions yet* (`ui/LogScreen.kt:114`), *Last 12 weeks · {n} sessions* (:222), *First session · {date}* (:273).
- The door *Saved workouts need review (N)* sits above the navigation bar in alarm ink (`GymRoom.kt:980-982`).
- Defect: one moment is chosen per week (`domain/LogTimeline.kt:71-74`) and a weigh-in has the lowest priority (`domain/LogTimeline.kt:35`), so later weigh-ins can be missing from the timeline. Read from code, not yet confirmed on the emulator.

**Change**
- Head (05.1), under the bar *The log*:
  - a door card **Bodyweight** / *82.4 kg · 3 days ago* with a chevron, opening Bodyweight (06.2, task 24); with no weigh-in it is not drawn;
  - under it the line *Trained 3 of the last 4 weeks*.
  - When workouts wait on this phone, *On this phone* sits above the head (07.7, task 25).
- Months as headers (*October*, *September*). A workout row: the routine (or `Readout.noRoutine`, 13), its facts *5 working sets · 8 min* (*20 working sets · 1 h 10 min*), the day trailing (*Today*, *Tue 20*, *30 Sep*). *On this device* goes (25 moves those workouts to On this phone).
- A record is said once:
  - as its *new best* moment, a door: **Bench Press · new best** / *101.3 kg est · up 6.3 kg since 9 Oct*, opening the Record with that workout's point ringed (05.7, task 21);
  - or, when the week's one-moment cap left it unstated, as a record dot after the workout's name (*Legs* •, `prInk`, TalkBack *new best*).
  - What counts as a new best follows the shared vectors (`packages/api-contract/gym/domain/training-reads.json`, `ProgressRecords`; ledger 9p), not every exact step.
- Moments are doors: outlined rows with a chevron, no sparkline, no expanding.
  - A weigh-in moment **Weighed in · 82.4 kg** / *0.6 kg down since September* opens Bodyweight.
  - The month moment *Trained every week of September* has no chevron and opens nothing.
  - Delete the in-place chart, *Open record ›*, and the expanded state.
- Replace `WeighInChip` with an M3 `ExtendedFloatingActionButton`: icon `monitor_weight`, label *Weigh in*, bottom end, 16 dp above the navigation bar. The list's bottom padding grows so the FAB never covers the foot. Delete `WeighInChip`.
- The *Saved workouts need review (N)* door is replaced by On this phone at the head and a badge on The log tab (25).
- Swipe a workout row end-to-start on `DeleteSwipeRow` (04), a11y label *Discard workout*.
  - Past the threshold, the dialog from 14: *Discard this workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / **Cancel** · **Discard** (error role).
  - Discard removes the workout at once, with no hold and no Undo. Cancel puts the row back.
- The long-press menu keeps both items: *Share this workout* / *Discard workout*. Discard opens the same dialog.
- Words: *No workouts yet* (body *Your training will land here.* unchanged), *First workout · {date}*, click label *Open workout*. `Readout.sessionCount` says *workouts* (21).
- The weigh-in defect: the head now shows the latest weigh-in. The timeline's one-moment-per-week rule stays as the boards draw it; change `logTimeline` only after a designer ruling.

**Out of scope:**
- The discard dialog itself (14); the shared swipe row (04).
- On this phone and its badge (25).
- The Bodyweight screen and the weigh-in sheet (24).
- The Record (21); workout detail (23).

**Done when**
- Screenshots of 05.1, 05.2 (mid-swipe and the dialog) and 05.12 match in Dark and Daylight; the rig (01) adds `05.1-log-dark/light`, `05.2-log-discard-swipe-dark/light`, `05.12-log-empty-dark/light`.
- Tapping each door lands where the board says: the Bodyweight card and a weigh-in moment fire `gym_screen_viewed` `bodyweight`; a new best fires `movement`; the month moment fires nothing.
- Discard and share emit nothing today. Add `gym_action` with `screen=log`:
  - `action=discard`, `state=shown` when the dialog opens, then `outcome=ok` / `cancelled` / `refused` / `failed`
  - `action=share`, `outcome=ok` / `refused` / `failed`.
- Failures still report as `gym.discard` and `gym.share`; a refused discard puts the row back and the note line says why.
- Tests: `ui/LogRowMenuTests.kt`, `ui/LogRowLayoutTests.kt`, `ui/LogStateTests.kt`, `ui/LogMomentTests.kt` (doors, no expansion), `LogTransientTests.kt` (no Undo snackbar), `domain/LogReadoutTests.kt` (facts line, record dot only when the cap hid the moment, *Trained every week of September*, *Trained 3 of the last 4 weeks*), and a test that the log's new bests are the domain module's `ProgressRecords` (`apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/TrainingReads.kt:176`, which passes the shared vectors in `CorpusTests.kt`) rather than `LogTimeline`'s own `newBests` (`domain/LogTimeline.kt:52`).

**Depends on:** 03, 04, 05, 14, 21.

**Ledger:** 9o, 9p, 9q, 9y, 9z, 11b, 12g; dogfood `android-gym-target-page`, `android-log-and-record-reads`.
