# Quick Settings tile for the workout

**Figma:**
- 04.1 Quick Settings tile: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46694) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46936)
- Component (Design System library, Android page): `Android / Quick Settings tile` `337:2785`

**Implementation**
- `notification/WorkoutTileService.kt` declares a native `TileService` with `BIND_QUICK_SETTINGS_TILE` and the `ACTION_QS_TILE` intent filter. It uses the approved exercise glyph, `gym_workout_notification`, shared with the notification and Live Update.
- The label is *Workout*. An inactive tile reads *Off* and opens Routines without starting a workout. App workouts start from a saved routine; externally started workouts may have no routine.
- An active tile reads *{routine} · {time since last set}*, for example *Push A · 2:14*, from the same `WorkoutNotification` snapshot as task 15. Before the first set, the clock starts at workout start.
- The standard visible-listening lifecycle observes snapshot changes and advances the subtitle each second while Quick Settings is open. Closing the shade cancels that clock. Reopening or recreating the service restores the current snapshot. The service does not declare `ACTIVE_TILE` or run a persistent background ticker: `requestListeningState` applies only to active-mode tiles, whose lifecycle does not bind on each shade opening.
- A tap uses an explicit activity route, with `startActivityAndCollapse(PendingIntent)` on API 34+. The active route rechecks the account and workout before opening it. The inactive route works signed out, consumes its navigation request once, and clears read-only pushed screens while preserving open routine, note and set-edit drafts.

**Out of scope:**
- The notification and the Live Update chip (15).
- Removing the free workout (13).

**Done when**
- The stock system tile is verified against 04.1 in Dark and Daylight with the shade expanded; the rig (01) adds `04.1-quick-settings-tile-dark/light` (inactive and active).
- A tap on the inactive tile opens Routines (`gym_screen_viewed` `routines`) and starts nothing: no `gym_session_started`.
- The tile emits the content-free event `gym_action` with `screen=tile`, `action=routines` or `open`, `outcome=ok` / `failed`. List it in `docs/ANDROID_OBSERVABILITY.md`.
- A tile failure (the activity cannot open) reports to Sentry under the new operation `gym.tile`; no routine name in the report.
- Tests: a new `notification/WorkoutTileServiceTests.kt` (Robolectric): label, state and subtitle for no workout and for a running one.

**Depends on:** 15.

**Ledger:** 11l, 12b; dogfood `android-gym-target-page`.

**Verified**
- API 37 captures contain inactive and active 04.1 tiles in Dark and Daylight, using the system's palette, size and geometry with the approved exercise glyph. The shared snapshot supplies the visible subtitle.
- Native checks cover the clock before the first set, its reset after a set, process/service recreation, Finish returning to Off, and a signed-out cold launch into empty Routines. Inactive taps start no workout.
- Canonical recipe taps produce exactly two `routines:ok` and four `open:ok` intake events. Supplemental checks add two successful routes of each kind. One intentionally unavailable activity produces one `routines:failed`, one bounded `client_error` and one content-free Sentry `gym.tile` report. Three explicit app starts produce three set events and three finishes; backend readback confirms those workouts.
- The final focused gate covers 39 gym checks per variant and 47 app checks per variant. All 13 tile-service checks pass again in Debug and Release with final target resolution. After task 04 integration, the 16 tile/navigation checks pass and both app variants compile. The combined tools suite passes all 36 checks.
- Evidence: `/private/tmp/windmill-android-task16/final3`, `final-focused-xml.tar.gz`, `final-service.log`, `merged-check.log` and `tools-merged.log`. The native APK SHA-256 is `2fe9b0d47071482a3ffca68fb04ab49fe62d682738c23cddda4af96dbfb099dd`. No new performance claim is made.
