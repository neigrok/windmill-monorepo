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
| 2 | Routines: list/detail/create/edit, targets/fill, duplicate/delete/Undo, stale-edit protection; Create movement from planning and quick logging | Share movement creation and target-entry behavior; preserve the draft and originally read revision on refusal | Verified |
| 3 | Planned/free workout logging, rest count-up, assembly, numeric entry, refusal/offline states, finish receipts, correction, sharing and save as routine | Consolidate session presentation and truthful receipt/readback data | Pending |
| 4 | Log history, movement records/rename, bodyweight entry/correction, pagination and empty states | Share record rows and coherent loading/error/empty states | Pending |
| 5 | Coach conversation/history/read receipts, Notes, review/apply/turn down, account/sign-in/connected log | Consolidate support-screen structure and preserve state across navigation | Pending |
| 6 | Native transitions and feedback, ongoing notification/Live Update capability and fallback, keyboard/back/insets, both themes, accessibility and end-to-end coverage | Keep workout commands and the single queue owner in `:gym`; only product-neutral adapters belong in `:platform` | Pending |
| 7 | Final app-wide refactoring and code simplification, complete coverage audit and release validation | Remove dead paths and duplicate controls; verify dependency direction | Pending |
| Release | Versioned GitHub release with tested APK and accurate release notes | Verify published tag, CI result, asset and signing identity | Pending |

The [delivery contract](docs/design/gym/android-delivery.md) maps all 90 unique Figma states to
waves, with local copies of the twelve exported icons needed for implementation. Every retained
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
  Finished the isolated smoke workout and dismissed its receipt through native Back; the
  emulator crash buffer remained empty.
- Final image/hierarchy evidence is in `/private/tmp/windmill-android-runtime/`: `w1-final-routines-
  instrument`, `w1-final-settings-instrument`, `w1-final-three-button`, and `w1-final-settings-
  daylight-200` (PNG/XML). Functional captures include `w1-rest-invalid-ime`, `w1-account-daylight`,
  `w1-fix-no-kind`, `w1-session-corrected`, `w1-logger-no-kind` and `w1-new-set-saved`.
  Pixel sampling verifies navigation #161C1D and system inset #0B1111 in both navigation modes.
- Independent designer review closed the final Instrument, Daylight, 200% and three-button
  captures with no remaining Wave 1 visual findings.
- Broader phone-state coverage, TalkBack journeys, notifications, motion and device-version checks
  remain in their owning waves. Emulator checks do not establish physical vibration/audio output.

### Wave 2 — routines and movement creation

- Wave 1 is published in `7e41ca3beecbeda3f5e2bb1e0fd7f9d9f5cacdaa`.
  [Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/34777724846) passed for
  the exact published commit in 6 minutes. The release job was skipped on the branch push.
- The developer owns the planning domain/store seams, routine and movement screens, minimal root/
  logger creation plumbing, corresponding tests and exact vector conversions. Root owns this log,
  native acceptance and publication; the explorer and designer provide independent review.
- Reused `TargetEntry` arithmetic/validation and hidden-tail retention, `RoutineDraft` transformations,
  `TrainingStore.saveRoutine` and the independent nine-second withheld-deletion windows.
- Preserve the originally read revision throughout editing and write it as `revision`; a later
  background refresh must not silently replace that draft boundary. Duplicate creates an unsaved
  draft with copied ordered targets/rest and reset identity/revision/training metadata.
- Movement creation retains arbitrary user input, equipment, query and invoking route, with one
  stable identity across retry/offline fallback and a single in-flight save. Cancel and success must
  return to the real routine or quick-log picker context.
- Implementation replaces bordered planning cards with flat routine rows, native reorder,
  a shared Name field, numeric target sheets, an always-available creation action and a two-column
  equipment radio grid. Existing target arithmetic, hidden rows and independent Undo owners remain.
- The review/fix pass preserves numeric IME focus, native swipe removal and owner checks after
  suspended writes. A stable create identity survives interruption and retry; an ambiguous retry
  with edited request data is refused instead of silently accepting another movement.
- Native acceptance uses a fresh isolated account and four linked journeys: build and create,
  edit and fill targets, duplicate and delete with Undo, and quick-log movement creation. Direct
  backend snapshots check the full saved document, source immutability, stale-save refusal and
  identical-write replay. Representative screens also require both themes, 200% text and real IME.
- Focused planning gate passed 312 cases across 26 classes with no failures/errors/skips in 18s;
  the final native-paint/routine gate passed 21 cases with no skips. Final `./gradlew build` passed
  in 1m 10s: 298 tasks, 64 executed. Each debug/release variant has Gym 999 cases (987 pass,
  12 gated live-wire skips) and platform 55 pass: 1,042 executed per variant,
  no failures/errors. A fresh local account then passed all 12 enabled LiveWire cases with no skips.
  Evidence: `/private/tmp/windmill-android-wave2-final-focused.log`,
  `/private/tmp/windmill-android-wave2-opacity.log`,
  `/private/tmp/windmill-android-wave2-opacity-build.log`,
  `/private/tmp/windmill-android-runtime/wave2-opacity-test-counts.json`, and
  `/private/tmp/windmill-android-wave2-live-wire-results.xml`.
- Native checks created Cable Arc/Machine exactly once on the real backend, retaining the
  form across Cancel/reopen and a background process replacement. Routine targets accept 3×8×60,
  refuse 101 reps, interpolate five endpoints to 60/65/70/75/80, and apply Match set 1. Shrinking,
  blanking Sets, replacing the background process and restoring five rows retained every ramp load.
- Native routine Save stored the exact three-movement order and five targets. Two identical guarded
  PUTs preserved the full document, revision and history. A second writer advanced revision 1→2;
  native Save refused and retained the typed draft, leaving the server document exactly unchanged.
- Native Duplicate remained unsaved until Save, then gained a separate identity with equal ordered
  targets and no trained metadata; a full source snapshot remained equal. Two native deletions
  retained separate deadlines: Undo restored the newer deletion and the older copy expired. A real
  backend read confirmed only the unchanged source remained.
- Pending Save freezes fields, targets, add/remove/reorder, accessibility actions and both Back
  routes; a deferred refusal restores the original draft. A detail reload safely refreshes the
  next edit's revision. Native second-writer refusal, close/reopen and subsequent Save passed with
  the exact original targets intact.
- Reorder uses actual viewport bounds and continuous scrolling while the finger remains at an
  edge. Native held-edge drags moved the first of 12 movements to last and back; backend reads
  verified the complete ID order and positions after each Save. Backgrounding during a deletion
  window restored the withheld routine with the complete server document unchanged.
- Both Create callers dismiss the underlying search keyboard before mounting a fresh sheet.
  Native search → Create → Cancel → reopen retained query, Name and Equipment. Planning Press/
  Dumbbell and Quick Ring Row/Bodyweight each reached the real catalog exactly once; the latter
  landed in the live logger. Selected picker rows expose checked and disabled native semantics.
- Native Instrument/Daylight and 200% text checks verified adaptive targets/equipment, reachable
  header and footer actions, numeric/text keyboards and the full last-time placeholder. Assisted
  −5 kg and open targets saved correctly; a final five-set ramp saved 60/65/70/75/80 kg.
- Refactoring shares movement creation and Name controls, consolidates target layout and draft
  ownership, and removes unused picker copy, custom-tag state, footer wrappers and old reorder UI.
  Resting routine rows paint the canvas over the native Delete underlay. Pixel regressions cover
  both themes at rest, during swipe, after cancellation and Undo; other flat swipe rows already
  use opaque foregrounds. Independent code review passed. Broader TalkBack remains in Wave 6.
- Final image/hierarchy evidence in `/private/tmp/windmill-android-runtime/` includes
  `w2-planning-create-ime-fixed`, `w2-create-transition-fixed-200-ime`,
  `w2-quick-created-ready-log`, `w2-final-adaptive-target-200`, `w2-final-open-target-200-ime`,
  `w2-final-stale-retained`, `w2-final-recovered-detail`, `w2-long-drag-to-bottom`,
  `w2-long-drag-to-top`, `w2-final-settled-long-list`, `w2-background-undo-restored`, and
  `w2-final-ramp-applied-editor` (PNG/XML). The mapping below links all 28 W2 phone-state paths
  to these shared stateful screens; specification cases also have domain/store/Compose and
  real-backend evidence.
- Reassembled the accepted source with local backend 8089, installed and cold-launched in 892ms;
  the crash buffer was empty. APK SHA-256:
  `91850a791c68ea3d7a6261e782afe31395fcf0bc9e4d9589b05ab1f47b08fed9`.
- Final native list screenshots `w2-opacity-rest-instrument`, `w2-opacity-held-swipe`,
  `w2-opacity-cancel-instrument`, `w2-opacity-undo-instrument` and `w2-opacity-rest-daylight`
  close the paint regression. The full real-backend routine remained equal after native Undo.
  Independent final visual review reported no remaining W2 blocker.

| W2 Figma states | Runtime scenario and evidence |
|---|---|
| 656:6696, 660:7359, 660:7420, 656:6697 | Empty → New → saved detail → Edit: `w2-empty-instrument`, `w2-new-empty-ime`, `w2-routine-saved-detail`, `w2-edit-unchanged`; real saved document and revision reads |
| 656:6698 | Query, The six/All movements and selected-row refusal: `w2-final-picker-empty`, `w2-selected-picker-row`; picker ranking/window/selection tests |
| 673:2567, 674:3179, 674:3307, 674:3419 | Straight, Ramp, Open and invalid 101 reps: `w2-target-straight-ime`, `w2-target-ramp-applied`, `w2-final-open-target-200-ime`, `w2-target-invalid-ime` |
| 675:2973, 678:3372, 678:3494 | Fill menu, Ramp up and Match set 1: `w2-target-fill-menu`, `w2-target-ramp-applied`, `w2-target-match-first`; hidden-tail restoration and full arithmetic assertions |
| 674:3537, 674:3563 | Applied ramp/open in editor: `w2-final-ramp-applied-editor`, `w2-final-open-applied-200`; backend exact five-set/open entry reads |
| 677:9879, 677:9932 | Empty name refusal and 60-point limit: `w2-edit-empty-name`, `w2-edit-name-limit`; Unicode boundary/domain tests |
| 676:9711, 677:9825, 677:10061, 677:10114 | More → unsaved Duplicate → Save → list: `w2-row-menu`, `w2-duplicate-draft`, `w2-duplicate-saved`, `w2-copy-in-list`; full source/copy comparison |
| 676:9731, 676:9767 | Delete → independent Undo/expiry: `w2-copy-deleted-undo`, `w2-independent-undo`, `w2-background-undo-restored`; backend source retained/copy gone |
| 669:8424, 669:8631, 670:8634 | Planning Create empty/ready → insertion: `w2-planning-create-ime-fixed`, `w2-planning-create-reopened`, `w2-planning-created`; cancellation, process replacement and catalog identity checks |
| 669:8838, 669:9004, 670:8693 | Quick Create empty/ready → logger: `w2-create-transition-fixed-200-ime`, `w2-create-bodyweight-retained-200`, `w2-quick-created-ready-log`; retained caller and exact catalog readback |

### Wave 3 — training, correction and receipts

- The implementation sequence is committed finish data → logger/rest → shared numeric entry/Fix
  → session assembly → readback/sharing/Keep routine, followed by simplification and verification.
  Figma contexts and exact settings/forward assets are recorded in the delivery contract.
- The developer owns Android domain/store/queue/UI and corresponding tests. Root owns native
  fixtures, acceptance and publication; independent code and design review remain required.
- `FinishOutcome.Closed` must carry canonical committed `SessionDetail` after delivery, independent
  of Review. The receipt and retained workout use the same detail and deletion visibility; failed
  rereads retain the saved facts and a truthful failure. Owner changes, ID remints and local claims
  must not redirect a late completion into another account or an obsolete workout identity.
- The native fixture uses a separate account and real backend routine: Bench Press 3×8×60,
  Overhead Press 3×8×30 and Lateral Raise 3×10×18. A complete workout totals 9 sets/2,700 kg;
  one/two/three bench sets total 480/960/1,440 kg. Free-session 57.5×8 totals 460 kg.
  These expected values are verification inputs; UI arithmetic must use saved sets.
- Figma specification `673:10002` defines “Ended early.” as fewer than four actual working sets
  for both planned and free workouts. The free receipt's single 57.5×8 set confirms that rule;
  a missing Review must not change the classification.
- Native acceptance will cover planned/free logging, rest elapsed versus target, numeric refusal,
  frozen plans, movement assembly, queued/offline recovery, partial/complete receipts and matching
  readbacks, Fix/deletion/Undo, sharing/revocation and saving eligible free sessions as routines.
  Small-screen/200% text and real IME checks apply to the rack, Fix and scrolling receipt.

## Structure observations

- Products depend on `:platform`; `:platform` must remain product-neutral.
- The existing app already separates domain, store, network and Compose UI. Waves reuse its
  offline/claim behavior and replace presentation seams instead of cloning the application.
- Native verification fixtures must use routine entry `sets: [{reps, weightKg}]`; the old
  `targetSets`/`targetReps` examples in the verify skill no longer match the backend validator.
- Figma screen count is a coverage index, not a target for the number of composables or routes.
- Wave 3's handoff identifies receipt totals that must come from saved sets independently of a
  review response. Wave 4's handoff identifies the missing Android stats adapter for truthful
  movement progress and range selection; the backend already exposes `/v1/gym/stats`.
- Wave 4 must reconcile `docs/design/gym/briefs/18-progress.md` with the current approved Figma contract:
  chart release returns to the latest point, the heading is “Estimated strength”, and Daylight
  uses the verified palette. The handoff records these differences before implementation.

## Completion audit

- [ ] All 90 approved states and specification-only contracts mapped to implemented behavior and inspected evidence.
- [ ] Every implementation wave refactored, reviewed, verified and published.
- [ ] Kind controls and sound/haptic set confirmation absent from the app, with historical data preserved.
- [ ] Local and signed-in journeys, offline recovery, partial receipts and account boundaries verified.
- [ ] Native font scaling, back/keyboard/insets, accessibility and notification behavior verified.
- [ ] Final simplification wave completed with regression checks.
- [ ] Release APK built and installed; version/signature checked.
- [ ] GitHub release, tag, successful CI and downloadable APK verified.
