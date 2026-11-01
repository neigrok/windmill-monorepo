# A finish never lands before the last set

**Status:** Not started. A shared domain rule; nothing visual changes.

**Context:** after the device clock steps backwards, a workout can finish before its own last set. The receipt then shows the wrong duration, and a later correction is refused as `bad-instant`. Every surface runs the same `FinishSession`, so the fix is one rule with one vector.

**Current implementation**
- `FinishSession` stamps `finishedAt ?: moment.now`, and `canFinishAt` checks it only against `startedAt`: Kotlin `apps/android/gym/domain/…/sync/TrainingActions.kt:85-86` and `Training.kt:111`, Swift `GymDomain/TrainingActions.swift:137`, web `web/src/products/gym/domain/trainingActions.js:104`.
- `packages/api-contract/gym/domain/training-actions.json` has no case for a finish before the last set.

**Change**
- A finish lands at the later of now and the workout's last activity (its last set's `completedAt`, else its start). This applies on Kotlin, Swift and web.
- Add vectors to `training-actions.json`:
  - a clock behind the last set;
  - a clock equal to it;
  - an explicit `finishedAt` before it, refused the way the start rule refuses.
- If the backend judges the same command, it holds the same rule (`backend/products/gym/domain`), and so do both model servers.

**Done when**
- The new vectors pass on all three surfaces and on the server, with nothing pending.
- On the emulator, a workout finished after the clock was set back shows its true duration on the receipt, and Fix set still accepts a correction.

**Depends on:** none. Tree: `gym-finish-after-last-set`.
