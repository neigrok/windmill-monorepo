# Remove Gym settings and the lb toggle; You holds Notes, Connected log and About Windmill (Shell file)

**Figma:**
- Shell · Android 16a You, signed out: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1569) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-719)
- Shell · Android 16b You, signed in: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4408) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-877)
- Gym board 09.5 Gym settings is deleted; no board draws a Gym settings page, a Units control or lb anywhere.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/` = `apps/android/platform/src/main/kotlin/works/windmill/platform/` or `app/`)
- Gym settings (`ui/SettingsScreen.kt:81-129`): *Units* with kg / lb (`UnitsRow`, :131-162; under lb the caption `Bodyweight.kilogramsOnly`), *Workout hidden* / *Show workout* (:113-119, 45), *Notes* / *what you write for Coach* and *Connected log* rows (:122-123), *Account* / the email or *Not signed in* (:125), and the saved-workout cards (`DeviceTrainingRow`, :126, 25).
- It is reached from You's *Gym settings* row (`GymRoom.kt:438-441`, `Away.Settings` at :410, :942, :1032) and from the logger's gear (03 deletes it) and the review door (25 deletes it).
- lb draws nothing: every screen prints kg. The choice is stored in the shared preferences record (`domain/Preferences.kt:13-30`, written through `store/EngineTraining.kt:392-395`).
- You (`platform/you/YouSheet.kt:83-121`): *You*, the email, *One account across Windmill.* (:86), the room's rows (today *Gym settings*, *Connected log*) plus *About Windmill* (`app/MainActivity.kt:238`), then *Sign in* / *Sign out* in ink.

**Change**
- You (16a, signed out): *You*, then the rows **Notes**, **Connected log**, **About Windmill**, and **Sign in** in ink at the foot.
- You (16b, signed in): *You*, the email (*lifter@example.com*), then **Notes**, **Connected log**, **About Windmill**, then **Delete account** in the error role (48 builds it), and **Sign out** at the foot (47 adds its question).
- Delete *One account across Windmill.*
- The gym room presents **Notes** (`Away.Notes`) and **Connected log** (`Away.Connections`) as its You rows; drop *Gym settings*.
- Delete `ui/SettingsScreen.kt` and `Away.Settings` once 25 has moved the saved workouts and 45 the notification's Show. Delete `UnitsRow`, `Bodyweight.kilogramsOnly` and the units write. The preferences record keeps its `units` field on the wire: it is shared with the other surfaces and the server, and Android no longer reads or writes it.
- Every way in that led to Gym settings now leads to its row's own screen: Notes, Connected log, or the account seat.

**Out of scope:** the sign-out question (47); Delete account's pages (48); On this phone (25); the workout's Hide and the notification's Show (45); the sign-in fields (27).

**Done when**
- Screenshots of 16a and 16b match in Dark and Daylight (16b without the Delete account row until 48 lands); the rig (01) adds `16a-you-signed-out-dark/light`, `16b-you-signed-in-dark/light`.
- `gym_screen_viewed` `settings` no longer fires anywhere; `notes`, `connections` and the shell's You events fire from the You rows. Remove `settings` and the units events from `docs/ANDROID_OBSERVABILITY.md` where they are listed.
- No string *Gym settings*, *Units* or *lb* remains in the gym or platform UI (a test walks You signed in and out).
- Tests: `platform/src/test/kotlin/works/windmill/platform/you/YouSheetTests.kt` (rows in order, no one-account line), `ui/AccountRouteTests.kt`, `domain/PreferencesTests.kt`; `ui/SettingsScreenTests.kt` goes with the screen.

**Depends on:** 03, 25, 45.

**Ledger:** 9r; dogfood `android-gym-target-page`.
