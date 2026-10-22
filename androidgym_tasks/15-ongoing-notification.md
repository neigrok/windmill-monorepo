# The ongoing notification and Live Update show the time since the last set

**Figma:**
- 04.2 Ongoing notification, since last set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46754) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46949)
- 04.3 Live Update chip, since last set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46826) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46963)
- 04.4 Lock screen: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46875) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46971)
- Component (Design System library, Android page): `Android / Ongoing notification` `337:2845`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `notification/WorkoutNotifications.kt:189-227` builds the notification:
  - title: the routine, or *Free session* (`domain/WorkoutNotification.kt:54`)
  - text *{movement} · {w} kg × {r} · {counter}*; the big text puts the counter on its own line
  - one action, *Log set* (unlock required on API 31+), or *Open workout* without an offer
  - `setShowWhen(false)` (:212) and no chronometer, so no time shows anywhere.
- The channel *Workout* (`gym_workout`, :277) is `IMPORTANCE_LOW` (:156). The lock screen hides it; with silent notifications shown it is an icon only.
- `setRequestPromotedOngoing(true)` (:209) asks for a Live Update on API 36+, but with no when-time the status-bar chip is the small icon only.
- The app already knows the time: `WorkoutClocks.latestSetAtMs` and *Since last set* / *Since start* (`domain/LiveSession.kt:221-226`) drive the logger's clock row.

**Change**
- Add the time since the last set as a chronometer:
  - `setWhen(lastSetAtMs)`, `setUsesChronometer(true)`, `setShowWhen(true)`.
  - Before the first set, use the workout start.
  - Carry the time in `WorkoutNotification` (the domain snapshot), so a test can read it without a device.
- Expanded (04.2): the title, *{movement} · {w} kg × {r}*, *set n of N*, and the one action **Log set** (unlock required, as today).
- Collapsed: the same facts on one line.
- The title is the routine name. A workout with no routine (one a connected agent started) reads `Readout.noRoutine` (13), not its own *Free session* (`domain/WorkoutNotification.kt:54`).
- Live Update chip (04.3): the promoted notification shows the same chronometer in the status-bar chip. API 35 and older have no chip; nothing else changes there.
- Lock screen (04.4):
  - Create a new channel id at `IMPORTANCE_DEFAULT`, kept silent: `setSilent(true)`, no sound, no vibration. An app cannot raise an existing channel's importance, so the id must change. Delete the old `gym_workout` channel after the new one exists.
  - The lock screen shows only the routine and the clock, never set content (owner ruling, ledger 11l): `setVisibility(NotificationCompat.VISIBILITY_PRIVATE)` with `setPublicVersion(...)`, a notification on the same channel with the routine as its title, the same chronometer, no text lines and no actions. The movement, *{w} kg × {r}*, *set n of N* and **Log set** show after unlock.
- Use `NotificationCompat` throughout; keep `setOnlyAlertOnce(true)` so the chronometer never re-alerts.

**Out of scope:**
- The Quick Settings tile (16).
- The logger's own clock row (09) and the workout bar above the tabs (45).
- Swiping the notification away: it turns the notification off and This workout offers **Show** (45).

**Done when**
- Screenshots of 04.2, 04.3 and 04.4 match in Dark and Daylight on an API 36+ emulator; the rig (01) adds `04.2-ongoing-notification-dark/light`, `04.3-live-update-chip-dark/light`, `04.4-lock-screen-dark/light`.
- Not checked yet, and must be checked on the emulator: that a promoted Live Update at `IMPORTANCE_DEFAULT` shows on the lock screen, and that the chip shows the chronometer. Say in the PR what you saw.
- `gym_set_logged` still fires once for a set logged from the notification (`store/TrainingStore.kt:218`).
- Notification actions emit nothing today. Add the content-free event `gym_action` with `screen=notification`, `action=log_set` or `open`, `outcome=ok` / `refused` (a stale or locked offer). List it in `docs/ANDROID_OBSERVABILITY.md`.
- Failures still report as `gym.notification.post`, `gym.notification.receive` and `gym.notification.capabilities`.
- Tests: `notification/WorkoutNotificationsTests.kt` (channel id and importance, when-time before and after the first set, *Free workout*, and a public version that holds the routine and the chronometer and no set content or action).

**Depends on:** 01.

**Ledger:** 11l, 12c, 9z; dogfood `android-gym-target-page`.
