# Workouts

Live logging, finish and correction. [Android delivery](../android-delivery.md) owns the native
logger geometry; [interaction polish](../interaction-polish.md) owns its pager arbitration.
[Feedback](../feedback-contract.md) owns elapsed-clock anchors and Coach states;
[gestures](13-gestures.md) owns deletion and confirmation.

## Logger and correction

The phone owns the live session and durable offline queue. **Log set** is the one primary,
pinned in the bottom reach band; **Finish** is a toolbar action. Web reads the live session and
corrects saved data but never starts or finishes a live session.

Live entry and Fix share the phone's rack keypad. Planning uses the platform numeric keyboard;
web correction uses editable numeric fields. Preserve large targets and the weight-band ladder.
The keypad shows `kg` for load, **whole reps** for reps and
**Enter a number, or cancel to keep {n}** for an empty buffer. Use the routine brief's numeric
refusals with the performed-rep range of 1–99. Accept comma and point; label the sign control
**Flip the sign — band-assisted** and backspace **Delete**.

Android uses the quiet ledger: movement identity, Previous/Next controls, exercise position when
there is more than one movement, elapsed clocks, and a vertical set ledger above the fixed rack.
History prefills the rack without a repeated Last time line. Logged rows open Fix; planned rows
have no action. The current row identifies its target without repeating the rack draft.
Sets have no type; every logged set takes the next number. Spoken row names include position,
state, load and reps. Keep the current row visible above the rack and any transient.

iOS uses native paging with a page indicator, compact visual working-set progress, a compact
scrolling ledger, distinct elapsed/rest icons and grounded weight/reps controls
(`../../ios/ios-redesign.md` §7.7). No surface offers a set type, in entry or correction. Targets
remain references, independent of actual load/reps and extra, skipped or substituted sets.

A successful log persists and sends immediately, with no after-log Undo. Correction and deletion
begin from its logged row and commit at once. The engine sends every change in the order it was
made, so a correction or a finish never overtakes the sets before it. Show local-only or failed
delivery beside the affected set and preserve recovery.

The two clocks count up from saved timestamps: workout start and latest valid session-wide set,
falling back to start. No visible clock labels, rest target or target bar; accessible names remain.
Android has no rest-target preferences or alerts.

## Finish receipt

Phones present a sheet over the finished session's detail page; dismissal returns to that workout.
Web's finish route reviews a past workout and remains a screen, with a route back to session
detail or Log when the session cannot be found.

Phones use **Well done.** for ordinary sessions and **Ended early.** below four working sets.
Show actual workout totals and performed movements; a true PR receives one emphasized line.
Do not substitute unperformed plan values or fabricate a workout-wide estimate.

On iOS, the receipt's pinned actions are quiet destructive **Discard**, neutral secondary
**👑 Share with Coach**, and prominent **Done**, in that order. Done is the only primary and
appears once. Discard confirms once and returns to The log. There is no explanatory sharing
footer, Keep action, or Save as routine form on this receipt. Share follows the existing account
handoff and normal Coach send path; the backend's account, trial, allowance and entitlement
checks remain authoritative. The crown identifies Windmill One without offering a checkout.

On Android, **Share with Coach** remains the primary only when Coach is available. It dismisses
the receipt, opens a fresh conversation and sends the workout-review question through the normal
send path. Both phones show ordinary waiting, allowance and failure states; the receipt has no
separate quota. [Coach](09-coach.md) owns the current limits.

**Share this workout** is the read-only human-sharing action on session detail and the Log row;
it does not appear beside Share with Coach on the receipt.

iOS has its bottom **Done** plus native sheet dismissal. Android uses Back, scrim and handle.
Finishing has already kept the workout. Web's slight-session branch retains its **Keep it** exit
and **Just keep the session** declines only the routine offer.

## Save as routine

Android and web keep the offer beneath the primary. Transcribe actual working sets per set using the scheme
contract. Apply the routine editor's 60-code-point cap and blank-name predicate; do not add a
counter to the receipt. Show **Name it to save it.** only for an empty name, never during a write.

Save is single-flight and retries preserve identity. A successful phone save replaces the form
with **Kept as {name}.**; web uses **{name} is in your routines.** in the room transient.
Show a refusal beside the form while the sheet stands, or in the room transient if it was dismissed.

iOS exposes Discard on the receipt, session detail and Log row, with one confirmation and no
Undo. Android puts it on session detail and the Log row; web's slight branch may expose it.
Android and web use the delete window described in the gestures contract.

## Feedback and acceptance

The room transient survives navigation, floats above the reach band and never moves Log set.
Reserve reading space beneath it. On Android and web its lifetime follows the delete deadline, independently of
ordinary message duration. iOS transients carry failures and notices, without Undo. Full semantics belong to [gestures](13-gestures.md).

Review both Instrument and Daylight, plus default, large and largest supported text sizes for
screens containing large numerals. Verify narrow columns, keyboard/queue failures, fixed action
reach, correction, finish, duplicate Save, deletion/confirmation and sheet dismissal. Each new refusal
needs concrete copy and an owning state; unresolved strings remain in the consistency ledger.

## Open

- iOS delayed-queue presentation beside the affected set.
