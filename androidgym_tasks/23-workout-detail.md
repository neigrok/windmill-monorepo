# Workout detail

**Figma:**
- 05.3 Workout detail: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27642) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30969)
- 05.14 Workout detail, Discard asks once: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40948) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41023)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953`
  - `Android / Equipment icon` `337:2025`
  - `Android / Button` `210:181` (Text · Tone=Error)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `SessionScreen` (`ui/SessionScreen.kt`):
  - Title: the routine, or *Free session* (:258, `Readout.noRoutine`).
  - Head: date and duration, *Volume*, the total, sets and movements, *Plan saved at start* (`SessionHead`, :395-406).
  - Movement card (`MovementCard`, :409): the name with no equipment icon (:427), then *Plan {target}* from `Readout.targetWithUnit`, which prints *3 × 8 · 75kg* (:167; `domain/Readout.kt:51-52`).
  - A non-working set's note is the raw kind wire, *warmup* / *drop* / *failure* (:128).
  - The comparison block (`ReviewRemarks`, :296).
  - *Share this workout* (:304) and *Discard session* in alarm ink with no confirmation (:313-328). Discard is held nine seconds behind *Undo* (`GymRoom.kt:643-647`).
- Defect: the comparison undercounts. Bench at 75 × 8, 75 × 6, 80 × 8 reads *3 × 8 · 75 → 1 × 8 · 80*: the effort counts only sets at the top load (`effort`, `domain/Training.kt:449-452`), so it reads as if one set was done.

**Change**
- The title is the routine; a workout with no routine reads `Readout.noRoutine` (13).
- Movement header: the equipment icon (08) before the name.
- Plan line with the load basis and a space: *Plan 3 × 8 · 75 kg total* (barbell), *Plan 3 × 10 · 24 kg each* (two dumbbells). 08 changes `Readout.targetWithUnit`; this screen only uses it.
- Set notes never print a kind (the kind itself goes with 06).
- *Discard session* → *Discard workout*, an `Android / Button` Text in the error role (02).
  - A tap opens the dialog from 14 (05.14): *Discard this workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / **Cancel** · **Discard** (error role).
  - Discard removes the workout at once, then the room goes back to The log. No hold, no Undo.
- *Share this workout* is unchanged.
- Fix the comparison count in the domain: every working set of the movement counts, in the performed row's own form (*3 × 6–8 · 75–80*). Add a domain vector. The receipt no longer draws the block (14), so this screen is its only reader.

**Out of scope:**
- Deleting a set by swipe and the set row's ground (05).
- The share sheet (05.5 and 05.13 match today in Dark; their Daylight is 02's).
- Fix set (10).

**Done when**
- Screenshots of 05.3 (top and bottom) and 05.14 match in Dark and Daylight; the rig (01) adds `05.3-workout-detail-dark/light`, `05.3-workout-detail-bottom-dark/light` and `05.14-detail-discard-dialog-dark/light`.
- `gym_screen_viewed` `session` still fires.
- Discard emits `gym_action` with `screen=session`, `action=discard`, `state=shown`, then `outcome=ok` / `cancelled` / `refused` / `failed` (the event comes from 05).
- Failures still report as `gym.discard`.
- Tests: `ui/SessionScreenTests.kt`, `ui/SessionDiscardTests.kt`, `domain/TrainingTests.kt` (the comparison count, every working set).

**Depends on:** 02, 05, 06, 08, 14.

**Ledger:** 11b, 11c, 9c, 12g, 9z; dogfood `android-gym-target-page`, `android-against-plan-undercounts`.
