# Finish receipt, Ended early, Discard this workout?, and the first workout's Keep line

**Figma:**
- 03.7 Finish receipt: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34558)
- 03.8 Finish receipt, ended early: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32441) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34614)
- 03.14 Discard this workout?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41920) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41989)
- 03.15 Finish receipt, first workout, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42292) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42368)
- Components (Design System library, Android page): `Android / Button` `210:181` (Tonal for Share with Coach; Text · Tone=Error for Discard; Filled for Done; Filled · Tone=Error in the dialog).
- The iOS receipt is the reference: iOS boards 03.7 and 03.8, `apps/ios/App/Sources/Gym/Workout/WorkoutReceipt.swift`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `FinishScreen` (`ui/FinishScreen.kt:232-312`) in a `ModalBottomSheet` (`GymRoom.kt:869-919`). Underneath is the workout detail.
  - *Well done.*, or *Ended early.* under 4 working sets (:259; `domain/Training.kt:382`).
  - *{routine | Free session} · Workout saved* (:261). Tiles *Sets*, *kg lifted*, *Movements* (:265-267), always plural.
  - The personal record line (`RecordLine`, :192), then the movement rows with a ✓ (:280-292).
  - *Against plan* / *Against last {routine}* / *Performed* (:89-103, drawn by `ReviewRemarks`).
  - **Share with Coach** with *Sends Coach one line — “Check my last session.” — and opens the answer.* (`FinishCoach`, :147-149), shown only signed in and where Coach exists (`GymRoom.kt:900-913`). It scrolls with the content.
  - The receipt draws no discard and no **Done** (`Finish.discard`, :61-64): it ends when the sheet is swiped down. *Discard session* lives on the log row and workout detail, held for 9 s with an Undo (`GymRoom.kt:643-647`).
- Signed out, nothing on the receipt suggests signing in.
- Defect: finishing a workout with no set saves it and offers Share with Coach (`TrainingStore.finish`, `store/TrainingStore.kt:779`).

**Change**
- 03.7, as iOS draws it:
  - Title *Well done.*; subtitle *{routine} · {weekday, month day}*: *Push A · Thu, Oct 22*. *Workout saved* goes.
  - Three tiles: *52m* **Duration** · *5* **Working sets** · *2,455 kg* **Volume** (the unit at half size).
  - The personal record card as today (*Personal record* / *Bench Press e1RM 101.3 kg — past 95 from Fri 9 Oct.*).
  - Head **Performed**, then each movement and its sets in the performed form: *Bench Press* / *3 × 6–8 · 75–80 kg*, *Incline Dumbbell Press* / *1 × 10 · 24 kg each* (units from 08).
  - Delete the *Against plan* / *Against last* block from the receipt, and the Coach line.
  - A band pinned at the bottom, in thumb reach: **👑 Share with Coach** (Tonal, full width) above a row of **Discard** (Text · Tone=Error) and **Done** (Filled, on the thumb side).
  - **Done** closes the sheet onto the workout detail. **Share with Coach** sends *Check my last workout.* (`FinishCoach.question`, the iOS words in `WorkoutState.swift:724`) through the same path as today.
- 03.8, ended early: *Ended early.* / *Push A · Thu, Oct 22*, tiles *9m* · *2* · *960 kg*, **Performed** · *Bench Press* / *2 × 8 · 60 kg*, and the same band.
- 03.14: **Discard** opens an M3 `AlertDialog`: *Discard this workout?* / *This deletes the workout and its 2 sets. You can’t undo this.* (*This deletes the workout and its {n} sets. You can’t undo this.*) / **Cancel** · **Discard** (error role).
  - On **Discard** the workout is deleted at once and the room opens The log. No hold, no Undo (05).
  - The workout detail's **Discard workout** (23), the log row swipe (22) and Inspect's ⋮ (25) use this same dialog and these words. Put the dialog and its sentence in one place (e.g. `ui/ConfirmDialog.kt`, the file the 05.14 caption names).
- 03.15, the first finished workout while signed out: 03.7 without the record card, and one line under the tiles, *Only on this phone · Keep it* (*Keep it* bold, accent).
  - **Keep it** opens the sign-in step (Shell · Android 15a, task 27).
  - Shown only on the receipt of the first finished workout on this phone while signed out; a once-only flag on this phone records that it was shown. Later receipts never show it, and no other gym screen asks to sign in (17 and 27 remove the standing ones).
  - Signed out, **Share with Coach** is drawn as well. Follow iOS (`apps/ios/App/Sources/Gym/GymRoom.swift:205`): it opens the sign-in step, and the question is sent once the lifter is signed in. Where this Windmill has no Coach it is not drawn, as today.
- A workout with no set is not saved as one and is never offered to Coach. Settle the surface for it with the designer before building (no board draws it).
- Delete `Finish.discard` *Discard session*. The last of 14 and 37 to land deletes `store/WithheldDelete.kt`.

**Out of scope:** the log row swipe (22); workout detail and its comparison (23); *Save a routine* (13); Inspect (25).

**Done when**
- Screenshots of 03.7, 03.8, 03.14 and 03.15 match in Dark and Daylight; the rig (01) adds `03.7-finish-receipt-dark/light`, `03.8-ended-early-dark/light`, `03.14-discard-dialog-dark/light`, `03.15-first-workout-signed-out-dark/light`.
- `gym_session_finished` still fires; Share with Coach still emits `gym_ask_started` when the question is sent.
- `gym_action` with `screen` `finish`: `action` `discard` with `state` `shown` when the dialog opens, then `outcome` `ok` / `cancelled` / `refused` / `failed`; `action` `keep` with `outcome` `ok` when **Keep it** opens the sign-in step; `action` `done`. Unexpected discard failures report under `gym.discard`. List the actions in `docs/ANDROID_OBSERVABILITY.md`.
- A test proves the Keep line shows on the first signed-out receipt only: not on the second, not signed in.
- Tests: `FinishSheetTests.kt`, `ui/FinishScreenTests.kt`, `ui/FinishLayoutTests.kt` and `ui/SessionDiscardTests.kt` assert the tiles, the band, the dialog and an immediate discard; `domain/TrainingTests.kt` covers the empty finish; `store/TrainingFinishTests.kt` passes.

**Depends on:** 04, 05, 08, 13.

**Ledger:** 12d, 12f, 12g, 9z, 11b, 11c; dogfood `android-gym-target-page`, `android-empty-workout-finish`.
