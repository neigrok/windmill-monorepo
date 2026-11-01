# The load floor holds on Coach Apply and on the server

**Status:** 🔨 Built on branch `qw-73-74`, awaiting review, e2e and the production deploy. Domain and backend; nothing visual changes.

**Context:** since task 57, the phones refuse a barbell or dumbbell load below 0 in set entry and in the routine editor. A Coach or MCP proposal can still land a −10 kg barbell target, because neither Apply nor the server checks the floor. No door may accept what a phone refuses.

**Current implementation**
- **Phones and web:** a proposal of either kind meets the editor's floor (`routine.loadFloor`, below 0) on its change lines when it is made and when it is applied: `ProposeRoutine`, `ApplyProposal`, `ProposeWorkout` and `ApplyWorkoutProposal` refuse at `changes.<i>.after.sets.<j>.weightKg` on each added line and each retargeted line whose sets changed; a kept line or a rest-only retarget keeps its loads. `ImportCoachRoutineBatch` floors every line it creates. Kotlin and Swift hold the change-line floor beside the editor's in `RoutineRules` (`Routines.kt`, `Routines.swift`); web holds it on `RoutineChange` (`proposals.js`) over `SetTarget.floored` (`routines.js`). The refusal copy each surface already maps for the editor ("Load, 0 or more.") answers a refused Apply.
- **Vectors:** `proposals-actions.json`, `workout-proposals-actions.json` and `coach-onboarding-actions.json`; the web carries no Coach onboarding import.
- **Server admission:** the backend (`backend/products/gym/sync/GymRules.cpp`), the JS reference and both model servers refuse `invalid` a routine create or entries change (so also `gym.applyProposal`'s write), a proposal create, a workout proposal create and `gym.applyWorkoutProposal` whose entry sets a scheme below the floor; a scheme the write keeps keeps what it held, and a lifter's own plan write is not floored. Loading resolves through `exerciseName`, the movement, then the seed (the seeds book carries `equipment` and `loadCount`). `packages/api-contract/sync/corpus/gym/admit.json` pins it; engine A.2 states it.
- **Server doors:** `createRoutine`, `propose` and `proposeWorkout` refuse before admitting (`belowFloor`, domain `firstBelowFloor`), and so do the MCP set doors `log_set`, `log_sets` and `import_session` (`movementBelowFloor`); the MCP tools answer naming the movement, the set and the 0 kg floor, and each refusal is one `gym.server_call` line with outcome `load-floor`, never a Sentry Issue. `POST /v1/gym/sessions/import` replays recorded history and takes no floor. `log_set` also refuses a set completed more than five minutes past the server's now (`clockAhead`, line outcome `clock-ahead`), as `log_sets` refuses a future one. Coach's server-hosted propose tools run through the same doors; the phone-hosted ones run the domain actions above.

**Change**
- ApplyProposal, and workout-proposal Apply, refuse a target below the movement's floor with the same refusal code the editor uses. This applies on all three surfaces.
- The server refuses the same write on every door, and both model servers follow. The doors are:
  - sync admission, for routine targets;
  - the MCP proposal tools;
  - Coach's propose tools.
- Add vectors to `proposals-actions.json`, and to the admission corpus for the server.

**Done when**
- The vectors pass everywhere, with nothing pending.
- On the local stack, an MCP `gym_propose_routine_change` with a −10 kg barbell target is refused. The refusal logs one line, not a Sentry Issue.
- The backend half ships through the production deploy. A backend push redeploys production, so plan it with the owner.

**Verification**
- The shared vectors and the admission corpus pass on Kotlin, Swift, web, the JS reference, both model servers and the backend (fakes and Postgres); the MCP door refusals and their `load-floor` line are covered by `GymToolsTest`, `GymRecordDoorTest` and `GymTrainingDoorTest`.
- Not yet run: the local-stack MCP `gym_propose_routine_change` check in Done when, and the production deploy.

**Depends on:** 57. Tree: `gym-load-floor-server-and-coach`.
