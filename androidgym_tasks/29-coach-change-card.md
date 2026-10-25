# The proposal card in the conversation, with a field diff (no review sheet)

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 08.2 a proposal pending: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-27854) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41150)
- 08.3 expanded in place: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28311) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41187)
- Components (Design System library, Android page):
  - `Android / Change row` `337:2686`: Kind = Changed, Added, Removed, Moved, Renamed, Note
  - `Android / Diff field` `337:2531`: State = Changed, Same, New, Gone
  - `Android / Button` `210:181`: Filled (Apply) and Tonal (Reject), 56 dp

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Under Coach's answer, `Minted` (`coach/AskScreen.kt:387-394`) draws `ProposalCard` (`ui/ReviewSheet.kt:498-507`), which is `CoachProposalCard` (`coach/CoachAnswer.kt:327-341`):
  - *Proposal · Push A*, the summary (*3 changes to Push A.*), the count (*3 changes*, plus * · still waiting*), and a *Review* row.
  - Under a pending card, `Ask.promise` (`coach/Ask.kt:202-203`, drawn at `coach/AskScreen.kt:391`): *Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal.*
- *Review* opens `ReviewSheet` (`ui/ReviewSheet.kt:82`, mounted at `GymRoom.kt:842`):
  - Rows *Add {m}* / *Remove {m}* / field moves *label · a → b* (`ui/ReviewSheet.kt:325-356`); kept runs *and N lines unchanged* (`domain/Proposal.kt:304-307`).
  - *Apply* / *Apply all N* (`domain/Proposal.kt:226-231`) stays at 40 % until the sheet is scrolled to the end (`ui/ReviewSheet.kt:446-457`), with *Scroll to the end to apply.* (`domain/Proposal.kt:265`) and the atomic line *All three or none. Nothing is applied until you tap.* (`:233-240`).
- **Bug:** a fresh proposal reads *This proposal is no longer available.* (`store/TrainingStore.kt:1763`). `AskScreen` reads each proposal once (`coach/AskScreen.kt:122-132`); if the replica does not hold it yet, the id goes into `missing` and is never read again until the screen is left and re-entered.

**Change**
- Delete the review sheet from Coach. The card is decided where it stands.
- Card: full reading width on the card surface, 20 dp radius, 1 dp outline, 16 dp padding.
- Header: eyebrow *CHANGES TO PUSH A* (12 Bold, accent) and a trailing *5 changes*. The count is the store's `changeCount`, never one the screen counts.
- Each change is an `Android / Change row` block with a divider between blocks:
  - a kind word with its icon (*Changed*, *Added*, *Removed* in the error role, *Moved*)
  - the movement name (16 Bold)
  - one `Android / Diff field` line per field, tabular digits
- A changed field reads `label  old → new`: old struck through in `inkDim`, new Bold in ink; an unchanged field is plain `inkDim`.
  - 08.2: *Changed · Bench Press · Sets 5 → 3 · Reps 5 → 3 · Load 82.5 kg → 90 kg*; *Added · Incline Dumbbell Press · Sets 3 · Reps 10 · Load 24 kg each*.
  - 08.3 adds *Removed · Cable Fly · Sets 3 · Reps 12 · Load 15 kg* (struck, title too), *Changed · Triceps Pushdown · Sets 3 · Reps 12 → 10 · Load 30 kg*, *Moved · Overhead Press · Order 4th → 2nd*.
  - An added block shows every value as new. Loads carry the load basis (*kg each*, *kg total*, *kg added*; 08).
- Unchanged movements fold into one dim line: *No change: 4 movements*.
- The first two blocks show. An M3 `TextButton` *Show all 5 changes* expands in place; *Show less* folds it.
- Buttons, stacked, full width, 56 dp: **Apply** (`Button`, primary) and **Reject** (`FilledTonalButton`). Nothing under them.
- Delete `Ask.promise`, `Proposal.applyHint`, `atomicLine`, `applyLabel`'s *Apply all N* and the *Review* row.
- Build the parts in `coach/ChangeCard.kt`: `ChangeCard`, `ChangeRow`, `DiffField`. Field lines come from the existing pure `works.windmill.gym.domain.sync.ProposalDiff` in `apps/android/gym/domain`; adapt the legacy UI model to its inputs and preserve `restSeconds`. Extend that formatter and its shared vectors where necessary rather than creating a second formatter in the app-layer `domain/Proposal.kt`. Tasks 30–35, 41, 42 and 44 reuse them.
- Fix the bug: a proposal id the replica does not hold yet is read again when the replica changes (key the read on the replica's revision, not on `missing`). Show nothing for it until it arrives; *This proposal is no longer available.* only for a proposal the log really dropped.
- Task 17 establishes the Routines row and its proposal-id/conversation-id navigation payload. This task owns activating that route: a conversation proposal opens its originating chat at the card; a connected-agent proposal without a conversation opens the same `ChangeCard` in the destination specified by 17. Remove `ui/ReviewSheet.kt` and its proposal-only `ConfirmDialog` use only after both routes and return navigation pass. Task 17 can land its list/chrome first; it does not depend on this task.

**Out of scope:**
- Decided states and Reject (30).
- Specific change kinds: rename and removal (31), movements (32), targets (33).
- A long card, failure and retry (34).
- The Routines proposal row (17).

**Done when**
- Screenshots of 08.2 and 08.3 match in Dark and Daylight on the emulator; the rig (01) adds `08.2-proposal-pending-dark` / `-light` and `08.3-proposal-expanded-dark` / `-light`. At the largest font both buttons stay reachable.
- A proposal minted in this turn shows its card without leaving the screen (a test in `coach/AskScreenTests.kt`).
- `gym_proposal_outcome` (`store/TrainingStore.kt:1000`) gains `screen: coach`; action `apply` stays. Expanding the card emits nothing. A decision emits one content-free event.
- `gym_screen_viewed` `proposal` goes with the sheet; the card is part of `coach`.
- Apply failures still report under `gym.applyProposal`.
- Tests to update: `ui/ReviewSheetTests.kt` (delete with the sheet), `coach/AskScreenTests.kt`, `coach/CoachAnswerTests.kt`, `domain/ProposalTests.kt` (UI adapter), `apps/android/gym/domain/src/test/kotlin/works/windmill/gym/domain/sync/CorpusTests.kt` (existing ChangeBlocks vectors), `store/TelemetryTests.kt`.

**Depends on:** 17, 28, 08.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`, `android-coach-fresh-proposal-unavailable`.
