# On this phone: the head of The log, the list, Inspect, Fix workout, Discard, and the sign-in decision

**Figma:**
- 07.7 The log, On this phone at the head: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42660) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-16909)
- 07.1 On this phone: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42787) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-16962)
- 07.2 Inspect: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1284-16798) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-16987)
- 07.3 Fix workout: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1284-16888) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-17039)
- 07.8 Discard this workout?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1284-17208) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-17094)
- 07.4 Sign-in decision, Add or Discard: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33533) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-17152)
- 07.5 Discard 3 workouts?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33632) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1285-17192)
- Components: `Android / NavigationBar` `659:6945` (the kit Badge on The log), `Android / Top app bar` `1260:2948`, `Android / Button` `656:6699` (Tone=Error), `Android / Menu` `1260:2608`.
- The iOS build is the model: `apps/ios/App/Sources/Gym/Recovery/OnThisPhoneSection.swift`, `WorkoutInspectScreen.swift`, `WorkoutFixSheet.swift`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `app/`)
- Every tab root shows *Saved workouts need review (N)* above the navigation bar, in alarm ink, opening Gym settings (`GymRoom.kt:980-982`).
- The saved workouts are cards inside Gym settings (`DeviceTrainingRow`, `ui/SettingsScreen.kt:182-310`): *Workout on {date} stays on this phone* (:212), buttons *Inspect workout* (:221), *Fix workout* (:236), *Retry* (:253), and *Keep* for an open copy (`imports.keepWorkout`, :225). No Discard.
  - Inspect is an `AlertDialog` *Saved workout* (:256-275); each set reads *60.0 kg × 8 · Working*, or *· Unrecognized set kind*.
  - Fix is `SavedWorkoutEditor` (:313-442), plain Material: *Fix saved workout* (:336), *Renumber sets for import* (:348), *{n} sets · import limit 200* (:354), per set *Remove set* in the accent, *Choose set kind* and its dialog (:293-308), typed fields *Logged (yyyy-MM-dd HH:mm)*, *Kilograms*, *Repetitions*, *Effort (optional, RPE 6–10)*, *Set note*. The time field collapses to about 12 px.
- Routines draws a refusal notice for a refused workout (`Refusals`, `ui/RoutinesScreen.kt:119`; headline from `refusalHeadline`, `ui/RefusalBanner.kt:31`), which reads *“Saved change” stays on this phone* because the fallback name is *Saved change* (`store/EngineTraining.kt:538`).
- The store already holds every action the boards need: `WorkoutImports.keepWorkout` (`store/WorkoutImports.kt:554`), `retry` (:662), `replaceAndRetry` / `replaceStartAndRetry`, `discardRefusal` (:740), and `TrainingStore.retryImport` (`store/TrainingStore.kt:619`).
- Sign-in decision (`EngineAccountDecision`, `app/MainActivity.kt:247-307`):
  - *Training saved on this phone* / *This account also has training. Add this phone’s training to it, or discard this phone’s signed-out training.* / the counts (`gymLineageCounts`, `store/GymEngineSession.kt:133`); buttons *Add*, *Discard*, *Cancel sign-in*.
  - *Discard this phone’s training?* / *This removes the signed-out training listed here. Your account’s training stays saved.* / the counts; *Discard*, *Cancel*.
  - Both *Discard* buttons use the default `TextButton` colour, the accent.
  - Defect: switching Dark/Daylight while the decision is up drops it. The *Check your email* sheet comes back with *Sign in* enabled and no decision; signing in again says *That code has expired*. The decision lives on `GymEngineSession.decision` (`store/GymEngineSession.kt:33`); the confirmation step is a plain `remember` (`app/MainActivity.kt:276`).

**Change**
- 07.7, the head of The log, signed in, while workouts wait:
  - One waiting workout is its own row, a door to Inspect. Two or more are one row **On this phone** / *3 workouts* · *2 need you* with a chevron, a door to the list (as iOS `OnThisPhoneSection.summary`).
  - The log tab carries the kit Badge (Large) with how many need you, visible from every tab.
  - The section leaves when nothing waits. Delete *Saved workouts need review (N)*.
- 07.1, a pushed list **On this phone**: section *Needs you*, rows *Push A · 24 Sep · 5 sets* over the reason (*Overlaps another workout — fix its times.*, *Your account has an open workout — keep this one as finished.*), each a door to Inspect; section *Adding*, rows *Legs · 22 Sep · 4 sets* / *Adding…* with the kit circular progress indicator. The list closes when nothing waits.
- 07.2, Inspect, a pushed screen (not a dialog): bar *Push A* with ⋮; the date *Thu 24 Sep*; tiles *1h 30m* **Duration** · *5* **Working sets** · *2000 kg* **Volume**; the reason; *Started 12:30*, *Finished 14:00*; the sets by movement (*Bench Press* · *1 80 × 5* …, no set kind).
  - The bottom button is the one way out the reason names: **Fix workout**, **Retry** or **Keep as finished**.
  - ⋮ holds **Discard workout**, and **Fix workout** when the button is another action.
- 07.3, Fix workout, a full-screen dialog: close ✕, title *Fix workout*, text action **Save and retry** (off while the copy would still be refused).
  - *Times*: *Started* and *Finished* as kit assist chips (*24 Sep 2026*, *12:30*) opening the Material date and time pickers. An unfinished copy shows *Not finished* and **Mark finished**.
  - A switch row *Linked to Push A*.
  - The sets by movement with their times (*1 80 × 5 / 12:36* …); a tap opens Fix set (03.3, task 10).
  - The line at the bottom says why it would be refused: *Overlaps another workout — fix its times.*
  - Gone: the typed date fields, *Choose set kind*, *Renumber sets for import*, *import limit 200*, *Fix saved workout*.
- 07.8, Discard from Inspect's ⋮: the dialog from 14 with the same words, *Discard this workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / **Cancel** · **Discard** (error role). Discard calls `discardRefusal` and returns to the list (or The log when nothing waits).
- Put the list, Inspect and Fix workout in one new file, `ui/OnThisPhoneScreen.kt`; delete `DeviceTrainingRow`, the inspect dialog and `SavedWorkoutEditor` from `ui/SettingsScreen.kt` (46 deletes the rest of that screen).
- Delete the refusal notice on Routines (`ui/RoutinesScreen.kt:119`): a refused workout lives in On this phone. Fix `refusalHeadline`'s fallback so no surface says *“Saved change”*: a refused workout reads *Workout on {date} stays on this phone*. The logger's and Notes' notices for other refused writes stay as they are.
- 07.4, the sign-in decision: an M3 basic dialog, *Add to your account?* / *This phone has 3 workouts from before you signed in. Your account already has training. Add them, or discard them from this phone.* / **Cancel sign-in** · **Discard** (error role) · **Add**. The counted line (*1 workout · 2 sets · 1 weigh-in*) goes; the sentence carries the workout count. No board draws a phone that holds no workout but other records (weigh-ins, routines, notes); ask the designer for that sentence before building it (ledger 7d).
- 07.5, its confirmation: *Discard 3 workouts?* / *They are deleted from this phone. You can’t undo this.* / **Cancel** · **Discard** (error role). Cancel returns to the question.
- Keep the decision across recreation: a mode switch, a rotation or a font change must bring back the same dialog (and the confirmation step, if it was showing), not the code sheet. Hoist the confirmation step into saved state and make sure the shell does not reopen the code sheet while a decision is pending. Check every gym `ModalBottomSheet` after a mode switch for the same class of defect (19 fixes Create movement).

**Out of scope:**
- Removing `SetKind` from the domain (06); Fix set itself (10).
- The rest of The log (22) and the rest of Gym settings (46).

**Done when**
- Screenshots of 07.7, 07.1, 07.2, 07.3, 07.8, 07.4 and 07.5 match in Dark and Daylight; the rig (01) adds `07.7-log-on-this-phone-dark/light`, `07.1-on-this-phone-dark/light`, `07.2-inspect-dark/light`, `07.3-fix-workout-dark/light`, `07.8-discard-copy-dark/light`, `07.4-sign-in-decision-dark/light`, `07.5-discard-phone-workouts-dark/light`, and a capture of 07.4 taken after a mode switch.
- `gym_import_recovery` (inspect, keep, fix, retry) still fires, and gains `action` `discard` with `state` `shown`, then `outcome` `ok` / `cancelled` / `failed`. `gym_sign_in_decision` and `client_update_required` are unchanged. List the new action in `docs/ANDROID_OBSERVABILITY.md`.
- Failures still report as `gym_import_keep`, `gym_import_retry`, `gym_import_fix`; a failed discard reports as `gym_import_discard`.
- Tests: a new `ui/OnThisPhoneScreenTests.kt` (rows, reasons, the one bottom action per reason, ⋮ Discard, the badge count), `ui/RefusalBannerTests.kt`, `store/WorkoutImportsTests.kt`, `store/GymEngineSessionTests.kt`, and a recreation test for the decision in `apps/android/app/src/test/kotlin/works/windmill/app/`. `ui/SettingsScreenTests.kt` loses its recovery cases.

**Depends on:** 02, 06, 10, 14, 22.

**Ledger:** 9k, 9c, 11c, 7d, 12g; dogfood `android-gym-target-page`, `android-signin-decision-survives-recreation`, `android-sheets-after-recreation`.
