# One gym domain: the last app-side rules move into :gym:domain, and the presentation package says what it is

**Status:** Refactor plus shared-vector work. Not started. It follows PR #43, which moved the receipt, record and last-time rules into `:gym:domain`.

**Current implementation**
- **Two packages share a name.** `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/` (package `works.windmill.gym.domain`) is now a presentation projection of `:gym:domain` (package `works.windmill.gym.domain.sync`). Same-named files exist in both: `Preferences.kt`, `Training.kt`, `Notes.kt`, `Bodyweight.kt`. `Units` is an enum in one and a `ChoiceSpec` String in the other.
- **Prefill copy:** `Prefill` and `Scheme.straight` in the `:gym` `Training.kt` duplicate the shared `Prefill`, and they have drifted: the Android copy compares loads on the ladder's grid, the shared one compares raw values.
- **Recovery rules:** import and recovery rules live in `store/WorkoutImports.kt` (~1,100 lines), outside every vector. `recovery-actions.json` is listed as pending in `apps/android/README.md`.
- **Smaller reads:**
  - `MovementRecord.of` (the record page's recent days) still builds from `details()`; the shared `TrainingHistory.record` orders sets by `setNumber`, not by completion time.
  - `progressSeries` applies its own 12-week chart axis beside the shared `window`.
  - `LogTimeline`'s `workingSetCount > 0` filter is now always true.
- **Every surface:** the shared `TrainingHistory.lastTime` JSON document still orders sets by `setNumber ?? 0`, then id, on Kotlin, Swift and web. `setNumber` is null on every signed-out or unpushed set. PR #43 fixed the typed `LastSet` read but left this document. Check whether any iOS or web screen (the rack prefill, a "last time" line) reads it. If one does, it is the same user-visible bug on signed-out phones.

**Change**
1. **Prefill:** replace the `:gym` copy with the shared read. If the grid comparison is the correct rule, move it into the shared rule with vectors.
2. **Recovery:** move the import/recovery decisions into `:gym:domain`, claim `recovery-actions.json`, and keep only I/O in the store.
3. **Records:** `MovementRecord` reads `TrainingHistory.record`, and the shared rule orders a day's sets in logged order (`completedAt`, then id). Add vectors with unnumbered sets.
4. **Chart:** one chart axis, the shared `window`.
5. **Last time:** order the `lastTime` document in logged order on all three surfaces, and update the four vectors that pin the old order.
6. **Rename:** rename the `:gym` projection package to `works.windmill.gym.presentation` and drop the leftover REST `@Serializable`s that nothing decodes. Keep the ones `FinishedSession` saved-state decoding needs, with their `@SerialName`s.
7. **Filter:** delete the always-true `LogTimeline` filter.

**Done when**
- The shared corpus passes on Kotlin, Swift and web with the new cases, and no unclaimed file remains.
- Only presentation code is left in the projection package.
- A `grep` for rule-shaped code (e1RM, prefill, record ordering) outside `:gym:domain` comes up empty.

**Depends on:** none.
