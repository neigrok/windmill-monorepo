# Finish receipt, Ended early, and Discard this workout?

**Figma:**
- 03.7 Finish receipt: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34558)
- 03.8 Finish receipt, ended early: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32441) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34614)
- 03.14 Discard this workout?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32499) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34652)
- Components (Gym Components page, section `🧩 Android · Material 3`): `Android / Button` `656:6699` (Primary 64 dp; Quiet · Tone=Error 112 dp; Primary · Tone=Error in the dialog).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `FinishScreen` (`ui/FinishScreen.kt:232`) in a `ModalBottomSheet` (`GymRoom.kt:869-919`). Underneath is the workout detail.
  - *Well done.*, or *Ended early.* under 4 working sets (:259; `domain/Training.kt:382`).
  - *{routine | Free session} · Workout saved* (:261). Tiles *Sets*, *kg lifted*, *Movements* (:265-267), always plural.
  - *Against plan* / *Against last {routine}* / *Performed* (:95-102).
  - **Share with Coach** with *Sends Coach one line — “Check my last session.” — and opens the answer.* (:147-149), signed in and Coach present only (`GymRoom.kt:900`). It scrolls with the content.
  - The receipt draws no discard (comment at `ui/FinishScreen.kt:60-64`). *Discard session* lives on the log row and workout detail, held for 9 s with an Undo (`GymRoom.kt:642-647`).
- Defects:
  - The against-plan line counts only the sets at the top load: Bench 75 × 8, 75 × 6, 80 × 8 reads *3 × 8 · 75 → 1 × 8 · 80* (`effort`, `domain/Training.kt:449-452`).
  - Finishing a workout with no set saves it and offers Share with Coach (`TrainingStore.finish`, `store/TrainingStore.kt:779`).

**Change**
- 03.7: content scrolls under a pinned action band.
  - The band: the line *Sends Coach one line — “Check my last workout.” — and opens the answer.*, then a row: **Discard** (Quiet · Tone=Error, 112 dp) and **Share with Coach** (64 dp primary, fills the rest).
  - The question sent is *Check my last workout.*
- 03.8 ended early (signed out, free workout):
  - Subtitle *Free workout · Workout saved*. Tile labels follow the count: *1 Movement*, *1 Set*.
  - The band holds **Discard** and **Done**. **Done** is new: it closes the sheet onto the workout detail. Signed out, there is no Share.
- 03.14: **Discard** opens an M3 `AlertDialog`: title *Discard this workout?*, body *Its {n} sets leave your log for good.*, buttons **Cancel** / **Discard** (error role).
  - On **Discard** the workout is deleted at once and the room opens The log. No hold, no Undo (05).
  - The workout-detail **Discard workout** (23) and the log row swipe (22) use this same dialog.
- Fix the against-plan count: the performed side counts every working set of the movement, in the performed row's own form (*3 × 6–8 · 75–80*). Add a domain vector.
- A workout with no set is not saved as one and is never offered to Coach. Settle the surface for it with the designer before building (no board draws it).
- Delete `Finish.discard` *Discard session*. The last of 14 and 37 to land deletes `store/WithheldDelete.kt`.

**Out of scope:** the log row swipe (22); workout detail (23); keep-as-routine copy.

**Done when**
- Screenshots of 03.7, 03.8 and 03.14 match in Dark and Daylight, with the corrected against-plan numbers; the rig (01) adds `03.7-finish-receipt-dark/light`, `03.8-ended-early-dark/light`, `03.14-discard-dialog-dark/light`.
- `gym_session_finished` still fires; Share with Coach still emits `gym_ask_started`.
- `gym_action` with `screen` `finish`, `action` `discard`: `state` `shown` when the dialog opens, then `outcome` `ok` / `cancelled` / `refused` / `failed`. Unexpected failures report under `gym.discard`.
- Tests: `FinishSheetTests.kt`, `ui/FinishScreenTests.kt`, `ui/FinishLayoutTests.kt` and `ui/SessionDiscardTests.kt` assert the band, the dialog and an immediate discard; `domain/TrainingTests.kt` covers the count fix and the empty finish; `store/TrainingFinishTests.kt` passes.

**Depends on:** 04, 05.

**Ledger:** 9z, 11b, 11c; dogfood `android-gym-target-page`, `android-against-plan-undercounts`, `android-empty-workout-finish`.
