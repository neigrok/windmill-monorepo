# Gym gestures

Use platform gestures with discoverable controls and accessibility alternatives. The room owns
shared delete windows; each feature owns its gesture meaning.

## Five laws

1. **Every action has an accessible alternative.** iOS swipe actions expose the Actions rotor.
   Android swipe rows must declare custom accessibility actions unless a real control already
   offers the same act. A long-press menu needs equivalent accessible actions.
2. **Destructive gestures require Undo.** Hold a delete for 9000ms before sending it. Turning a
   proposal down has no undo path and must never be a swipe. Its decision flow belongs to
   `09-coach.md`.
3. **One gesture has one owner.** System Back owns the leading edge; sheets own dismiss gestures.
   Room gestures start outside the system edge and must not compete with a second scroller.
4. **Preserve state when removing controls.** A deleted row's Undo and pending state move to the
   room transient; they cannot disappear with the row. Prefer gestures that simplify a screen.
5. **Use restrained native feedback.** No feedback on scrolling and no double feedback for one
   act. Android logging adds no sound or haptic; `../feedback-contract.md` governs set feedback.

## Reordering

A drag needs both a keyboard alternative and a single-pointer alternative that does not require
dragging. Web handles are real buttons: activate to pick up, activate another handle to place,
activate the original to release, Escape to cancel. ArrowUp/ArrowDown move one place without
wrapping. Announce the resulting position once and keep focus with the moved row.

The handle names its row and place, for example `Move Back Squat, 2 of 3`; a held row adds
`picked up`, and destinations read `Place Back Squat at 3 of 3`. Web routines and Notes share
`rail.js`. Native lists use platform reordering and expose Move up/Move down where needed.
The Android routine editor supports continuous drag scrolling as well as accessible movement.

## Delete windows

Withheld means **not sent**. An offered Undo cannot depend on reversing a server deletion.
The following acts use the room's nine-second window without confirmation:

| Act | Consequence after the window |
|---|---|
| Delete set | Removes the set; leaves other set identities intact |
| Delete routine | Removes the routine and its proposals; performed workouts remain |
| Delete conversation | Removes the conversation; applied routine changes remain |
| Discard session | Removes the finished workout |
| Delete note | Removes the note |
| Delete weigh-in | Removes the reading |
| Discard unclaimed training | Removes Android's device-only shelf |

Each delete has an independent deadline. A second delete settles nothing; Undo restores the newest
held item, then offers the next. A restored row must start with fresh gesture state, so it cannot
replay a dismissal. Android swipe state uses `remember`, not `rememberSaveable` across row removal.

The transient belongs to the room and survives a pop, tab change or sheet dismissal. It names one
held item or counts several; it never names one item as though it represented the entire group.
It retires when the last hold closes. Sending offers no Undo and keeps the row hidden. A refusal
can temporarily replace the transient, then return to any remaining Undo.

Do not shift the rack or a commit button when the transient appears. Android's logger reserves
space at the ledger foot; other overlays must keep primary actions reachable. An open window is
not manually dismissible.

### Stored state and visible rows

A delete window decides which rows are drawn. Stored state decides limits, first-run behavior,
write positions and proposal verdicts. A visible row count follows the filtered rows; a claim about
the account follows stored data. In particular:

- A held note still consumes one of the account's ten slots. Do not seed an empty account or allow
  an eleventh note while a deletion is only held.
- A hidden routine is not evidence that the routine was removed or a proposal superseded.
- Once the server accepts deletion, remove it from stored reads as well as drawn rows.
- A deleted bodyweight row must not remove a new reading written during its hold.
- Reordering Notes includes withheld entries in the complete order sent to the server.
- Hiding Android's unclaimed shelf hides the entire row, including its claim action. Its transient
  says `Unclaimed training deleted — it was only on this phone.`

Failures restore the affected visible row when the write was actually refused. Device-first
writes instead report their local/pending state; they cannot claim the row remains on the device
when it has already been removed there. Preserve useful server reasons. Cross-surface refusal
wording remains in `../../consistency.md`.

### Leaving the room

Navigation within the room preserves holds. Leaving the foreground abandons in-memory holds:
restore rows and send nothing. Web uses document-hidden/unmount; Android uses stop/disposal;
iOS uses background/room departure. A send already in flight continues.

iOS set deletions are the durable exception: their deadline lives in `SetQueue` and survives
process death. Android holds deletion in memory, then queues the write when it settles. Its
in-memory hold is abandoned on backgrounding. Preserve this distinction until a deliberate
queue/durability change makes the two behaviors agree.

Unsaved drafts are a separate decision: no server delete exists to withhold. The cross-surface
routine-exit policy remains open under consistency entry 4k. Whether held session deletions filter
ranking and other room reads remains open under 4u.

## Row actions

- **Past-session set:** tap to fix, trailing swipe to delete. The fix sheet retains a visible
  Delete set action. Android declares accessible Delete. iOS set deletion does not full-swipe.
- **Routine:** trailing swipe to Delete, with an accessible path. Web's overflow offers Log past
  and Delete. No surface offers Duplicate. iOS routine deletion permits full swipe.
- **Conversation:** trailing swipe to Delete. A refreshed server list stays filtered by active holds.
- **Live logged set:** tap to fix. Logging sends immediately and offers no after-log Undo;
  Delete set from the fix sheet uses the normal delete window. No live-row swipe competes with
  movement paging.
- **Refusal notice:** swipe to dismiss with a declared accessibility action. This dismisses a
  notice, not stored data.
- **Log session:** long press offers Share this workout and Discard session. The session detail
  keeps a visible discard door. The finish receipt has no discard; the web live mirror has none.

## Workout paging

Horizontal movement changes belong to one native pager. Android's page follows the finger while
the rack stays fixed; cancellation restores the original movement and rack draft. Selection,
prefill and any deviation question change only after settling. Editing and logging are disabled
while the pager moves. A second move cannot overwrite a pending deviation question.

The head's Previous/Next controls and accessibility actions remain available. Vertical gestures
scroll the ledger. Do not add system-gesture exclusions; Back during a live workout stays in the
workout. On iOS, coordinate the room gesture with the shell's reserved leading edge.
Detailed Android arbitration and streaming behavior live in `../interaction-polish.md`.

## Other boundaries

- No swipe-to-turn-down on proposals and no horizontal tab paging competing with row actions.
- Compact Log charts open Record. Scrubbing/panning belongs to Record under `18-progress.md`;
  Bodyweight points are reached by tapping.
- Draft target-row deletion uses the draft's Cancel path; it is not a persisted-delete window.
- Keep sheets scrollable with the keyboard open so Save and Delete remain reachable.

## Open

Decide whether removing an unplanned movement mid-session needs Undo. The domain currently refuses
removal if it has recorded sets or belongs to the frozen plan.
