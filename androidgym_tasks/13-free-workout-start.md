# Free workout before the first movement

**Figma:** 03.9 Free workout, before the first movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33857) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34732)
- Components (Gym Components page, section `🧩 Android · Material 3`): `Android / Top app bar` `1260:2948`, `Android / Equipment icon` `1247:2247`, `Android / Button` `656:6699` (Create movement).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- *Start logging* opens the logger on the movement picker. The bar title is `store.session?.plan?.routine ?: "Free session"` (`ui/LoggerScreen.kt:320`).
- The picker title is *What are you starting with?* on the first workout, otherwise *What are you lifting?* (`ui/LoggerScreen.kt:364`).
- `MovementPicker` (`ui/MovementPicker.kt`):
  - search *Search movements* in a 28 dp pill outline (:293-296);
  - sections *The six* (:309) and *All movements* (:314);
  - rows print the equipment word, capitalised from the wire (*Dumbbell*, :486), *was “{alias}”* (:487), and *never logged* or the last time (:125);
  - **Create movement** (:334).
- Signed out on the first workout, a dashed card says *Have a written program? An agent can build it — sign in first.* / *Build my routine →* (`BuildMyRoutine`, :452-470; shown at :319).

**Change**
- Bar title *Free workout*.
- Keep the title *What are you starting with?* and the workout clocks under the bar.
- The search field is a filled M3 `SearchBar` (input field form), placeholder *Search movements*, leading `search` icon.
- Rows are M3 `ListItem`s:
  - leading: the equipment icon (08) instead of the equipment word;
  - headline: the name; supporting: *never logged* or the last time, and *was “{alias}”* when the match came from an alias;
  - trailing: + (✓ when the movement is already in the workout). The + adds the movement.
- **Create movement** stays at the foot.
- Delete the *Build my routine* card: the board draws none, and signed-out Coach builds routines from a screenshot (39).
- The same picker serves *Add movement* in the editor (02.4) and the logger; keep its title per caller.

**Out of scope:** Create movement's form (19); the routine editor (17, 18).

**Done when**
- Screenshots of 03.9 match in Dark and Daylight; the rig (01) adds `03.9-free-workout-dark/light` (signed out, first workout).
- `gym_session_started` still fires once when the workout starts (`store/TrainingStore.kt:670`); `gym_screen_viewed` `workout` is unchanged.
- `ui/PickerOptionsTests.kt`, `ui/PickerSixRankingTests.kt` and `ui/LoggerScreenTests.kt` assert the new title and the icon-led rows.

**Depends on:** 03, 08.

**Ledger:** 9z, 11b, 11c; dogfood `android-gym-target-page`.
