# Compact native Weigh-in, calendar date staging and nine-second Undo

**Approved flow:** [Weigh-in](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 06.1 Weigh in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-31991) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46006)
- 06.2 Bodyweight: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32141) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46157)
- 06.3 Correct a weigh-in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32246) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-46256)
- Components (Design System library, Android page):
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181` (Text · Tone=Error)
  - `Android / Top app bar` `342:2953`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `BodyweightScreen` (`ui/BodyweightScreen.kt:225-350`):
  - The window toggle *90 days* / *All* is an M3 `SingleChoiceSegmentedButtonRow` re-skinned to look custom: no border, 16 dp corners, `raised` fill on the chosen one (:269-279).
  - The chart card, *90 days · 7 weigh-ins*, and *Every weigh-in* rows (weight, date, chevron; :302-315) match the board.
  - Rows do not swipe. A tap opens the weigh-in sheet to correct it.
- The correct sheet (`WeighInSheet`, :94-214): *Weigh in*, the weight, a fixed date, *Save weight*, and *Delete weigh-in* as a `TextButton` in ink (:206-211).
- Delete is held: the sheet closes and *Weigh-in deleted.* shows with *Undo* for nine seconds (:344; `store/WithheldDelete.kt:80`). A failed delete after the window reports nothing to the lifter (`store/TrainingStore.kt:1233` reports `gym.deleteWeighIn`).

**Change**
- Implement the approved compact Weigh-in composition: normal sheet about 314 dp, inline-error example 340 dp, with responsive height/scrolling rather than an unconditional fixed height. Weight, Date and **Save weight** fit above the Decimal IME; remove excess bottom padding and any additional backing panel. Preserve native status/navigation insets and 48 dp minimum targets. The canonical 360×800 compact example is the minimum screenshot check, not permission to clip larger text.
- The existing implementation already uses Material 3 `DatePickerDialog`; keep a genuinely native modal calendar. It must occupy a usable dialog, not the reported thin strip. Support native month/year navigation and calendar/text-input modes, 48 dp day targets, and the existing future-date restriction.
- Date is staged independently of typed weight: opening the dialog starts from the selected date; **Use date** commits a valid staged date to the form, and **Cancel**/Back/dismiss leaves the prior date. Every path preserves typed weight. Reopen at the committed date, not today. Preserve the entry draft and staged calendar state across recreation; never save a weight merely by confirming a date.
- New entry permits date selection; correction keeps its existing date key fixed. Preserve 20–400 kg domain validation, decimal parsing and date constraints. Invalid input shows the approved native error outline/supporting sentence and disables Save; IME Done must not bypass validation. A valid save emits only once, keeps the draft if refused and leaves both chart/timeline consistent.
- Keep the existing chart and Every weigh-in drilldown. Use the standard M3 **90 days**/**All** segmented row with outline, shape and chosen check, without custom chip styling.
- Every weight row’s end-to-start swipe and the correction sheet’s error-toned **Delete weigh-in** enter the same held-delete path as the Log. Hide the row and show **Undo** for nine foreground seconds unless an explicit lifecycle release ends the hold sooner. Undo restores. Use the durable engine lifecycle from 05 / engine §7.3: activity recreation keeps remaining time; actual app backgrounding releases to the queue, with no Undo on return. Process restart/sign-in/sign-out release held entries; ordinary screen navigation does not. A successful same-day correction/rewrite retires its pending hold so the timer cannot delete the new value; a failed rewrite keeps Undo. Keep expiry/sent guards and `WithheldDelete.kt` (05).
- A delete refusal/failure restores or retains the authoritative row with an honest error; do not leave a silently vanished row. No confirmation is added to the approved reversible weight delete.

**Out of scope:**
- The log behind 06.1 and its Weigh in FAB (22).

**Done when**
- Capture Dark/Daylight normal, calendar, staged-date, confirmed/cancelled-date, compact IME, validation/error, Bodyweight swipe/Undo and correction states. Verify small phones and large text; focused field, supporting error, Date and Save remain reachable above the IME without excess blank space or a strip-sized calendar.
- Calendar tests cover month/year and text input, Use date, Cancel/Back/outside dismiss, future-date rejection, reopening and recreation. Typed weight survives every path; date cancel preserves the original selection. Correction cannot change the keyed date.
- Invalid/out-of-range/empty weight cannot save via button or IME. Valid save happens once and remains in the draft on refusal; chart and chronological Log reflect the saved day without inventing clock times.
- Preserve `WithheldWindowTests`/`WithheldSendTests` weight cases and add missing cross-screen races: Undo while the foreground hold is open sends nothing, expiry or lifecycle release queues the delete once, late Undo reports accurately, recreation preserves remaining time, actual backgrounding releases the durable hold with no Undo on return, process restart releases the hold, successful same-day rewrite cancels the timer, failed rewrite keeps Undo, and a failed delete cannot silently lose a row.
- `gym_bodyweight_saved` still fires on successful save. Use bounded content-free `gym_action` steps for calendar open/confirm/cancel, hold-delete, Undo/cancel and actual delete outcome; no weight, date, ID or typed content. Document labels in `docs/ANDROID_OBSERVABILITY.md`; expected validation/refusal is not a Sentry Issue. Unexpected save/delete failures retain `gym.weighIn` / `gym.deleteWeighIn`.
- Update Bodyweight UI/state/layout, write and held-delete tests; do not delete their recovery assertions.

**Depends on:** 02, 04, 05, 22.

**Ledger:** 11b, 11c; dogfood `android-gym-target-page`.
