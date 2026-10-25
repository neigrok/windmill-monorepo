# Record: Edit movement in the overflow, Earlier records, no set kinds, workouts

**Approved flow:** [Log](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) — ✅ Ready for dev, human-approved 2026-10-25. Record drilldown is preserved; additional equipment visuals remain gated by 08.

**Figma:**
- 05.6 Record, Edit movement in the overflow: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30001) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31197)
- 05.7 Record, a point inspected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31281)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953`
  - `Android / Menu` `342:2725`
  - `Android / Equipment icon` `337:2025`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RecordScreen.kt:72`: the bar's trailing action is the text *Rename*, shown once the record has loaded.
- The subhead is the equipment word, capitalised from the wire (`domain/Record.kt:34`): *Barbell*, *Dumbbell*, …
- *Recent sets* append the kind wire for a non-working set: *{w} × {r} warmup* (`domain/Record.kt:42`).
- The window line reads *Last 12 weeks · 6 sessions* (`ui/RecordScreen.kt:193`, `Readout.sessionCount` at `domain/Readout.kt:192`). Gap labels say *No session · a – b* (`ui/RecordScreen.kt:192`); TalkBack actions say *Earlier session* / *Later session* / *Session estimates* (`ui/DatedPlot.kt:138,145,218`).
- *Personal records* (`ui/RecordScreen.kt:133-142`, from `domain/Record.kt:35-38`) lists every record newest first, the standing best included and tinted.
- Tap to inspect already ships: *95 kg est · 9 Oct · 75 × 8* (`progressReading`, `domain/Progress.kt:140-143`).
- Defects seen on the emulator:
  - Two workouts on one day draw a vertical spike in the chart (`progressSeries`, `domain/Progress.kt:145-150`, one point per workout).
  - A free workout that stayed on the phone after a refused import still feeds the chart.

**Change**
- Bar: replace the text *Rename* with an M3 `IconButton` ⋮ (`Icons.Rounded.MoreVert`, *More*), whose `DropdownMenu` (04) holds one item, *Edit movement* with `Icons.Outlined.Edit`. It opens the sheet from 20.
- Subhead: use 08’s equipment-aware presentation. The approved icon examples cover Barbell, Dumbbells, Bodyweight and Machine; preserve Cable/Kettlebell labels and existing presentation until their new visual variants are approved. Never hide or rename a supported equipment value.
- *Personal records* becomes **Earlier records**: newest first, without the standing best, which is the *Best e1RM* tile. Rows as 05.6 draws them: *75 × 8 · e1RM 95* / *9 Oct*, *70 × 8 · e1RM 88.7* / *11 Aug*. The section shows only when an earlier record exists. What counts as a record follows the shared vectors (`ProgressRecords`, ledger 9p).
- *Recent sets* print *{w} × {r}* only (the suffix goes with 06).
- Every *session* on this screen says *workout*: *Last 12 weeks · 6 workouts*, *No workout · a – b*, *Earlier workout*, *Later workout*, *Workout estimates*. Change `Readout.sessionCount` itself, so the Log's moment (22) reads the same.
- 05.7: the Record opened from a *new best* moment on The log (22) rings that workout's point and shows its readout; otherwise no change.
- Fix the chart's reads:
  - One point per day: keep that day's best estimate. Put the rule in `progressSeries` with a test.
  - Leave out workouts that are refused imports still on the phone.

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
