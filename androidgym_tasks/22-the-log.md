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

**Current source** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `domain/LogTimeline.kt` keeps every eligible date-keyed weight independently of the decorative weekly selector. Valid same-day timestamps interleave with workouts; unknown, invalid, future-clock and backdated timestamps remain date-only facts.
- Date-only weights follow timed entries on their selected local day. Exact instant ties put workouts before record markers before weights, then sort by stable identity. Paging only bounds decorative moments.
- `domain/LogReadout.kt` uses `StatsProgress.newBests`, projected from shared `ProgressRecords`, for both markers and omitted-marker gold dots. Cards show all-set counts, duration and valid clock time without repeating a date or record sentence.
- `ui/LogScreen.kt` uses dated sections, filled workout cards, separated weight rows and direct record markers. Month summaries are noninteractive; inline expanded charts are removed.
- Workout swipe and long-press **Discard workout** request task 14's single room confirmation. Weight swipe enters the existing durable nine-foreground-second Undo path. The existing Share action reports its settled outcome.
- The 56 dp Material 3 Extended FAB sits at bottom end with 88 dp list clearance. Empty copy says **No workouts yet**; a weight-only Log displays its facts. The separate recovery entry remains room-owned for task 25.
- The presentation model and engine adapter preserve an absent `recordedAt` as null; the correction state's saver retains null across recreation.
- Read-model, row, sharing, navigation and restoration checks pass. Share coverage includes clipboard failure, mint refusal, retry and delayed A→B/A→B→A replies without capability publication. The composed capture-tool suite passes 31 cases.
- Installed Dark/Daylight acceptance covers chronology, distinct rows, direct Record, empty Log, confirmation and weight Undo. The 320×640 dp, double-text Log keeps its full long title and valid time readable, and the last row clears the FAB. Confirmed removal reaches the server; bounded first-party events arrive. Native evidence is combined across attributed runs, with fixture/observer qualifications retained in the review packet. No production status is claimed.

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
