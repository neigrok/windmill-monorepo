# Android design delivery

## Objective

Deliver the approved Gym Android mockups into the Kotlin/Compose app. Implement in waves, refactor
and verify after each wave, complete a final code-simplification wave, then publish a GitHub release
with an installable APK. The approved design omits set Kind and sound/haptic set confirmation.

Design sources: [Screens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=56-2),
[Components](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-3),
[Specifications](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9987),
and `docs/design/gym/android-refactor.md`. The reference contains 90 screen states; implementation
must cover the real state transitions and data, not hardcoded copies of the example phones.

## Delivery plan

| Wave | Delivery | Refactoring boundary | Status |
|---|---|---|---|
| 0 | Baseline build, runtime setup, design-to-code inventory and coverage map | Identify existing shared controls and state ownership | Verified |
| 1 | Shared visual foundations, Instrument/Daylight palette propagation, 48 dp targets, Routines/Log/Coach navigation, Settings, removal of Kind controls and set-confirmation sound/vibration | Consolidate native chrome, typography, action and settings patterns; include account-sheet palette and system-bar contrast | Pending |
| 2 | Routines: list/detail/create/edit, targets/fill, duplicate/delete/Undo, stale-edit protection; Create movement from planning and quick logging | Share movement creation and target-entry behavior; preserve the draft and originally read revision on refusal | Pending |
| 3 | Planned/free workout logging, rest count-up, assembly, numeric entry, refusal/offline states, finish receipts, correction, sharing and save as routine | Consolidate session presentation and truthful receipt/readback data | Pending |
| 4 | Log history, movement records/rename, bodyweight entry/correction, pagination and empty states | Share record rows and coherent loading/error/empty states | Pending |
| 5 | Coach conversation/history/read receipts, Notes, review/apply/turn down, account/sign-in/connected log | Consolidate support-screen structure and preserve state across navigation | Pending |
| 6 | Native transitions and feedback, ongoing notification/Live Update capability and fallback, keyboard/back/insets, both themes, accessibility and end-to-end coverage | Keep workout commands and the single queue owner in `:gym`; only product-neutral adapters belong in `:platform` | Pending |
| 7 | Final app-wide refactoring and code simplification, complete coverage audit and release validation | Remove dead paths and duplicate controls; verify dependency direction | Pending |
| Release | Versioned GitHub release with tested APK and accurate release notes | Verify published tag, CI result, asset and signing identity | Pending |

The [delivery contract](docs/design/gym/android-delivery.md) maps all 90 unique Figma states to
waves, with local copies of the six exported icons needed for implementation. Every retained
screen state must have an implementation path and verification evidence before release. Specifications
also require coverage where no separate phone is drawn: independent Undo windows, Coach allowance,
pending and failure states, note UTF-8 limits, account failures, seven-day bodyweight gaps,
classification-safe correction, and notification action replay.

## Wave gate

Each implementation wave ends with an adversarial diff review, one fix/refactoring pass, relevant
unit/Compose checks, a build and a local-stack/emulator journey covering the changed behavior.
Use representative emulator/native-graphics screenshot comparisons and 200% font checks for affected
layouts; legacy Compose tests alone do not establish visual fidelity. Record exact commands,
results and limitations below. Commit and push only after the wave's gate.
Broaden tests when a change touches shared behavior or a failure reveals an unresolved concern.

Never alter historical set classification or discard persisted preferences merely because their UI
is removed. Preserve wire compatibility and stored data while removing the unwanted controls and
set-save effects. No changes to iOS or web are implied by these Android mockups.

## Wave 1 ownership contract

- Foundation/navigation: `GymRoom.kt`, `ui/GymSkin.kt`, `GymMaterial.kt`, `GymScreen.kt`, their
  navigation/theme tests, and the product-neutral `platform/design/Tokens.kt` action minimum if needed.
- Settings/removal: `ui/SettingsScreen.kt`, `LoggerScreen.kt`, `FixSheet.kt`, `GymConfirm.kt`,
  `GymSound.kt` and their matching UI tests. Keep the shared `GymHaptics` vocabulary for other
  gestures and non-set saves. Do not change `GymRoom` from this workstream.
- Keep existing public call shapes compatible while shared controls evolve. New logs use the
  existing Working default; correcting a historic set preserves its original kind and sends no
  classification diff. Retain preference wire fields because settings PUT replaces the document.
- Start implementation from the delivery contract's current Figma contexts and local icon sources;
  fetch the relevant node context before coding each feature. Root owns this log and publication.

## Working state

- Implementation worktree: `/private/tmp/windmill-android-design-waves`.
- Branch: `codex/android-design-waves`, based on published `c31e815448fef6dd4f4db3bbc292478362164df6`.
- Primary checkout `/Users/vs/Desktop/windmill` has unrelated edits and remains untouched.
- JDK: `/Users/vs/.gradle/jdks/eclipse_adoptium-21-aarch64-os_x.2/jdk-21.0.7+6/Contents/Home`.
- SDK: `/Users/vs/Library/Android/sdk`. GitHub authentication and adb work with the required host
  access. The existing emulator and other agents' local servers are preserved.
- Authoritative verification uses backend 8089, Vite 5177 and fresh emulator `emulator-5556`.
  Database `windmill_android_waves` and emulator data under `/private/tmp/windmill-android-runtime`
  are isolated from the existing services and device. App API override: `http://10.0.2.2:8089`.

## Implementation log

### Wave 0 — inventory and baseline

- Read the repository structure, Android build/release configuration and approved design handoff.
- Loaded Figma design-to-code and Windmill local-stack verification guidance.
- Fetched current remote main and created the isolated implementation worktree.
- Assigned independent design coverage, code dependency mapping and runtime/build preflight.
- Baseline `./gradlew build` succeeded in 2m 2s: 298 tasks. For each debug/release variant, gym
  reports 977 tests with 12 live-wire skips, and platform reports 55 with no skips; 1,020 tests
  executed successfully per variant. No failures or errors. Log:
  `/private/tmp/windmill-android-baseline-build.log`.
- Enabled live-wire tests exposed two stale expectations: routine detail includes creation history,
  and the offline copy uses a curly apostrophe. Updated only those assertions. The review/fix pass
  uses the raw GET timestamp and full expected event shape, then verifies the same detail after an
  idempotent replace; it does not assume client/server clock alignment.
- Post-fix `./gradlew build` passed in 40s with the same full-suite counts and no failures.
  A fresh local account then ran the 12 enabled live-wire cases with `--rerun-tasks`: 12 passed,
  zero errors/failures/skips, 46/46 tasks executed. Evidence:
  `/private/tmp/windmill-android-live-wire-final.xml`.
- Identified a clean Wave 1 split: foundation/navigation files and feature-removal/settings files
  have no overlapping ownership. Historical `TrainingSet.kind` and whole-document preferences
  remain serialized; the unwanted UI and save effects can be removed independently.
- Adversarial plan review added explicit Daylight, stale-edit, rest-count-up, specification-only
  behavior and visual-fidelity gates. A notification action must reuse the existing queue owner,
  never open a second writer for the same files.
- Release readiness: GitHub access works. Published 0.7.0 and 0.7.1 APKs use different debug
  certificates; no retained Android signing secrets are configured. A release must not claim
  compatibility with an existing installation without checking its signing identity.
- Built and started the isolated backend and frontend. CORS for 5177 → 8089 returned 204 with
  matching origin and credentials. A fresh API 34 emulator installed and cold-launched the local
  APK in 1,608 ms. Screenshot `/private/tmp/windmill-android-baseline.png` and hierarchy
  `/private/tmp/windmill-android-baseline-ui.xml` show the existing Routines empty state.
- Verified 90 distinct design-map IDs, wave totals 4/28/27/8/20/3, and six valid, nonempty exact
  SVG assets. Expiring asset URLs are replaced by repository-relative source links.

## Structure observations

- Products depend on `:platform`; `:platform` must remain product-neutral.
- The existing app already separates domain, store, network and Compose UI. Waves should reuse its
  working offline/claim behavior and replace presentation seams instead of cloning the application.
- Figma screen count is a coverage index, not a target for the number of composables or routes.

## Completion audit

- [ ] All 90 approved states and specification-only contracts mapped to implemented behavior and inspected evidence.
- [ ] Every implementation wave refactored, reviewed, verified and published.
- [ ] Kind controls and sound/haptic set confirmation absent from the app, with historical data preserved.
- [ ] Local and signed-in journeys, offline recovery, partial receipts and account boundaries verified.
- [ ] Native font scaling, back/keyboard/insets, accessibility and notification behavior verified.
- [ ] Final simplification wave completed with regression checks.
- [ ] Release APK built and installed; version/signature checked.
- [ ] GitHub release, tag, successful CI and downloadable APK verified.
