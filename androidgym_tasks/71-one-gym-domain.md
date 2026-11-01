# One gym domain: the last app-side rules move into :gym:domain, and the presentation package says what it is

**Status:** Steps 1–5 and 7 are built on branch `worktree-agent-ad18ab6c71e24e009`, not yet on main. Step 6, the package rename, waits for another branch to merge. It follows PR #43, which moved the receipt, record and last-time rules into `:gym:domain`.

**Current implementation**
- **Two packages share a name.** `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/` (package `works.windmill.gym.domain`) is now a presentation projection of `:gym:domain` (package `works.windmill.gym.domain.sync`). Same-named files exist in both: `Preferences.kt`, `Training.kt`, `Notes.kt`, `Bodyweight.kt`. `Units` is an enum in one and a `ChoiceSpec` String in the other.
- **Prefill:** `LiveLines` and the rack read the shared `Prefill` and `offeredLoads`; the `:gym` copy and `Scheme.straight` are gone. The shared `SetTarget.straight` compares loads on the ladder's grid, with a Prefill and an OfferedLoads vector on all three surfaces.
- **One form of "not read yet":** `TrainingStore.lastTimeOf` answers the shared `LastTime`, unread (`isUnread`, `isComplete == false`) until its read answers; `EngineTraining.lastTime` returns the shared read and no longer throws for an unread account.
- **Recovery:** the saved-copy checks (`SignedOutWorkout.importsUnchanged`, `SavedSets`) and stranded-set placement and steps (`StrandedSet`) live in `:gym:domain`; `store/WorkoutImports.kt` keeps the journal's I/O, its JSON merges and its state machine. `recovery-actions.json` is claimed.
- **Smaller reads:**
  - `MovementRecord.of` reads the shared `TrainingLog.recentDays` over the history the log holds; `TrainingHistory.record` serializes the same read.
  - `progressSeries` starts its twelve-week axis at the shared `MovementProgress.windowStart`. Its one-point-per-day choice stays in `:gym`: iOS plots every workout.
  - `LogTimeline` has no always-true filter.
- **Every surface:** the `lastTime`, last-sets and record documents list sets in logged order on Kotlin, Swift, web and the server, with vectors holding sets numbered out of logged order and unnumbered ones; the server's corpus test claims them. The web's Backfill reads the `lastTime` document; no iOS screen does.

**Change**
1. **Prefill:** replace the `:gym` copy with the shared read, `LiveLines` calls the shared `offeredLoads`, and the store keeps an unread last time as an incomplete `LastTime`. If the grid comparison is the correct rule, move it into the shared rule with vectors.
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
