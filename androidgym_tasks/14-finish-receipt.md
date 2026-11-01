# Finish receipt, Ended early, Discard this workout?, and the first workout's Keep line

**Approved flow:** [Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) — 🚀 In production on main `ee70d13c`, human-approved 2026-10-25.

**Figma:**
- 03.7 Finish receipt: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32362) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34558)
- 03.8 Finish receipt, ended early: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32441) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34614)
- 03.14 Discard this workout?: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41920) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-41989)
- 03.15 Finish receipt, first workout, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42292) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-42368)
- Z.1 Zero-set finish: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49538) — 🚀 In production, human-approved 2026-10-25.
- Components (Design System library, Android page): `Android / Button` `210:181` (Tonal for Share with Coach; native top-end menu for Discard; Filled for Done; Filled · Tone=Error in the dialog).
- The approved Android revision above governs layout. The iOS receipt is behavioral context; do not copy an older bottom Discard row.

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/FinishScreen.kt` presents the committed duration, all-set count, equipment-aware volume, optional record and performed movements. The crowned tonal Share and filled Done actions stay below the scroll body; the native overflow owns Discard.
- `GymRoom.kt` opens the shared `ui/ConfirmDialog.kt` workout confirmation. The store owns a confirmed deletion and its outcome; cancellation keeps the saved workout. Weight Undo remains separate.
- `store/FinishReceipts.kt` records the first anonymous receipt on this phone. Keep opens ordinary sign-in. Share owns a separate saved request identity, waits for its matching sign-in completion and the account-data decision, and submits once through the owner-scoped Coach archive. A cancelled or superseded sign-in retires that Share intent. The saved exit phase resumes after recreation; an old queued snapshot reopens its original chat without duplicating an admitted request or a fresh-entry event.
- Restored receipts reconcile against the current local replica. Proven absence clears both receipt and workout detail and opens the root Log; an unread account replica waits for its first pull.
- The approved Z.1 terminal has only its ended-workout copy and Done to Routines.
- Paired installed-app captures, recreated Share admission, offline deletion, cold restart and later server removal pass. Native transport failures and bounded events reach their local collectors. Local durable-write failure retains the detail/error in deterministic tests; an actual native SQLite write failure and its discard Issue remain unverified because the external helper never acquired a lock.

**Change**
- 03.7, the approved Android receipt:
  - Title *Well done.*; subtitle *{routine} · {weekday, month day}*: *Push A · Thu, Oct 22*. *Workout saved* goes.
  - Three tiles: *52m* **Duration** · *5* **Working sets** · *2,455 kg* **Volume** (the unit at half size). The approved label **Working sets** counts every logged set under 06; it must not retain a kind filter.
  - The personal record card as today (*Personal record* / *Bench Press e1RM 101.3 kg — past 95 from Fri 9 Oct.*).
  - Head **Performed**, then each movement and its sets in the performed form: *Bench Press* / *3 × 6–8 · 75–80 kg*, *Incline Dumbbell Press* / *1 × 10 · 24 kg each* (units from 08).
  - Delete the *Against plan* / *Against last* block from the receipt, and the Coach line.
  - Keep the receipt readable, with two principal actions in thumb reach: **Share with Coach** and **Done**, each 56 dp with 12 dp separation. Share retains the separate approved 24 dp gold crown icon and its label in both appearances; do not substitute a tiny inline emoji. The actions must not consume half the phone or crowd the receipt.
  - **Discard** is in a native top-end 48 dp overflow menu (`MoreVert`), followed by the one confirmation below. It does not sit in the bottom action group. Cover normal, early and first signed-out receipts with the same action hierarchy.
  - **Done** closes the sheet onto the workout detail. **Share with Coach** sends *Check my last workout.* (`FinishCoach.question`, the iOS words in `WorkoutState.swift:724`) through the same path as today.
- 03.8, ended early: *Ended early.* / *Push A · Thu, Oct 22*, tiles *9m* · *2* · *960 kg*, **Performed** · *Bench Press* / *2 × 8 · 60 kg*, and the same two actions plus top-end overflow.
- 03.14: overflow → **Discard** opens an M3 `AlertDialog`: *Discard this workout?* / *This deletes the workout and its 2 sets. You can’t undo this.* (*This deletes the workout and its {n} sets. You can’t undo this.*) / **Cancel** · **Discard** (error role).
  - On **Discard** the workout is deleted at once and the room opens The log. No hold, no Undo (05).
  - The workout detail's **Discard workout** (23), the log row swipe (22) and Inspect's ⋮ (25) use this same dialog and these words. Put the dialog and its sentence in one place (e.g. `ui/ConfirmDialog.kt`, the file the 05.14 caption names).
- 03.15, the first finished workout while signed out: 03.7 without the record card, and one line under the tiles, *Only on this phone · Keep it* (*Keep it* bold, accent).
  - **Keep it** opens the sign-in step (Shell · Android 15a, task 27).
  - Shown only on the receipt of the first finished workout on this phone while signed out; a once-only flag on this phone records that it was shown. Later receipts never show it, and ordinary training screens have no standing sign-up prompt (17/27). Preserve user-invoked account sign-in, signed-out Share with Coach and account-required Coach routes, including the bound-installation stance in 36/38.
  - Signed out, **Share with Coach** is drawn as well. Follow iOS (`apps/ios/App/Sources/Gym/GymRoom.swift:205`): it opens the sign-in step, and the question is sent once the lifter is signed in. Where this Windmill has no Coach it is not drawn, as today.
- A workout with no set uses the [approved Z.1 terminal surface](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458): *No sets logged* / *This workout has ended.* / **Done** → Routines. It has no saved-workout claim, totals, celebration, sign-in offer or Share with Coach. Design prerequisite `android-gym-empty-finish-design` is human-approved 2026-10-25; the terminal implementation is included here.
- Remove only the workout hold caller; retain `store/WithheldDelete.kt` and weight Undo as specified by 05/24.

**Out of scope:** the log row swipe (22); workout detail and its comparison (23); *Save a routine* (13); Inspect (25).

**Done when**
- Screenshots of 03.7, 03.8, 03.14 and 03.15 match in Dark and Daylight; the rig (01) adds `03.7-finish-receipt-dark/light`, `03.8-ended-early-dark/light`, `03.14-discard-dialog-dark/light`, `03.15-first-workout-signed-out-dark/light`.
- `gym_session_finished` still fires; Share with Coach still emits `gym_ask_started` when the question is sent.
- `gym_action` with `screen` `finish`: `action` `discard` with `state` `shown` when the dialog opens, then `outcome` `ok` / `cancelled` / `refused` / `failed`; `action` `keep` with `outcome` `ok` when **Keep it** opens the sign-in step; `action` `done`. Unexpected discard failures report under `gym.discard`. List the actions in `docs/ANDROID_OBSERVABILITY.md`.
- A test proves the Keep line shows on the first signed-out receipt only: not on the second, not signed in. Dark/Daylight, small phones and large text keep the receipt readable, crown legible, overflow reachable and both main actions visible/reachable without overlap. Overflow Cancel and discard Cancel preserve the saved workout; repeated confirmation cannot delete twice.
- Tests: `FinishSheetTests.kt`, `ui/FinishScreenTests.kt`, `ui/FinishLayoutTests.kt` and `ui/SessionDiscardTests.kt` assert the tiles, crowned two-action group, native top-end menu, single confirmation and an immediate confirmed workout discard; `presentation/TrainingTests.kt` covers the empty finish; `store/TrainingFinishTests.kt` passes.

**Depends on:** 04, 05, 06, 08, 13.

**Ledger:** 12d, 12f, 12g, 9z, 11b, 11c; dogfood `android-gym-target-page`, `android-empty-workout-finish`.
