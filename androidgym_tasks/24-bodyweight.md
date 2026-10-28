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

**Current source** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/BodyweightScreen.kt` contains the compact responsive Weigh-in form, with a shared 24 dp handle, native outlined field and error roles, inline Date row for new entries, fixed Date key for corrections, and error-toned Delete weigh-in. The form owns nav/IME padding once; both modal hosts disable their extra content insets.
- Save and IME Done use the same validated submission gate. Invalid/empty/out-of-range values cannot submit; the same refusal remains retryable without losing typed weight.
- The native `DatePickerDialog` stages its own selection and mode, retained through recreation. Use date commits to the form; Cancel, Back and outside dismissal keep the prior date. Future days and years remain disabled. Confirming the calendar does not save a weight.
- Bodyweight retains its ordinary chart and Every weigh-in drilldown, uses the standard M3 outlined segmented row/check, and routes row swipe plus correction Delete through the same durable held-delete path as the Log.
- The engine owns the original nine-foreground-second deadline, rewrite/expiry guards and account/restart release. A fresh same-origin/user/identityRevision Account wrapper retains only current engine-backed weight receipts; reconnect revalidates the replica, offer and exact deadline inside the guarded connection pipeline. Released, expired or foreign offers cannot renew Undo. Failed holds retain the row with an honest error, and refused released deletes restore the authoritative fact and notice.
- Compact/calendar/cross-screen/state checks pass, and the held-weight lifecycle suite passes 15 cases without skips, including fresh wrappers, changed origin/revision, released/expired offers, owner changes and reported reconnect read failure. The composed capture-tool suite passes 31 cases.
- Installed paired ordinary states and changed-date Cancel/Use/reopen/recreation pass. Native Save reaches the selected day with all six prior facts unchanged. Recreation retains the exact original engine deadline; Bodyweight→Log Undo restores the row while all server facts remain unchanged. The review packet retains timing/fixture qualifications and bounded intake receipts. Unexpected failure branches are deterministic unit coverage; no native unexpected Issue is claimed. No production status is claimed.

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
