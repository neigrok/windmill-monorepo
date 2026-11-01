# Flaky tests fail fast and then stop failing

**Status:** Not started. Tests and build configuration; touches `backend/test/` for one case.

**Context:** a gate that fails at random teaches people to rerun red CI. Android CI on main failed on a docs-only commit (run 41267362434). A sync-engine test hung for 43 minutes before passing in 28 s. Several named tests fail now and then with no code change.

**Current implementation**
- No Gradle `Test` task sets a timeout. `app/build.gradle.kts:126` and `sync-engine/build.gradle.kts:41` set only properties and logging, so the workflow's 60/55-minute limits (`.github/workflows/android.yml:41,58`) are the only bound.
- Known flakes, none with a fix commit:
  - `CoachSetupTests.aPhoneDraftMovesIntoTheAccountWhenTheFirstPullCompletesWithoutRecreation`: `CoachSetupTests.kt:178`, run 41267362434.
  - `:sync-engine:testDebugUnitTest` hung under Robolectric. Only `AndroidSqliteTests` and `StorageLayoutTests` run under Robolectric in that module.
  - `OnboardingFlowTests.mainIntentWithoutLauncherCategoryNeverIntroducesAFreshDevice`: `app/…/OnboardingFlowTests.kt:273`, a 10 s `ComposeTimeoutException` in Release while the gym suites ran alongside.
  - `AccountRouteTests.sameOwnerVerificationChangesKeepRoutesBetweenAccountOpens` (`:264`) and `restoredOverviewKeepsItsRoutesAcrossDelayedStartupAuthentication` (`:222`), both on `StateRestorationTester` + `TemporaryFolder`, with an intermittent `NoSuchFileException` in saved-state restoration.
  - `HeldWeightLifecycleTests.aRefusedReleasedDeleteRestoresTheAuthoritativeRowAndKeepsItsNotice` (`:380`). It was rewritten by 595ddda5 and has not been confirmed since.
  - Backend `TurnServiceTest.cpp:489` `coach_turn_waiting_on_a_phone_holds_no_vendor_slot` segfaulted once in 19 runs.

**Change**
- Give every Android `Test` task a timeout (per test class through JUnit, and a task-level `timeout`) well under the workflow limit, so a hang fails in minutes with a thread dump.
- For each flake: reproduce it under load (repeat runs with `--rerun-tasks` beside a parallel suite), find the race or the wall-clock wait, and fix it with an injected clock and explicit steps. Compose tests wait for a condition, never a moment. Each fix carries a test that forces the race, as #45 did.
- Backend segfault: run `TurnServiceTest` under AddressSanitizer in a loop until it reproduces, then fix the lifetime it finds.
- If a flake cannot be reproduced after a fair attempt, record the attempt on its tree node and leave the test running. Do not mark it skipped.

**Done when**
- Each named test passes 50 consecutive loaded runs, or carries a recorded root cause and fix.
- A deliberately hung test fails the Android build within the new timeout.
- Ten consecutive main CI runs are green with no reruns.

**Depends on:** none. Tree: `flaky-tests-coach-turn-segfault-and-sync-engine-hang`.
