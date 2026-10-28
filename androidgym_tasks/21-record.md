# Record: Edit movement in the overflow, Earlier records, no set kinds, workouts

**Approved flow:** [Log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) — ✅ Ready for dev, human-approved 2026-10-25. The four linked Record frames are 🔨 In dev. Equipment presentation reuses shipped tasks 08/20; no new glyphs are introduced.

**Figma:**
- 05.6 Record, Edit movement in the overflow: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30001) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31197)
- 05.7 Record, a point inspected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31281)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953`
  - `Android / Menu` `342:2725`
  - `Android / Equipment icon` `337:2025`

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RecordScreen.kt` uses the native More icon and shared menu with one *Edit movement* item.
  It opens task 20's approved editor, retaining its draft, account guard and dismissal behavior.
- `domain/Record.kt` names Dumbbells in the plural. The header reuses the existing equipment glyphs;
  Cable/Kettlebell labels remain, and Other is text-only. Recent sets contain no set-kind suffix.
- **Earlier records** lists only superseded bests, newest first. The shared `ProgressRecords` read
  supplies their identities: the first estimate is a baseline, and a new best must beat the previous
  best as both are stated to 0.1 kg. The standing best remains in its tile; an empty earlier list has
  no heading.
- Record and its chart accessibility say *workout*. The shared `Readout.sessionCount` also supplies
  the Log moment's count; no other Log composition changes belong to this task.
- `progressSeries` keeps one strongest estimate per local day, with earliest time then ID resolving
  exact ties. The default readout resolves the last plotted point, including a later weaker workout
  on that same day. Daily aggregation leaves every factual workout and Log moment intact.
- A new-best moment passes its exact workout identity into Record. A retained point is selected;
  an older retained point opens the All window. A workout collapsed by the daily-best rule creates
  no initial chart selection and never substitutes another point for the requested workout.
- `store/EngineTraining.kt` excludes refused imports from progress while retaining their factual
  detail and retry path. Chart inspection is a read and emits no values or workout identifiers.

**Verification state**
- Focused Debug: 48 cases pass, including shared-record projection, daily ties/timezone, later-weaker
  default readout, exact/collapsed focus, edit-menu navigation and refused-import persistence.
- Full gym Debug passes 1261 cases with 17 opt-in LiveWire skips. The final ring-clipping correction
  passes all 11 focused chart/Record UI cases in both Debug and Release. The edge-paint regression
  fails with the old clip allowance and passes with the scoped Inspect margin. Capture tools pass
  22 cases.
- `record-fixture.json` seeds six factual workouts through the existing MCP import door. The final
  `record.json` native run captures 05.6 unselected and 05.7 selected in both appearances, with a
  complete ring at the last point. Four bounded movement-view events reach first-party intake;
  all 18 sets and six finished workouts remain, and menu/editor cancellation writes no edit.
- Native cold readiness is 1631 ms with no ANR/fatal error. This is a local sample, not a controlled
  performance comparison. The optional interior scrub was not reached after the rig entered its
  final live workout; deterministic scrub/identity coverage supplies that check.

**Out of scope:**
- The Edit movement sheet (20).
- Removing remaining app-layer set-kind controls/filters (06); the shared sync migration is already shipped.
- The Log's own copy (22).

**Done when**
- Screenshots of 05.6 (menu open) and 05.7 match in Dark and Daylight; the rig (01) adds `05.6-record-overflow-dark/light` and `05.7-record-inspected-dark/light`.
- `gym_screen_viewed` `movement` still fires.
- Failures still report as `gym.loadProgress`.
- Tests: `ui/RecordStateTests.kt`, `domain/RecordTests.kt` (Earlier records without the best), `domain/ProgressTests.kt` (one point per day, refused import left out), `ui/DatedPlotTests.kt` (the new TalkBack labels), `domain/ReadoutTests.kt`.

**Depends on:** 04, 06, 08, 20.

**Ledger:** 11e, 9p, 9z; dogfood `android-gym-target-page`, `android-log-and-record-reads`.
