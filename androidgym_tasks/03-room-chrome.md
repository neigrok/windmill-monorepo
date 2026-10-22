# Room chrome: one top app bar, the account seat on every root, the navigation bar

**Figma:**
- 00.1 Top app bar and navigation bar anatomy: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46397)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Top app bar` `1260:2948`
  - `Android / Button` `656:6699` (the bar's text actions)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `GymScreen` (`ui/GymScreen.kt:87-143`) draws two bars:
  - a custom `Row`, title body 24 Bold, back `ArrowBack` with *Back to {beneath}* (:126-127);
  - a Material `TopAppBar` only when `sessionBar = true` (:104-115), for the logger.
- `TopAction` (:177-190) is an accent text button, body 13 Bold. Uses: *New routine* (`ui/RoutinesScreen.kt:102`), *Save* / *Saving…* (`ui/RoutineBuilder.kt:369`), *Finish* (`ui/LoggerScreen.kt:327`), *Rename* (`ui/RecordScreen.kt:72`), *History* (`coach/AskScreen.kt:139`), *Add movement* (`ui/LoggerScreen.kt:715`).
- `YouSeat` (`ui/GymScreen.kt:202-215`) is a 36 dp `raised` circle with the email initial, or *•* signed out; label *Your account*, click label *open your account*.
  - It is passed to the signed-in Coach root but not drawn there (`GymRoom.kt:1179`).
- Tabs are *Routines*, *Log*, *Coach* (`GymRoom.kt:151-155`), drawn by `TabRail` (`GymRoom.kt:1205`), a Material `NavigationBar`, shown only on the roots (`railStands`, :190).

**Change**
- One bar for the room, built on M3 `TopAppBar` in `GymScreen`, in three forms (00.1):
  - Root: title (24 Bold) and the 48 dp account seat at the end. Signed in: the initial; signed out: *•*.
  - Pushed: back arrow and title, with at most one text action at the end (e.g. **Save**, muted until the draft changes).
  - Workout: **Finish** at the start, the routine name, the Gym settings gear at the end.
- The seat is on every root: Routines, Log and Coach (draw it on the signed-in Coach root).
- Routines root carries no *New routine* action. The FAB replaces it (17).
- Navigation bar: *Routines* · *Log* · *Coach*, roots only, as today. Check icon, indicator and label colours against 00.1 in both modes.
- Delete the custom `Row` bar and the `sessionBar` switch once every screen uses the one bar.

**Out of scope:** the Routines FAB (17); Coach's History icon and More menu (28); colour values (02).

**Done when**
- Screenshots of 00.1 match in Dark and Daylight; the rig (01) adds `00.1-bars-dark` / `00.1-bars-light` (Routines, Log and Coach roots, a pushed screen, the workout bar).
- `gym_screen_viewed` still fires on every destination change.
- `ui/GymScreenTests.kt`, `GymRailTests.kt`, `GymTabsTests.kt` and `ui/AccountRouteTests.kt` pass, with a test that the Coach root shows the seat.

**Depends on:** 02.

**Ledger:** 11a; dogfood `android-gym-target-page`.
