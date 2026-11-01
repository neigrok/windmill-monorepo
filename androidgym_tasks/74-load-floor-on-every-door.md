# The load floor holds on Coach Apply and on the server

**Status:** Not started. Domain and backend; nothing visual changes.

**Context:** since task 57, the phones refuse a barbell or dumbbell load below 0 in set entry and in the routine editor. A Coach or MCP proposal can still land a −10 kg barbell target, because neither Apply nor the server checks the floor. No door may accept what a phone refuses.

**Current implementation**
- The floor holds in set entry, `SaveRoutinePlan` and adoption: Kotlin `TrainingActions.kt:39-44`, `Routines.kt:152`; Swift `TrainingActions.swift:76-84`, `Routines.swift:228`.
- No Proposals or WorkoutProposals code on Kotlin, Swift or web checks it.
- The backend accepts negative loads: `backend/products/gym/domain/Training.h:181`, `GymToolCatalog.cpp:99,325`.

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

**Depends on:** 57. Tree: `gym-load-floor-server-and-coach`.
