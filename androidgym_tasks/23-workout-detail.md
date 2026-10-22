# Workout detail

**Figma:**
- 05.3 Workout detail: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27642) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30969)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Top app bar` `1260:2948`
  - `Android / Equipment icon` `1247:2247`
  - `Android / Button` `656:6699` (Quiet · Tone=Error)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `SessionScreen` (`ui/SessionScreen.kt`):
  - Title: the routine, or *Free session* (:258, `Readout.noRoutine`).
  - Head: date and duration, *Volume*, the total, sets and movements, *Plan saved at start* (`SessionHead`, :395-406).
  - Movement card (`MovementCard`, :409): the name with no equipment icon (:427), then *Plan {target}* from `Readout.targetWithUnit`, which prints *3 × 8 · 75kg* (:167; `domain/Readout.kt:51-52`).
  - A non-working set's note is the raw kind wire, *warmup* / *drop* / *failure* (:128).
  - The comparison block (`ReviewRemarks`, :296).
  - *Share this workout* (:304) and *Discard session* in alarm ink with no confirmation (:313-328). Discard is held nine seconds behind *Undo* (`GymRoom.kt:643-647`).
- Defect: the comparison undercounts. Bench at 75 × 8, 75 × 6, 80 × 8 reads *3 × 8 · 75 → 1 × 8 · 80*: the effort counts only sets at the top load (`domain/Training.kt:450-451`), so it reads as if one set was done. The finish receipt shows the same block (14).

**Change**
- Title *Free workout* for a free workout (`Readout.noRoutine`, shared with 22).
- Movement header: the equipment icon (08) before the name.
- Plan line with the load basis and a space: *Plan 3 × 8 · 75 kg total* (barbell), *Plan 3 × 10 · 24 kg each* (two dumbbells). 08 changes `Readout.targetWithUnit`; this screen only uses it.
- Set notes never print a kind (the kind itself goes with 06).
- *Discard session* → *Discard workout*, an `Android / Button` Quiet in the error role (02).
  - A tap opens the dialog from 14 (*Discard this workout?* / *Its {n} sets leave your log for good.* / **Cancel** · **Discard**).
  - Discard removes the workout at once, then the room goes back to the Log. No hold, no Undo.
- *Share this workout* is unchanged.
- The comparison defect is fixed once in the domain by 14 (every working set counts, in the performed row's form); this screen shows the corrected block.

**Out of scope:**
- Deleting a set by swipe and the set row's ground (05).
- The share sheet (05.5 and 05.13 match today in Dark; their Daylight is 02's).
- Fix set (10).

**Done when**
- Screenshots of 05.3 match in Dark and Daylight, top and bottom; the rig (01) adds `05.3-workout-detail-dark/light` and `05.3-workout-detail-bottom-dark/light`.
- `gym_screen_viewed` `session` still fires.
- Discard emits `gym_action` with `screen=session`, `action=discard`, `state=shown`, then `outcome=ok` / `cancelled` / `refused` / `failed` (the event comes from 05).
- Failures still report as `gym.discard`.
- Tests: `ui/SessionScreenTests.kt`, `ui/SessionDiscardTests.kt`, `domain/TrainingTests.kt` (the comparison count after the ruling), `ui/FinishScreenTests.kt` if the shared reading changes.

**Depends on:** 02, 05, 06, 08, 14.

**Ledger:** 11b, 11c, 9c; dogfood `android-gym-target-page`, `android-against-plan-undercounts`.
