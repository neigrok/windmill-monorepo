# Gym owns its event schema; the observability doc is complete and checked

**Status:** Refactor plus docs. Implemented on its task branch; not yet on main.

**Current implementation**
- **Dependency rule:** `:platform` owns `EventSchema`, `LabelSchema` and `EventSchemas` (`platform/telemetry/Telemetry.kt`) and registers only its own events (`account_delete`, `ai_installation_outcome`). `:gym` registers `gym_action` (`GymActions`), its other bounded events and the `onboarding_` prefix in `gym/telemetry/GymEvents.kt`; the app hands `GymEvents.schemas` to `AndroidTelemetry`. The AI doors declare their expected 503s through `AiAvailability` instead of `:platform` naming their operations. `LayeringTests.platformSourcesHoldNoGymLabel` keeps gym labels out of `:platform`.
- **Doc:** `docs/ANDROID_OBSERVABILITY.md` is one reference: the failures table, the events table with allowed properties, and the gym_action table. It holds no per-task evidence.
- **Test:** `ObservabilityDocTests` (`:app`) collects failure-operation and event literals from `:app`, `:platform` and `:gym`, every registered event and label, and `GymActions`; it fails on a missing row, a row the code no longer names, or a gym_action table that differs from `GymActions`.

**Change**
- **Allowlist:** `:gym` registers its `gym_action` schema (screens, actions, outcomes) with `:platform`'s validator through an interface `:platform` owns. `:platform` keeps no gym names.
- **Doc:** make `docs/ANDROID_OBSERVABILITY.md` a complete current-state reference: one table of failure operations and one table of events with their allowed properties. Delete the evidence logs.
- **Test:** add a unit test that collects every `telemetry.failure("…")` and `event("…")` literal and every registered `gym_action` label, and fails when one is missing from the doc.

**Done when**
- `:platform` has no gym strings; the layering test enforces it if one fits.
- The doc test passes.
- The doc holds no per-task evidence.

**Depends on:** none.
