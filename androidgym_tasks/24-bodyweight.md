# Bodyweight list and correcting a weigh-in

**Figma:**
- 06.2 Bodyweight: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32141) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46157)
- 06.3 Correct a weigh-in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32246) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46256)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Swipe row` `1247:2439`
  - `Android / Button` `656:6699` (Quiet · Tone=Error)
  - `Android / Top app bar` `1260:2948`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `BodyweightScreen` (`ui/BodyweightScreen.kt:225-350`):
  - The window toggle *90 days* / *All* is an M3 `SingleChoiceSegmentedButtonRow` re-skinned to look custom: no border, 16 dp corners, `raised` fill on the chosen one (:269-279).
  - The chart card, *90 days · 7 weigh-ins*, and *Every weigh-in* rows (weight, date, chevron; :302-315) match the board.
  - Rows do not swipe. A tap opens the weigh-in sheet to correct it.
- The correct sheet (`WeighInSheet`, :94-214): *Weigh in*, the weight, a fixed date, *Save weight*, and *Delete weigh-in* as a `TextButton` in ink (:206-211).
- Delete is held: the sheet closes and *Weigh-in deleted.* shows with *Undo* for nine seconds (:344; `store/WithheldDelete.kt:80`). A failed delete after the window reports nothing to the lifter (`store/TrainingStore.kt:1233` reports `gym.deleteWeighIn`).

**Change**
- Window toggle: a standard M3 `SingleChoiceSegmentedButtonRow`, *90 days* | *All*, with the default outline, shape and check icon on the chosen segment (`SegmentedButtonDefaults.itemShape`). Remove the custom colours and the empty `icon = {}`.
- Every weigh-in row swipes end-to-start on `DeleteSwipeRow` (04), a11y label *Delete weigh-in*. Past the threshold the weigh-in is deleted at once: no hold, no Undo.
- Correct sheet (06.3): *Weigh in*, *81.1 kg*, the fixed date *19 October 2026*, **Save weight**, then **Delete weigh-in** as `Android / Button` Quiet · Tone=Error (error role, 02). It deletes at once and closes the sheet.
- A refused or failed delete puts the row back and the note line says why: *the log didn’t answer — that weigh-in is still here*.
- 05 already makes the store's weigh-in delete immediate; this task adds the swipe and the button.

**Out of scope:**
- The new weigh-in sheet (06.1 matches today; its Daylight accent is 02's).
- The Log's Weigh in FAB (22).

**Done when**
- Screenshots of 06.2 (one row mid-swipe) and 06.3 match in Dark and Daylight; the rig (01) adds `06.2-bodyweight-dark/light` and `06.3-correct-weigh-in-dark/light`.
- `gym_bodyweight_saved` still fires on save.
- A weigh-in delete emits nothing today. Add `gym_action` with `screen=bodyweight`, `action=delete`, `outcome=ok` / `refused` / `failed`.
- Failures still report as `gym.deleteWeighIn`; an expected refusal is an event, not a Sentry issue.
- Tests: `ui/BodyweightScreenTests.kt`, `ui/BodyweightStateTests.kt`, `ui/BodyweightLayoutTests.kt`, `store/BodyweightWriteTests.kt`, `store/WithheldWindowTests.kt` (the bodyweight case goes).

**Depends on:** 02, 04, 05.

**Ledger:** 11b, 11c; dogfood `android-gym-target-page`.
