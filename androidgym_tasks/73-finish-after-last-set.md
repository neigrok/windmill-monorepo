# A finish never lands before the last set

**Status:** 🚀 On main and deployed to production (`5ce7b451`); verified on the local stack. Phones carry it from the next Android release after 0.14.1. A shared domain rule; nothing visual changes.

**Context:** after the device clock steps backwards, a workout can finish before its own last set. The receipt then shows the wrong duration, and a later correction is refused as `bad-instant`. Every surface runs the same `FinishSession`, so the fix is one rule with one vector.

**Current implementation**
- **Rule:** `FinishSession` with no `finishedAt` finishes at the later of now and the workout's last activity (its last `stored` set's `completedAt`, else its start), and `SessionRules.canFinishAt` refuses a finish before the start or the last set as `badInstant`. Kotlin `apps/android/gym/domain/…/sync/Training.kt` and `TrainingActions.kt`, Swift `GymDomain/Training.swift` and `TrainingActions.swift` (`SessionRules.finishAt`), web `web/src/products/gym/domain/training.js` and `trainingActions.js`.
- **Vectors:** `packages/api-contract/gym/domain/training-actions.json` covers a clock behind the last set, at it and past it, another workout's later set, a last set a held delete hides, an explicit `finishedAt` before and at the last set, and the `canFinishAt` bounds; every implementation claims them.
- **Server:** admission lands `gym.finish` at the later of its `finishedAt` and the session's last activity, its last alive set or else its start (backend `backend/products/gym/sync/GymRules.cpp`, the JS reference and both model servers), so a future `finishedAt` the engine clamps to server time never lands before a set, or a start, a clock ahead of the server stamped; it refuses only a landing at zero or before the start. The MCP `finish_session` door refuses an explicit `finishedAt` before the start or the last set as `bad-instant` (`GymTrainingDoor.cpp`), one `gym.server_call` line. `packages/api-contract/sync/corpus/gym/admit.json` pins the admission half.
- **Apps:** Android's finish (`store/WorkoutSession.kt`) and iOS's server-held finish (`WorkoutState.swift`) let the domain choose the instant rather than sending now; `TrainingFinishTests` finishes with the clock ten minutes behind the last set and reads the finish back at that set.

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

**Verification**
- The shared vectors and the admission corpus pass on Kotlin, Swift, web, the JS reference, both model servers and the backend (fakes and Postgres).
- Not yet run: the emulator check in Done when (a finish after the clock was set back, then the receipt and Fix set); `TrainingFinishTests` covers it at the store level.

**Depends on:** none. Tree: `gym-finish-after-last-set`.
