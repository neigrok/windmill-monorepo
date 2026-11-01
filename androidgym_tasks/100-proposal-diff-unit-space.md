# A proposal's load change spaces its unit like every other readout

**Status:** Waits for the owner: design brief item QW13. The owner froze Coach's action appearance for this release, diff blocks included, so this needs their word that a unit space falls outside the freeze.

**Figma:** the existing review sheet's boards. No new drawing is needed if the owner agrees.

**Context:** every Android readout writes a load with a space before its unit (*32.5 kg*), by the rule in ledger 11e. The proposal review sheet writes *30kg → 32.5kg* (ledger 11v).

**Current implementation**
- `Readout.targetWithUnit` joins "kg" with no space (`apps/android/gym/…/presentation/Readout.kt:48-49`).
- `ui/ReviewSheet.kt` uses it for the scheme move (`:393`) and for added and unchanged lines (`:357,380,389`), so a load change reads *3 × 8 · 30kg → 3 × 8 · 32.5kg*.

**Change**
- `targetWithUnit` puts a space before the unit and uses the equipment-aware unit, as `Readout.loadUnit` does.
- Remove the 11v *Proposal diff* line from the ledger in the same change.

**Done when**
- `ReviewSheet` tests read *30 kg → 32.5 kg*, and Coach's action cards are otherwise unchanged.

**Depends on:** 08, design brief QW13. Tree: `android-proposal-diff-unit-space`.
