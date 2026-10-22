# Proposal: add, remove, swap and move a movement

**Figma:**
- 08.17 add a movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37305) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41669)
- 08.18 remove a movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37338) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41684)
- 08.19 swap a movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37391) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41699)
- 08.20 move a movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-37434) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41716)
- Components: `Android / Change row` `1247:2908` (Added, Removed, Moved), `Android / Diff field` `1247:2753` (New, Gone, Changed).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The review sheet's `ChangeRow` (`ui/ReviewSheet.kt:325-356`) titles a row *Add {m}* or *Remove {m}* (`:330-331`):
  - added: *{target} · after {m}* or *{target} · first in the routine* (`:336-340`)
  - removed: *removed from the routine · 3 logged sets kept*, *… · never logged* (`domain/Proposal.kt:114-120`)
- Kinds are `Kept`, `Added`, `Removed`, `Retargeted` (`domain/Proposal.kt:81`). There is no move and no swap; a change carries only its new `position` (`:99`).

**Change**
- *Added* block: the name, then *Sets 3*, *Reps 15*, *Load 12.5 kg*, all as new values (08.17: *Add Face Pull to Pull A for your shoulders.* · *CHANGES TO PULL A* · *1 change*).
- *Removed* block: name and values struck and dim (08.18: *Upright Row · Sets 3 · Reps 12 · Load 30 kg*). Removed blocks list last. The logged-sets line goes.
- Swap (08.19): a *Removed* block (*Chin-up*, *Sets 3*, *Reps Max*), then an *Added* block (*Lat Pulldown*, *Sets 3*, *Reps 10*, *Load 45 kg*). Header *2 changes*. Copy: *Use Lat Pulldown instead of Chin-up until you can do 5 chin-ups.*
- *Moved* block (08.20): the name, then *Order ~~3rd~~ → 1st*. Copy: *Do Overhead Press first, when you are fresh.*
  - Derive the move in the domain by comparing each change's `position` with the routine's current order.
- Every card ends its blocks with *No change: N movements* when some movements are kept.
- Delete `addedLine`, `removedLine` and `compactLine` (`domain/Proposal.kt:106-131`) once the card no longer reads them.

**Out of scope:** target changes (33), the card shell (29).

**Done when**
- Screenshots of 08.17–08.20 match in Dark and Daylight on the emulator; the rig (01) adds `08.17-proposal-add-movement-dark` / `-light`, `08.18-proposal-remove-movement-dark` / `-light`, `08.19-proposal-swap-dark` / `-light`, `08.20-proposal-move-dark` / `-light`.
- A domain test covers a swap as removed + added, and a move as *Order 3rd → 1st*.
- `gym_proposal_outcome` still fires once per decision.
- Tests to update: `domain/ProposalTests.kt`.

**Depends on:** 29.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
