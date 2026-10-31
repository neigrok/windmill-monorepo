# Gym owns its event schema; the observability doc is complete and checked

**Status:** Refactor plus docs. Not started.

**Current implementation**
- **Dependency rule:** `platform/.../telemetry/Telemetry.kt` hard-codes the `gym_action` allowlist (`workout_bar`, `bodyweight` `calendar_open`, `routine_editor`, `movement_form`, `record`, `tile`, …). Every new gym action has to edit `:platform`, which breaks the rule in `STRUCTURE.md`: platform is product-neutral.
- **Failure operations:** about 30 of the roughly 85 static failure operations in code appear nowhere in `docs/ANDROID_OBSERVABILITY.md`. Examples: `gym.savePreferences`, `gym.weighIn`, `gym.readNotes`, `gym.readProgram`, `gym.revokeShare`, `gym.restoreNavigation`, `gym.restoreFinishedSession`, `gym.workoutClock`, `session_decode`, `session_migrate`, `telemetry_persist`, `telemetry_restore`, `application_coroutine`.
- **Product events table:** partial; the rest is scattered over per-task prose.
- **Evidence logs:** the doc carries per-task verification records ("Task 18's final local Save window receives 22 bounded intake events…", "Task 51's current-source local intake contains 17…", "Installed 03/17 acceptance records nine…", the "local native recipe delivers four…" sections). AGENTS.md says docs record current state only, and the README says such evidence belongs in the task report.

**Change**
- **Allowlist:** `:gym` registers its `gym_action` schema (screens, actions, outcomes) with `:platform`'s validator through an interface `:platform` owns. `:platform` keeps no gym names.
- **Doc:** make `docs/ANDROID_OBSERVABILITY.md` a complete current-state reference: one table of failure operations and one table of events with their allowed properties. Delete the evidence logs.
- **Test:** add a unit test that collects every `telemetry.failure("…")` and `event("…")` literal and every registered `gym_action` label, and fails when one is missing from the doc.

**Done when**
- `:platform` has no gym strings; the layering test enforces it if one fits.
- The doc test passes.
- The doc holds no per-task evidence.

**Depends on:** none.
