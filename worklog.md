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
| 1 | Shared visual foundations, Instrument/Daylight palette propagation, 48 dp targets, Routines/Log/Coach navigation, Settings, removal of Kind controls and set-confirmation sound/vibration | Consolidate native chrome, typography, action and settings patterns; include account-sheet palette and system-bar contrast | Verified |
| 2 | Routines: list/detail/create/edit, targets/fill, duplicate/delete/Undo, stale-edit protection; Create movement from planning and quick logging | Share movement creation and target-entry behavior; preserve the draft and originally read revision on refusal | Pending |
| 3 | Planned/free workout logging, rest count-up, assembly, numeric entry, refusal/offline states, finish receipts, correction, sharing and save as routine | Consolidate session presentation and truthful receipt/readback data | Pending |
| 4 | Log history, movement records/rename, bodyweight entry/correction, pagination and empty states | Share record rows and coherent loading/error/empty states | Pending |
| 5 | Coach conversation/history/read receipts, Notes, review/apply/turn down, account/sign-in/connected log | Consolidate support-screen structure and preserve state across navigation | Pending |
| 6 | Native transitions and feedback, ongoing notification/Live Update capability and fallback, keyboard/back/insets, both themes, accessibility and end-to-end coverage | Keep workout commands and the single queue owner in `:gym`; only product-neutral adapters belong in `:platform` | Pending |
| 7 | Final app-wide refactoring and code simplification, complete coverage audit and release validation | Remove dead paths and duplicate controls; verify dependency direction | Pending |
| Release | Versioned GitHub release with tested APK and accurate release notes | Verify published tag, CI result, asset and signing identity | Pending |

The [delivery contract](docs/design/gym/android-delivery.md) maps all 90 unique Figma states to
waves, with local copies of the nine exported icons needed for implementation. Every retained
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

- The Android developer owns shared chrome/theme, Settings and removal changes, including
  mechanical palette capture across Gym UI and the account/system-bar seams. The explorer reviews
  behavior and structure; the designer reviews assets and native screenshots.
- Keep the shared `GymHaptics` vocabulary for other gestures and non-set saves. Root owns the
  worklog, native acceptance and publication; application source stays frozen during the final gate.
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
- Published the verified baseline in `00db1d097f07ae2bf314c8d0780b6fced478f461`.
  [Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/34775262988) completed
  successfully for that exact commit; the release job was correctly skipped on the branch push.

### Wave 1 — shared presentation and approved removals

- Implementation assigned to the Android developer, with independent palette/code review and
  design verification. Root retains publication, the worklog and runtime acceptance.
- Added immutable Instrument/Daylight palettes scoped through composition locals. Material
  controls, charts, account sheets and native system-bar icons resolve the same system mode. Canvas
  callbacks capture their colors; nested and sibling theme scopes have regression coverage.
- Removed Kind controls and the set-confirmation sound/vibration engine. New sets use Working;
  corrections preserve stored kind. Legacy preference fields still round-trip because PUT replaces
  the document. Ordinary gesture and non-set feedback remains in `GymHaptics.kt`.
- The three root bodies keep their current operations while later waves refine their feature
  content. Wave 1 establishes their native chrome, navigation, spacing and appearance.
- Reused native Material navigation, centered workout chrome, sheets and accessible controls.
  Exact Figma vectors provide Routines/Log/Coach glyphs and chevrons. Shared action minimum is 48dp,
  primary actions 56dp and Log set 64dp; removed the logger's 32dp interactive override.
- Settings uses flat rows, native kg/lb selection, an editable 15–900 second rest target with Off,
  actual account email and connected-log state. The existing kg-only caption remains truthful when
  lb is selected. Rest counting/chime delivery belongs to Wave 3.
- Independent review fixed session-title centering, heading semantics, small-text contrast and
  explicit sheet scrim opacity. Native screenshot review corrected Units 72dp/support rows 70dp
  rhythm and separated the 80dp navigation surface from the canvas-colored system inset.
- Refactoring removed the dead set-confirmation engine, its wrappers/imports, and the misleading
  centered flag; one immutable palette feeds product and shell controls. No domain, queue or
  backend behavior changed.
- Focused gate: 55 tests passed, no failures/errors/skips, plus app compilation. The first full
  gate caught two old icon-based New routine assertions; both now exercise the text action while
  retaining their routine/workout scenarios. Final `./gradlew build` passed in 49s, 298 tasks
  (53 executed). Per variant: Gym 975 cases (963 pass, 12 gated live-wire skips), platform 55 pass,
  no failures/errors: 1,018 executed tests per variant. Logs:
  `/private/tmp/windmill-android-wave1-focused.log`,
  `/private/tmp/windmill-android-wave1-accepted-build.log`.
- Built with `-Pwindmill.apiBase=http://10.0.2.2:8089`, installed on API 34 emulator-5556 and
  cold-launched the final APK in 750ms. Native checks cover Instrument/Daylight, live mode changes,
  persistent Routines/Log/Coach navigation, normal and 200% system text, keyboard and Back handling,
  account sheet propagation, and gesture/three-button insets. Sampled native bounds confirm 48dp
  account/back/unit/last-time controls and 56/64dp primary/log actions.
- Rest UI refused 14 seconds, saved 120 seconds, and displayed 2:00 after a theme change. A real
  local-backend account restored through `PrefsSessions` after restart; fixture session/user keys
  migrated to Android Keystore with no plaintext auth keys left. Email delivery was not exercised.
- Native Settings edits changed kg→lb and rest 90→Off while a direct backend GET retained the full
  remaining document: `restSound=false`, `confirmHaptic=true`, `confirmSound=true`. No confirmation
  controls were displayed. Unit/Compose tests verify those flags produce no set-save effects.
- Corrected a real stored warmup 40×8 to 42.5×8 through Fix; the backend still returned kind warmup.
  A new native 60×8 set reached the backend as working. Neither entry nor correction exposed Kind.
  Finished the isolated smoke workout and dismissed its receipt through native Back.
- Final image/hierarchy evidence is in `/private/tmp/windmill-android-runtime/`: `w1-final-routines-
  instrument`, `w1-final-settings-instrument`, `w1-final-three-button`, and `w1-final-settings-
  daylight-200` (PNG/XML). Functional captures include `w1-rest-invalid-ime`, `w1-account-daylight`,
  `w1-fix-no-kind`, `w1-session-corrected`, `w1-logger-no-kind` and `w1-new-set-saved`.
  Pixel sampling verifies navigation #161C1D and system inset #0B1111 in both navigation modes.
- Independent designer review closed the final Instrument, Daylight, 200% and three-button
  captures with no remaining Wave 1 visual findings.
- Broader phone-state coverage, TalkBack journeys, notifications, motion and device-version checks
  remain in their owning waves. Emulator checks do not establish physical vibration/audio output.

## Structure observations

- Products depend on `:platform`; `:platform` must remain product-neutral.
- The existing app already separates domain, store, network and Compose UI. Waves reuse its
  offline/claim behavior and replace presentation seams instead of cloning the application.
- Native verification fixtures must use routine entry `sets: [{reps, weightKg}]`; the old
  `targetSets`/`targetReps` examples in the verify skill no longer match the backend validator.
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
