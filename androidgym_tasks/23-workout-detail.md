# Workout detail

**Status:** On main at `cadb48f6` in batch `b40dd5e0`; the shipped canonical states are 🚀 In production. The coordinated app release remains pending.

**Approved flow:** [Log / Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39834) — human-approved 2026-10-25. Workout discard uses the approved [Finish overflow confirmation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362); weight Undo remains separate.

**Figma:**
- 05.3 Workout detail: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27642) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30969)
- 05.14 Workout detail, Discard asks once: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40948) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41023)
- Components (Design System library, Android page):
  - `Android / Top app bar` `342:2953`
  - `Android / Equipment icon` `337:2025`
  - `Android / Button` `210:181` (Text · Tone=Error)

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/SessionScreen.kt` keeps the routine title, saved plan, detail-set fixes and swipe deletion. Movement headers use the existing equipment glyph and the stored load basis. The shared native error-text button opens the room-owned single confirmation with **Discard workout**.
- `presentation/Training.kt` derives each Android-local comparison effort from every performed set. It retains the scalar top set for comparison predicates and legacy decode, plus serialized rep/load bounds for the displayed range and recreation.
- `ui/FinishScreen.kt` formats the full effort range for `ReviewRemarks`, whose reader is workout detail. The Finish receipt retains its own approved fact/action presentation.
- The affected source gate passes 87 gym checks with no failures, errors or skips; app Debug compilation passes. `tools/capture-recipes/workout-detail.json` and `workout-detail-fixture.json` cover the five-set example and paired top/bottom/dialog frames. Paired Dark/Daylight detail, bottom actions and five-set confirmation are accepted on frozen source `8d844b43` (APK `6d3ad11a…`). The preserved intake contains session views and discard shown/cancelled/ok steps. Retained post-reset runtime and app exit history show no product fatal/ANR; the pre-reset boot log was not separately exported. Its canonical task states are marked 🚀 In production.

**Change**
- The title is the routine; a workout with no routine reads `Readout.noRoutine` (13).
- Movement header: 08’s equipment-aware presentation before the name. Preserve existing Cable/Kettlebell labels and load semantics; the four drawn icon variants do not authorize coercing other stored equipment.
- Plan line with the load basis and a space: *Plan 3 × 8 · 75 kg total* (barbell), *Plan 3 × 10 · 24 kg each* (two dumbbells). 08 changes `Readout.targetWithUnit`; this screen only uses it.
- Set notes never print a kind (the kind itself goes with 06).
- *Discard session* → *Discard workout*, an `Android / Button` Text in the error role (02).
  - A tap opens the dialog from 14 (05.14): *Discard this workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / **Cancel** · **Discard** (error role).
  - Discard removes the workout at once, then the room goes back to The log. No hold, no Undo.
- *Share this workout* is unchanged.
- Fix the comparison count in the domain: every set of the movement counts, in the performed row's own form (*3 × 6–8 · 75–80*). Add a domain vector. The receipt no longer draws the block (14), so this screen is its only reader.

**Out of scope:**
- Deleting a set by swipe and the set row's ground (05).
- The share sheet (05.5 and 05.13 match today in Dark; their Daylight is 02's).
- Fix set (10).

**Done when**
- Screenshots of 05.3 (top and bottom) and 05.14 match in Dark and Daylight; the rig (01) adds `05.3-workout-detail-dark/light`, `05.3-workout-detail-bottom-dark/light` and `05.14-detail-discard-dialog-dark/light`.
- `gym_screen_viewed` `session` still fires.
- Discard emits `gym_action` with `screen=session`, `action=discard`, `state=shown`, then `outcome=ok` / `cancelled` / `refused` / `failed` (the event comes from 05).
- Failures still report as `gym.discard`.
- Tests: `ui/SessionScreenTests.kt`, `ui/SessionDiscardTests.kt`, `presentation/TrainingTests.kt` (the comparison count, every set).

**Depends on:** 02, 05, 06, 08, 14.

**Ledger:** 11b, 11c, 9c, 12g, 9z; dogfood `android-gym-target-page`, `android-against-plan-undercounts`.
