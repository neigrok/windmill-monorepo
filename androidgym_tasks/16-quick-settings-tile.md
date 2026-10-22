# Quick Settings tile for the workout

**Figma:**
- 04.1 Quick Settings tile: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46694) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46936)
- Component (Gym Components page, section `🧩 Android · Material 3`): `Android / Quick Settings tile` `1247:3007`

**Today**
- There is no tile. No `TileService`, Glance widget or app widget exists in `apps/android`.
- The manifest (`apps/android/app/src/main/AndroidManifest.xml:35-36`) declares only `WorkoutNotificationReceiver` besides the activity.
- A free workout starts from *Start logging* on Routines; a running workout is reached through the app or the ongoing notification (15).

**Change**
- Add `notification/WorkoutTileService.kt`, a `TileService`, declared in the manifest with `BIND_QUICK_SETTINGS_TILE` and the `ACTION_QS_TILE` intent filter, icon `gym_nav_log`.
- Label *Workout*.
- Inactive (`Tile.STATE_INACTIVE`), no workout open: subtitle *Off*. A tap opens the app on Routines. The tile never starts a workout: every workout starts from a routine (13).
- Active (`Tile.STATE_ACTIVE`): subtitle *{routine} · {time since last set}*, for example *Push A · 2:14*. A tap opens the running workout.
  - The subtitle reads the same `WorkoutNotification` snapshot as the notification (15), so the two never disagree.
  - Refresh the tile with `TileService.requestListeningState` when a workout starts, a set lands, or the workout ends.
- Opening the app from the tile uses `startActivityAndCollapse` with a `PendingIntent` on API 34+ (the `Intent` form throws there).
- Signed out works the same.

**Out of scope:**
- The notification and the Live Update chip (15).
- Removing the free workout (13).

**Done when**
- Screenshots of 04.1 match in Dark and Daylight with the shade expanded; the rig (01) adds `04.1-quick-settings-tile-dark/light` (inactive and active).
- A tap on the inactive tile opens Routines (`gym_screen_viewed` `routines`) and starts nothing: no `gym_session_started`.
- The tile emits the content-free event `gym_action` with `screen=tile`, `action=routines` or `open`, `outcome=ok` / `failed`. List it in `docs/ANDROID_OBSERVABILITY.md`.
- A tile failure (the activity cannot open) reports to Sentry under the new operation `gym.tile`; no routine name in the report.
- Tests: a new `notification/WorkoutTileServiceTests.kt` (Robolectric): label, state and subtitle for no workout and for a running one.

**Depends on:** 15.

**Ledger:** 11l, 12b; dogfood `android-gym-target-page`.
