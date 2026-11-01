# The ongoing notification and Live Update show the time since the last set

**Figma:**
- 04.2 Ongoing notification, since last set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46754) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46949)
- 04.3 Live Update chip, since last set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46826) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46963)
- 04.4 Lock screen: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46875) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46971)
- Component (Design System library, Android page): `Android / Ongoing notification` `337:2845`

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `presentation/WorkoutNotification.kt` carries the latest visible set time across the whole workout,
  falling back to its start before the first set. The selected movement still owns the set counter.
  Fixing or deleting the newest set updates the clock; restore and reconnect retain its timestamp.
- `notification/WorkoutNotifications.kt` uses the snapshot for the native chronometer in the
  private card, promoted Live Update and public lock-screen card. The title is the routine, or
  `Readout.noRoutine` (*Free workout*) for an externally started workout without a routine.
- The private card contains movement, weight, reps, counter and one action: **Log set** when an
  offer exists, otherwise **Open workout**. Logging requires unlock. The public card contains only
  the title and clock: no set text, action or content intent.
- The silent `gym_workout_clock` channel uses `IMPORTANCE_DEFAULT`. Migration preserves an
  explicitly blocked legacy channel as blocked and leaves existing new-channel preferences
  authoritative. The old channel is removed only after the new channel exists.
- The builder requests the approved monochrome exercise icon and the shared GymSkin accent.
  Android controls stock notification presentation. On the verified API 37 image the card uses
  the launcher icon and system tint; the promoted status-bar chip uses the exercise icon and clock.
  These captures verify native behavior, not pixel parity with the illustrative card. Ledger 11l
  records the Figma reconciliation. API 35 and older retain the ongoing notification without a chip.
- Native actions share one handler and emit one `gym_action` per delivered user action, with
  `screen=notification`, `action=log_set` or `open`, and `outcome=ok` or `refused`. Notification
  refreshes emit no action event. Accepted sets retain their single `gym_set_logged` event.
- Failure boundaries remain `gym.notification.post`, `gym.notification.receive` and
  `gym.notification.capabilities`; event properties contain no workout or set content.

**Out of scope:**
- The Quick Settings tile (16).
- The logger's own clock row (09) and the workout bar above the tabs (45).
- Swiping the notification away: it turns the notification off and This workout offers **Show** (45).

**Verification**
- Debug and Release each pass 34 focused domain, runtime and notification tests with no skips,
  failures or errors. Both app variants compile. The cases cover the initial clock, other-movement
  sets, fix/delete, restore/reconnect, channel migration, public privacy and once-only action events.
- Installed API 37 acceptance verifies the promoted clock, full private card and secure public
  lock-screen card in Dark and Daylight with Android private-notification hiding enabled. Public
  rendering follows the user’s lock-screen settings; other privacy settings were not exhaustively
  tested. Actual upgrades verify both enabled legacy LOW → silent
  DEFAULT and blocked legacy NONE → blocked new channel, then a user's explicit re-enable.
- Backend readback retains both logged sets; intake has exactly one successful notification
  `log_set` action, one successful `open` action and two `gym_set_logged` events. One transient
  `hello` transport result is `unreachable`; its cause is unproven. Subsequent sync and readback
  succeed. This is a bounded transport metric, not a domain refusal or a Sentry Issue.
- All six canonical Dark/Daylight card, chip and lock-screen captures complete on API 37 with
  raw XML and notification dumps; the runtime scan contains no ANR or fatal exception.
- The capture recipes live at `apps/android/tools/capture-recipes/notification-clock.json`.
  Evidence, APK identity and capture-tool limits are recorded in the
  [Android implementation log](../docs/engineering/android-implementation.md).

**Depends on:** 01.

**Ledger:** 11l, 12c, 9z; dogfood `android-gym-target-page`.
