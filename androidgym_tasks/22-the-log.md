# The log: every weigh-in in chronology, distinct rows and Weigh in FAB

**Approved flow:** [Log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 05.1 The log, Weigh in FAB: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39988)
- 05.2 The log, discard by swipe: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27527) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40892)
- 05.12 Empty log: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30325) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31496)
- Components (Design System library, Android page):
  - `Android / FAB` `337:2110` (Extended)
  - `Android / Swipe row` `337:2217`
  - `Android / Menu` `342:2725`
  - `Android / Top app bar` `342:2953`
- The approved Android flow governs the current chronology and visual separation; do not copy a Bodyweight header from an older layout.

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
- Build one newest-first timeline with every finished workout and every weigh-in as independent entries. Remove the top-level **Bodyweight** card/header. Keep existing training-consistency copy and the separate On this phone recovery entry (25) without turning weight into another root-level section.
- Weigh-ins are not weekly decorative moments: exclude them from the one-moment-per-week selector. No record/month-summary selection may suppress a weight. Preserve the existing one-per-local-day weight key; correcting a day updates that entry rather than inventing multiple same-day records.
- Preserve time provenance in the read model. Use a recorded timestamp for ordering/display only when it is valid and belongs to the selected local date. For example, today’s 12:45 weigh-in belongs between workouts at 19:10 and 07:15. Missing `recordedAt` must remain unknown; fix the engine adapter’s `0` fallback rather than rendering the epoch or fabricated midnight. Legacy/backdated date-only weights stay under their selected day, without a clock label; use a documented stable date-only tie order, not an invented instant. Test local-day/time-zone boundaries and deterministic ties.
- Use the approved visual separation: filled workout cards, separated lighter weight rows with the weight icon, and slim gold record markers. Group by the drawn dated sections without a duplicate date below the heading. Distinguish actions through shape/icon/layout as well as color.
- Workout cards open workout detail; show the routine (or `Readout.noRoutine`), all-set facts and valid time as drawn. *On this device* leaves these rows (25). End-to-start swipe and the long-press **Discard workout** action open 14’s single confirmation; Cancel restores the row and confirmed discard is immediate. Long-press Share retains its current link action.
- Weight rows open the existing Bodyweight chart (24), retaining correction access. End-to-start delete uses 05/24’s nine-second held Undo; it is not the workout confirmation contract.
- Gold *new best* markers open Record with the appropriate workout point (21) and never swipe or delete. Resolve new bests from shared `ProgressRecords` vectors. A record is stated once: selected marker, or the workout’s gold dot/accessibility state when decorative selection omits the marker. The decorative weekly cap may remain for record/month moments only, never weigh-ins.
- Delete expanding inline moment charts; the chart/detail destinations remain available through their rows. The noninteractive month summary has no chevron. Reuse 08’s supported-equipment rules in any load text.
- Replace `WeighInChip` with the approved 56 dp M3 `ExtendedFloatingActionButton`, icon `monitor_weight`, label **Weigh in**, bottom end with list clearance. No additional backing panel/pad beneath it; use the stable native navigation bar.
- Use *workout* wording: *No workouts yet*, *First workout · {date}*, *Open workout*. With weights but no workouts, show the weights rather than an empty-log screen. A truly empty log retains Weigh in and the existing empty message.

**Out of scope:**
- The discard dialog itself (14); the shared swipe row (04).
- On this phone and its badge (25).
- The Bodyweight screen and the weigh-in sheet (24).
- The Record (21); workout detail (23).

**Done when**
- Capture canonical Log, weight swipe/Undo, workout swipe/confirmation, record marker and empty states in Dark and Daylight. Check long names, large text, small phones and the last row above the FAB; no Bodyweight header or FAB backing pad remains.
- Unit/read-model tests include workout 07:15 → weigh-in 12:45 → workout 19:10, several weigh-ins in one week, weights plus record/month moments, legacy absent timestamps, a backdated date whose recorded timestamp belongs to another day, future/invalid timestamps, time-zone boundaries and stable ties. Every eligible weight appears once; no invented time is displayed.
- Row tests prove workout → detail, weight → Bodyweight, record → Record and no swipe/delete semantics on a record. Verify workout discard cancellation/refusal, weight Undo/expiry/rewrite races, recreation and the weight-only empty-workout case.
- Keep `gym_screen_viewed` for destinations. Add bounded `gym_action` open/share/discard outcomes; weight held-delete/Undo events follow 24. A hidden held row is not a successful delete. Record no date, weight, routine/movement name, ID or user text. Document labels in `docs/ANDROID_OBSERVABILITY.md`.
- Unexpected read/share/discard/delete failures retain the appropriate static boundary operations (`gym.loadLog`, `gym.share`, `gym.discard`, `gym.deleteWeighIn`); refusals restore/explain the relevant row without a Sentry Issue.
- Update `LogRowMenu`, `LogRowLayout`, `LogState`, `LogMoment`, `LogTransient`, `LogReadout` and timeline tests. Preserve shared `ProgressRecords` parity; the UI must not invent its own best-record rule.

**Depends on:** 03, 04, 05, 14, 21.

**Ledger:** 9o, 9p, 9q, 9y, 9z, 11b, 12g; dogfood `android-gym-target-page`, `android-log-and-record-reads`.
