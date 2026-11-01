# Proposal: sets, reps and load; vary by set; ramp up; rest and a first target

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 08.21 sets, reps and load: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37543) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41731)
- 08.22 vary by set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37592) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41750)
- 08.23 ramp up: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37639) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41765)
- 08.24 rest and a first target: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37684) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41780)
- Components: `Android / Change row` `337:2686` (Changed), `Android / Diff field` `337:2531` (Changed, Same, New).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `Proposal.moves` (`presentation/Proposal.kt:282-292`) returns one move per change:
  - one set moved: *set 4 · 100 × 1 → 102.5 × 1*
  - anything else: both schemes in the readout formula under the label *sets* (`:277`)
- The sheet unfolds a scheme move on tap to two ladders (`SchemeMove`, `ui/ReviewSheet.kt:363`).
- Missing reps read *max* and no sets read *open* (`presentation/Readout.kt:33-35`).
- `ProposalTargets` holds only `sets` (`presentation/Proposal.kt:75-77`). The server's targets also carry `restSeconds` (`backend/products/gym/domain/Proposal.h:70`); Android drops it.

**Change**
- While every set is the same before and after, show *Sets*, *Reps* and *Load* lines (08.21):
  - *Bench Press · Sets ~~3~~ → 4 · Reps ~~8~~ → 6 · Load ~~80 kg~~ → 85 kg*
  - *Push-up · Reps ~~15~~ → Max*: missing reps read *Max*.
  - *Dips · Load ~~10 kg added~~ → Last time*: missing load reads *Last time*.
- Once sets differ, one line per set (08.22): *Set 1  5 × 80 kg* (plain), *Set 3  ~~5 × 80 kg~~ → 3 × 90 kg*.
- Ramp up (08.23): *Set 1  ~~5 × 100 kg~~ → 5 × 80 kg*, *Set 2  ~~5 × 100 kg~~ → 5 × 90 kg*, *Set 3  5 × 100 kg*, and an added set as new: *Set 4  3 × 105 kg*. A dropped set is struck. Header *CHANGES TO LEGS*.
- Open to numbers (08.24): *Target ~~None~~ → 3 × 10*. Rest: *Rest ~~90 s~~ → 2 min*.
  - Add `restSeconds` to `ProposalTargets` so the card can read it.
- Loads carry the load basis (*kg each*, *kg total*, *kg added*; 08).
- Reuse the existing pure `ProposalDiff.fields` in `apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/ProposalDiff.kt`. The shared formatter and ChangeBlocks vectors already cover uniform, varied, ramp, open, rest, Max and Last time; this task wires the UI adapter and adds missing equipment-basis cases. Do not create a second formatter in the legacy app-layer `presentation/Proposal.kt`. Delete `moves`, `FieldMove` and the sheet's `SchemeMove` only after every consumer uses the domain result.
- Preserve/extend `packages/api-contract/gym/domain/proposals-actions.json` and its cross-surface runners. The legacy `ProposalTargets` adapter must carry the `restSeconds` already held by the sync domain.

**Out of scope:** the card shell (29), movement changes (32).

**Done when**
- Screenshots of 08.21–08.24 match in Dark and Daylight on the emulator; the rig (01) adds `08.21-proposal-sets-reps-load-dark` / `-light`, `08.22-proposal-vary-by-set-dark` / `-light`, `08.23-proposal-ramp-up-dark` / `-light`, `08.24-proposal-rest-target-dark` / `-light`.
- The existing ChangeBlocks vectors pass through the Android domain `CorpusTests` runner, and UI adapter tests assert complete field lines including rest and equipment basis.
- `gym_proposal_outcome` still fires once per decision; no target value in any event.

**Depends on:** 29, 08.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
