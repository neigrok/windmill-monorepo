# Record: Edit exercise in the overflow, no set kinds, workouts

**Figma:**
- 05.6 Record, Edit exercise in the overflow: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30001) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31197)
- 05.7 Record, a point inspected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31281)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Top app bar` `1260:2948`
  - `Android / Menu` `1260:2608`
  - `Android / Equipment icon` `1247:2247`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RecordScreen.kt:72`: the bar's trailing action is the text *Rename*, shown once the record has loaded.
- The subhead is the equipment word, capitalised from the wire (`domain/Record.kt:34`): *Barbell*, *Dumbbell*, …
- *Recent sets* append the kind wire for a non-working set: *{w} × {r} warmup* (`domain/Record.kt:42`).
- The window line reads *Last 12 weeks · 6 sessions* (`ui/RecordScreen.kt:193`, `Readout.sessionCount` at `domain/Readout.kt:192`). Gap labels say *No session · a – b* (`ui/RecordScreen.kt:192`); TalkBack actions say *Earlier session* / *Later session* / *Session estimates* (`ui/DatedPlot.kt:138,145,218`).
- Tap to inspect already ships: *95 kg est · 9 Oct · 75 × 8* (`progressReading`, `domain/Progress.kt:140-143`).
- Defects seen on the emulator:
  - Two workouts on one day draw a vertical spike in the chart (`progressSeries`, `domain/Progress.kt:145-150`, one point per workout).
  - A free workout that stayed on the phone after a refused import still feeds the chart.

**Change**
- Bar: replace the text *Rename* with an M3 `IconButton` ⋮ (`Icons.Rounded.MoreVert`, *More*), whose `DropdownMenu` (04) holds one item, *Edit exercise* with `Icons.Outlined.Edit`. It opens the sheet from 20.
- Subhead: the equipment icon (08) before the display word (*Barbell*, *Dumbbells*, *Bodyweight*, *Machine*).
- *Recent sets* print *{w} × {r}* only (the suffix goes with 06).
- Every *session* on this screen says *workout*: *Last 12 weeks · 6 workouts*, *No workout · a – b*, *Earlier workout*, *Later workout*, *Workout estimates*. Change `Readout.sessionCount` itself, so the Log's moment (22) reads the same.
- 05.7: no other change; the ringed point and readout stay.
- Fix the chart's reads:
  - One point per day: keep that day's best estimate. Put the rule in `progressSeries` with a test.
  - Leave out workouts that are refused imports still on the phone.

**Out of scope:**
- The Edit exercise sheet (20).
- Removing set kinds from the domain (06).
- The Log's own copy (22).

**Done when**
- Screenshots of 05.6 (menu open) and 05.7 match in Dark and Daylight; the rig (01) adds `05.6-record-overflow-dark/light` and `05.7-record-inspected-dark/light`.
- `gym_screen_viewed` `movement` still fires.
- Failures still report as `gym.loadProgress`.
- Tests: `ui/RecordStateTests.kt`, `domain/RecordTests.kt`, `domain/ProgressTests.kt` (one point per day, refused import left out), `ui/DatedPlotTests.kt` (the new TalkBack labels), `domain/ReadoutTests.kt`.

**Depends on:** 04, 06, 08, 20.

**Ledger:** 11e; dogfood `android-gym-target-page`, `android-log-and-record-reads`.
