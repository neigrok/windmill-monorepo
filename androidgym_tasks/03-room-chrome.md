# Room chrome: one top app bar, the account seat on every root, the navigation bar

**Figma:**
- 00.1 Top app bar and navigation bar anatomy: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46397)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953` (Type=Workout `342:2941`: Finish, the routine, ⌄ Hide)
  - `Android / Navigation bar` `348:2762` (*Routines* · *The log* · *Coach*)
  - `Android / Button` `210:181` (the bar's text actions)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `GymScreen` (`ui/GymScreen.kt:87-143`) draws two bars:
  - a custom `Row`, title body 24 Bold, back `ArrowBack` with *Back to {beneath}* (:126-127);
  - a Material `TopAppBar` only when `sessionBar = true` (:104-115), for the logger.
- `TopAction` (:177-190) is an accent text button, body 13 Bold. Uses: *New routine* (`ui/RoutinesScreen.kt:102`), *Save* / *Saving…* (`ui/RoutineBuilder.kt:369`), *Finish* (`ui/LoggerScreen.kt:327`), *Rename* (`ui/RecordScreen.kt:72`), *History* (`coach/AskScreen.kt:139`), *Add movement* (`ui/LoggerScreen.kt:715`).
- The logger's bar ends with a gear, *Gym settings* (`ui/LoggerScreen.kt:328-331`), which pushes Gym settings over the workout.
- `YouSeat` (`ui/GymScreen.kt:202-215`) is a 36 dp `raised` circle with the email initial, or *•* signed out; label *Your account*, click label *open your account*.
  - It is passed to the signed-in Coach root but not drawn there (`GymRoom.kt:1179`).
- Tabs are *Routines*, *Log*, *Coach* (`GymRoom.kt:151-155`); the Log tab's root title is the tab title, *Log* (`GymRoom.kt:947`). `TabRail` (`GymRoom.kt:1205`) is a Material `NavigationBar`, shown only on the roots (`railStands`, :190).

**Change**
- One bar for the room, built on M3 `TopAppBar` in `GymScreen`, in three forms (00.1):
  - Root: title (24 Bold) and the 48 dp account seat at the end. Signed in: the initial; signed out: *•*.
  - Pushed: back arrow and title, with at most one text action at the end (e.g. **Save**, muted until the draft changes).
  - Workout: **Finish** at the start and the routine name. Delete the gear; the end slot is left for **Hide** (⌄), which 45 adds with its behaviour.
- The seat is on every root: Routines, The log and Coach (draw it on the signed-in Coach root).
- Routines root carries no *New routine* action. The FAB replaces it (17).
- Navigation bar: *Routines* · *The log* · *Coach*, roots only, as today. The middle tab's label and its root title are *The log* (`Tab.Log`'s title). Check icon, indicator and label colours against 00.1 in both modes.
- Delete the custom `Row` bar and the `sessionBar` switch once every screen uses the one bar.

**Out of scope:** the Routines FAB (17); Coach's History icon and the removal of Coach's ⋮ More (28); colour values (02); Hide's behaviour and the workout bar above the tabs (45); Gym settings itself (46).

**Done when**
- Screenshots of 00.1 match in Dark and Daylight, apart from the logger bar's Hide (45); the rig (01) adds `00.1-bars-dark` / `00.1-bars-light` (Routines, The log and Coach roots, a pushed screen, the logger's bar).
- `gym_screen_viewed` still fires on every destination change.
- `ui/GymScreenTests.kt`, `GymRailTests.kt`, `GymTabsTests.kt` and `ui/AccountRouteTests.kt` pass, with a test that the Coach root shows the seat, that the tab reads *The log*, and that the logger's bar has no *Gym settings* action.

**Depends on:** 02.

**Ledger:** 11a, 9z, 9r; dogfood `android-gym-target-page`.
