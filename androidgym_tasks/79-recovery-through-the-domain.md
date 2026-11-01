# Signed-out workout recovery runs through the domain's actions

**Status:** Not started. A data migration for released phones; nothing visual changes.

**Context:** the 35 recovery vectors pass on `:gym:domain` code that Android users never run. The store still drives its own path over the `rack:legacyMigration` journal, so a rule fixed in the domain never reaches the phone.

**Current implementation**
- `WorkoutImports` journals under `journalPrefix = "rack:legacyMigration"` (`apps/android/gym/src/main/kotlin/works/windmill/gym/store/WorkoutImports.kt:908`).
- The domain's `AdoptWorkout`, `RecoverStrandedSets`, `DiscardSignedOutWorkout` and `ReconcileAdoptedWorkouts` actions and its `rack:adoption` key (`apps/android/gym/domain/…/WorkoutAdoption.kt:80`) have no production caller; only tests use them.
- A refused Retry already reports honestly: `RecoveryStore.kt:124-137` records `outcome=refused`.

**Change**
- The store calls the domain actions for adoption, stranded-set recovery, discard and reconciliation, and keeps only the I/O.
- On the first open of a build carrying this task, migrate `rack:legacyMigration` entries to `rack:adoption` once. Keep every pending item, its source and its refusal. If the migration fails, keep the old journal and report `gym.recovery_migration` to Sentry with no content.
- Delete the store's duplicate rules.

**Done when**
- A test installs a journal written by the current store and proves the migrated state round-trips: pending imports, refused items and kept sources.
- On the emulator:
  - install the current published release;
  - log a finished and an unfinished workout signed out;
  - upgrade in place and sign in.
  The workouts arrive as before, and *On this phone* still lists a refused one.
- `docs/ANDROID_OBSERVABILITY.md` lists the migration failure.

**Depends on:** 25. Tree: `android-recovery-retry-honesty`, after `android-recovery-vectors`.
