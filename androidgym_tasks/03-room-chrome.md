# Room chrome: one top app bar, the account seat on every root, the navigation bar

**Figma:**
- 00.1 Top app bar and navigation bar anatomy: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38215) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46397)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953` (Type=Workout `342:2941`: Finish, the routine, ⌄ Hide)
  - `Android / Navigation bar` `348:2762` (*Routines* · *The log* · *Coach*)
  - `Android / Button` `210:181` (the bar's text actions)

**Implementation and acceptance**
- `GymScreen` uses one native M3 `TopAppBar` for root, pushed and workout screens. The root account target is 48 dp with a 36 dp circle; signed-in Coach keeps its existing History and More controls alongside the seat.
- The visible middle tab and root title are *The log*. Its existing telemetry label remains `log`.
- The logger has no settings action. Its trailing 48 dp slot is reserved for task 45's Hide control.
- All 35 focused chrome/account/navigation checks and 62 related screen checks pass in Debug, with zero skips. With task 17's FAB, all 11 onboarding cases and tile/draft/recreation checks pass in the combined full Debug gate. Twelve installed API 37 chrome captures cover six roles in Dark and Daylight; root account navigation, event intake and runtime checks pass. This task ships with task 17 so routine creation remains available in the released app.

**Change**
- One bar for the room, built on M3 `TopAppBar` in `GymScreen`, in three forms (00.1):
  - Root: title (Nunito Bold 22 sp / 28 sp) and the 48 dp account seat at the end. Signed in: the initial; signed out: *•*. The initial is Nunito Bold 16 sp / 20 sp.
  - Pushed: back arrow and title, with at most one text action at the end (e.g. **Save**, muted until the draft changes). Text actions use Nunito Bold 14 sp / 20 sp with 0.1 sp tracking and a 48 dp minimum target.
  - Workout: **Finish** at the start and the routine name. Delete the gear; the end slot is left for **Hide** (⌄), which 45 adds with its behaviour.
- The seat is on every root: Routines, The log and Coach (draw it on the signed-in Coach root).
- Routines root carries no *New routine* action. The FAB replaces it (17).
- Navigation bar: *Routines* · *The log* · *Coach*, roots only, as today. The middle tab's label and its root title are *The log* (`Tab.Log`'s title). Labels use Nunito Bold 12 sp / 16 sp with 0.5 sp tracking. Check icon, indicator and label colours against 00.1 in both modes.
- Delete the custom `Row` bar and the `sessionBar` switch once every screen uses the one bar.

**Out of scope:** the Routines FAB (17); Coach's History icon and the removal of Coach's ⋮ More (28); colour values (02); Hide's behaviour and the workout bar above the tabs (45); Gym settings itself (46).

**Done when**
- Screenshots of 00.1 match in Dark and Daylight, apart from the logger bar's Hide (45); `tools/capture-recipes/room-chrome.json` covers the three roots, a pushed screen and the editor in each appearance. Capture the live logger separately after **Push A → Start workout**, once **Log set** and enabled **Finish** are present; its clock prevents exact whole-tree settlement.
- `gym_screen_viewed` still fires on every destination change.
- `ui/GymScreenTests.kt`, `RoomChromeTests.kt`, `GymNavigatorTests.kt` and `ui/AccountRouteTests.kt` pass, with a test that the Coach root shows the seat, that the tab reads *The log*, and that the logger's bar has no *Gym settings* action.

**Depends on:** 02. Ships together with 17; creation-route and onboarding acceptance remain required after the FAB replacement is present.

**Ledger:** 11a, 9z, 9r; dogfood `android-gym-target-page`.

**Native evidence:** `/private/tmp/windmill-android-room-chrome-native` retains all twelve PNGs, the APK/hash, exact executed recipes, account target bounds and telemetry/readbacks. The private runner skips settlement only for the ticking logger and stops before performance sampling. This is chrome acceptance; routine creation remains gated on 17.
