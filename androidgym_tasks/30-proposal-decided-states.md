# Proposal decided states: Applied, Rejected, Out of date, two proposals

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 08.12 applied: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30728) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41404)
- 08.13 rejected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30875) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41438)
- 08.14 out of date: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-30957) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41464)
- 08.28 two proposals, one decided, one open: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38117) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41848)
- Components: `Android / Change row` `337:2686`, `Android / Diff field` `337:2531`, `Android / Button` `210:181`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- After a decision, `ReceiptLine` (`coach/AskScreen.kt:378-384`) draws the receipt under the unchanged card: *Applied · Push A · 3 changes* in bold accent on `surface` (`domain/Proposal.kt:181-189`).
- A turned-down proposal reads *Turned down · nothing changed.* (`domain/Proposal.kt:267`), and with a date *Turned down {day} at {time}. Nothing changed.* (`:249`).
- Out of date: *{routine} changed after this was written, so it was set aside {on}. None of it was applied.* (`domain/Proposal.kt:251`), and in the sheet *This routine has changed since the proposal was written, so it can no longer be applied — nothing here was. What the routine now says is what stands.* (`ui/ReviewSheet.kt:273-274`).
- *Turn this down* (`ui/ReviewSheet.kt:491`) opens `ConfirmDialog` (`:434-438`): *Turn this down?* / *Nothing changes.* / **Turn down** (brick) · **Keep it** (`domain/Proposal.kt:271-274`, `ui/ConfirmDialog.kt:22`).
- History and thread outcomes say *turned down*, *set aside* and *superseded* (`coach/Thread.kt:53-54`, `:77-79`, `:88-90`).
- The store calls it dismiss: `dismissProposal` (`store/TrainingStore.kt:972`), failure op `gym.dismissProposal` (`:985`), event action `dismiss` (`:989`).

**Change**
- **Reject** settles without a confirmation dialog only while no Apply/Reject command is unresolved. Persist its decision identity and reconcile the result; a timeout is not a settled rejection. Task 34 owns unknown outcomes and disables contradictory decisions. Delete the confirmation dialog and its four strings.
- Applied (08.12):
  - The card drops its buttons and its outline.
  - Header: a check icon + *Applied · Push A*, with *5 changes* trailing.
  - The same first two blocks stay as a record, with *Show all 5 changes*. Their before/after order comes from the immutable proposal history contract in 32; never reconstruct it from the routine after Apply.
  - The Apply button turns into this header; one `saved` haptic (`ui/GymHaptics.kt`).
- Rejected (08.13): the card folds to one `inkDim` line, a close icon + *Rejected · Push A.*
- Out of date (08.14):
  - Eyebrow *CHANGES TO PUSH A · OUT OF DATE* in `inkDim`.
  - Blocks at 50 %, *Show all 5 changes*, no buttons.
  - Line: *Push A changed after this suggestion. Nothing was applied.*
- Two proposals (08.28): the older applied card stays above as a record. Only the newest open card has buttons. Copy: *And Pull A?* · *Do Barbell Row first, when you are fresh.* · *CHANGES TO PULL A* · *1 change* · *Moved · Barbell Row · Order 2nd → 1st* · *No change: 4 movements*.
- One word table for settled proposals, used here, in History (37) and in the Routines row (17): *Applied*, *Rejected*, *Out of date*, and *Removed* for an applied removal.
  - Rewrite `coach/Thread.kt` outcomes to it; delete *turned down*, *set aside* and *superseded* from screen copy.
  - Delete `turnedDownReceipt`, `settledNote`'s sentences and `ReceiptLine`.
- Rename in code: `dismissProposal` → `rejectProposal`; the wire state `dismissed` stays.

**Out of scope:**
- The card's pending form (29).
- Removal wording on the card (31).
- Failure and retry (34).
- The History list (37).

**Done when**
- Screenshots of 08.12, 08.13, 08.14 and 08.28 match in Dark and Daylight on the emulator; the rig (01) adds `08.12-proposal-applied-dark` / `-light`, `08.13-proposal-rejected-dark` / `-light`, `08.14-proposal-out-of-date-dark` / `-light`, `08.28-two-proposals-dark` / `-light`.
- `gym_proposal_outcome` action `reject` replaces `dismiss`; outcomes stay `decided`, `moved`, `gone`, `settled`, `failed`. Update the row in `docs/ANDROID_OBSERVABILITY.md`.
- A failed reject reports under `gym.rejectProposal` (replaces `gym.dismissProposal`).
- `gym_proposal_receipt_shown` still fires for a visible removal receipt.
- Reopen an applied proposal after restart and from another device: its retained change blocks remain truthful; an older record without order evidence does not invent a previous position.
- Tests to update: `domain/ProposalTests.kt`, `coach/ThreadTests.kt`, `coach/AskScreenTests.kt`, `store/TelemetryTests.kt`, `store/RemovalReceiptTests.kt`.

**Depends on:** 29.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
