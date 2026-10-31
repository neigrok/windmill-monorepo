# Remove Gym settings and the lb toggle; You holds Notes, Connected log and About Windmill (Shell file)

**Figma:**
- Shell · Android 16a You, signed out: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1569) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-719)
- Shell · Android 16b You, signed in: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4408) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-877)
- No Gym board draws a Gym settings page, a Units control or lb anywhere.

**Implementation**
- You presents Notes, Connected log and About Windmill directly, with the approved typography, spacing and imported chevron. The sign-in form remains unchanged. Task 47 owns the sign-out question; task 48 owns the Delete account row.
- The Gym settings screen, route and units control are removed. Restoration drops only the known retired Settings route and keeps other valid entries; malformed or unknown navigation retains its technical failure report.
- The Android preferences view contains only confirmation feedback. Shared domain preferences retain units. Android reads confirmation feedback only; the obsolete settings-write wrappers are removed.
- Focused JVM validation passed 7 platform and 56 gym cases; the 12 affected gym cases passed again after removing unused preference writers. Source review and native Dark/Daylight acceptance remain pending. No production claim is made.

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
