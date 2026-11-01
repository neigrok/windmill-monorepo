# Proposal: rename a routine, remove a routine

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 08.15 rename a routine: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37242) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41642)
- 08.16 remove a routine: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37272) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41657)
- Components: `Android / Change row` `337:2686` (Renamed, Removed), `Android / Diff field` `337:2531`, `Android / Button` `210:181` (Filled · Tone=Error, Tonal).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Rename: a separate *Routine name* card with a move line *Push A → Push Day* after the movement rows (`ui/ReviewSheet.kt:254-257`), shown when `renames` is true (`presentation/Proposal.kt:193`).
- Removal:
  - The sheet draws *Remove Arms* / *The whole routine is removed from your program. Every set you logged against it stays in the log.* (`ui/ReviewSheet.kt:241-246`).
  - The card's summary reads *A proposal to remove Arms.* (`presentation/Proposal.kt:207`) and its count *a removal* (`:213`).
  - The apply button reads *Remove Arms* on the accent (`presentation/Proposal.kt:228`).
  - The receipt reads *Applied · Arms · routine removed* (`presentation/Proposal.kt:184`).

**Change**
- Rename (08.15):
  - A *Renamed* block with no movement line and one field: *Name ~~Push A~~ → Push Day*.
  - It comes first, before movement blocks. Then *No change: 5 movements*.
  - Header *CHANGES TO PUSH A* · *1 change*.
  - Coach copy on the board: *Here is a better name for Push A.*
- Removal (08.16):
  - Eyebrow *REMOVE A ROUTINE*, with no count.
  - One *Removed* block: *Arms* struck, *Movements 4*, *Last done Aug 24* (struck, dim). Read the movement count from the routine and the date from the log.
  - Buttons: **Remove routine**, a 56 dp primary `Button` in the error role (02), then **Reject** (tonal).
  - Coach copy on the board: *You have not done Arms in 8 weeks. You can remove it.*
  - Applied, the card reads with 30's word: check + *Removed · Arms*.
- Delete `summaryLine`'s *A proposal to remove …*, `counted`'s *a removal* and `applyLabel`'s *Remove {routine}* once the card replaces them.

**Out of scope:** the card shell (29), decided states (30).

**Done when**
- Screenshots of 08.15 and 08.16 match in Dark and Daylight on the emulator; the rig (01) adds `08.15-proposal-rename-dark` / `-light` and `08.16-proposal-remove-routine-dark` / `-light`.
- **Remove routine** emits `gym_proposal_outcome` `{screen: coach, action: apply}`; **Reject** emits action `reject` (30).
- `gym_proposal_receipt_shown` `{outcome: applied}` still fires once the removal receipt is acknowledged; a failed acknowledgment still reports under `gym.proposal_receipt_shown`.
- Tests to update: `presentation/ProposalTests.kt` (rename block first, removal block), `coach/AskScreenTests.kt`, `store/RemovalReceiptTests.kt`.

**Depends on:** 29, 30, 02.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
