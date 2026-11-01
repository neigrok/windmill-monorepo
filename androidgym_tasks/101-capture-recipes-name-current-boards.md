# The capture recipes name the workout page's current boards

**Status:** Not started. Tooling only; nothing visual changes.

**Context:** c8e96310 deleted boards 05.3, 05.4, 05.5, 05.13 and 05.14 and replaced them with their *b* revisions. The task files and the ledger were updated; three capture recipes still name the deleted boards, so the rig's manifest points at frames that no longer exist.

**Current implementation** (paths under `apps/android/tools/capture-recipes/`)
- `workout-detail.json:3,131,151` names 05.3 and 05.14.
- `deletion-lifecycle.json:158` names 05.4.
- `colour-roles.json:24,34` names 05.5 and 05.13.

**Change**
- Point them at:
  - 05.3b (Dark `1782:26943`, Daylight `1782:27019`);
  - 05.14b (`1793:27005`, `1793:27113`);
  - 05.4b (`1793:27226`, `1793:27317`);
  - 05.5b (`1793:27413`, `1793:27501`);
  - 05.13b (`1793:27594`, `1793:27683`).
- Re-run the three recipes and compare them with the *b* boards.

**Done when**
- `grep` finds no deleted board number in the recipes, and the three recipes capture cleanly against the *b* boards in Dark and Daylight.

**Depends on:** 23. Tree: `android-capture-recipes-b-boards`.
