# On this phone: inspect, fix, the sign-in decision

**Figma:**
- 07.2 Inspect: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32943) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36637)
- 07.3 Fix workout: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33036) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36688)
- 07.4 Sign-in decision, Add or Discard: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33533) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36748)
- 07.5 Discard this phone’s training?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33632) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36791)
- 07.6 Refusal notice on Routines: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33710) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36824)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Button` `656:6699` (Tone=Error)
  - `Android / FAB` `1247:2332` (07.6 draws the Routines chrome from 17)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `app/`)
- Inspect (`ui/SettingsScreen.kt:256-275`, an `AlertDialog` *Saved workout*): each set reads *60.0 kg × 8 · Working*, or *· Unrecognized set kind* (:268).
- Fix (`SavedWorkoutEditor`, `ui/SettingsScreen.kt:313-442`), plain Material, not gym-skinned:
  - *Fix saved workout* / *Your original workout stays saved. These corrections are used only when you tap Save and retry.*
  - Per set: *Set n* with *Remove set* as a default (accent) `TextButton` (:359); *Choose set kind* / *Kind: {Warmup|Working|Drop|Failure}* and its options (:369-383); fields *Logged (yyyy-MM-dd HH:mm)*, *Kilograms*, *Repetitions*, *Effort (optional, RPE 6–10)*, *Set note* (:386-390), all on the default text keyboard.
  - The error *Choose a kind for each unrecognized set, or remove that set explicitly.* (:402); *Save and retry* / *Cancel* (:437-438).
  - The *Choose set kind* dialog (:293-308) and the card's *Choose set kind* button (:240-242).
  - Defect: the per-set time field collapses to about 12 px under the buttons.
- Sign-in decision (`EngineAccountDecision`, `app/MainActivity.kt:247-307`):
  - *Training saved on this phone* / *This account also has training. Add this phone’s training to it, or discard this phone’s signed-out training.* / the counts; buttons *Add*, *Discard* (:303), *Cancel sign-in*.
  - *Discard this phone’s training?* / *This removes the signed-out training listed here. Your account’s training stays saved.* / the counts; *Discard* (:290), *Cancel*.
  - Both *Discard* buttons use the default `TextButton` colour, the accent.
  - Defect: switching Dark/Daylight while the decision is up drops it. The *Check your email* sheet comes back with *Sign in* enabled and no decision; signing in again says *That code has expired*. The decision lives on `GymEngineSession.decision` (`store/GymEngineSession.kt:33`); the confirmation step is a plain `remember` (`app/MainActivity.kt:276`).
- Refusal notice (`ui/RefusalBanner.kt:39`): a refused workout's headline reads *“Saved change” stays on this phone*, because the fallback name is *Saved change* (`store/EngineTraining.kt:538`).

**Change**
- Inspect (07.2): each set reads *60.0 kg × 8*. *Unrecognized set kind* goes.
- Fix workout (07.3):
  - Remove *Choose set kind*, *Kind: …*, the kind dialog, the card's *Choose set kind* button and the *Choose a kind…* error (with 06, which removes the kinds).
  - *Remove set* in the error role (02), as a Quiet · Tone=Error button.
  - *Kilograms* and *Repetitions* side by side; *Kilograms* and *Effort* (half steps) use `KeyboardType.Decimal`, *Repetitions* `KeyboardType.Number`. *Logged*, *Effort* and *Set note* sit below, unchanged in copy.
  - Fix the collapsed time field: every field keeps at least 56 dp.
  - Skin the sheet with the gym colours and type (`GymMaterial`), like the room's other sheets.
- Sign-in decision (07.4): an M3 basic dialog with three actions in this order: *Cancel sign-in* · *Discard* · *Add*. *Discard* in the error role. Copy unchanged.
- Confirmation (07.5): *Discard* in the error role. Copy unchanged; Cancel returns to the question.
- Keep the decision across recreation: a mode switch, a rotation or a font change must bring back the same dialog (and the confirmation step, if it was showing), not the code sheet.
  - Hoist the confirmation step out of `remember` into saved state, and make sure the shell does not reopen the code sheet while a decision is pending.
  - Same class of defect, other sheets: check every gym `ModalBottomSheet` after a mode switch (19 fixes Create movement).
- Refusal notice (07.6): the notice stays as it is, drawn under the Routines chrome from 17 (FAB above *Start logging*, no *New routine*). Fix the headline: a refused workout reads *Workout on {date} stays on this phone*, the same words as the settings card (`ui/SettingsScreen.kt:212`). The notice's swipe keeps *Dismiss* (11b).

**Out of scope:**
- Removing `SetKind` from the domain (06).
- The settings card and the review door (07.1 matches today; its Daylight is 02's).
- The Routines chrome itself (17).

**Done when**
- Screenshots of 07.2, 07.3, 07.4, 07.5 and 07.6 match in Dark and Daylight; the rig (01) adds `07.2-inspect-dark/light`, `07.3-fix-workout-dark/light`, `07.4-sign-in-decision-dark/light`, `07.5-discard-phone-training-dark/light`, `07.6-refusal-notice-dark/light`, and a capture of 07.4 taken after a mode switch.
- `gym_import_recovery` (inspect, keep, fix, retry) and `gym_sign_in_decision` still fire with today's properties; `client_update_required` is untouched.
- Failures still report as `gym_import_keep`, `gym_import_retry`, `gym_import_fix`.
- Tests: `ui/SettingsScreenTests.kt`, `ui/RefusalBannerTests.kt`, `store/WorkoutImportsTests.kt`, `store/GymEngineSessionTests.kt`, and a recreation test for the decision in `apps/android/app/src/test/kotlin/works/windmill/app/`.

**Depends on:** 02, 06, 17.

**Ledger:** 9c, 11c, 7d; dogfood `android-gym-target-page`, `android-signin-decision-survives-recreation`, `android-sheets-after-recreation`.
