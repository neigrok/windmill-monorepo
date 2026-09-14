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
| 3 | Planned/free workout logging, rest count-up, assembly, numeric entry, refusal/offline states, finish receipts, correction, sharing and save as routine | Consolidate session presentation and truthful receipt/readback data | Verified |
| 4 | Log history, movement records/rename, bodyweight entry/correction, pagination and empty states | Share record rows and coherent loading/error/empty states | Verified |
| 5 | Coach conversation/history/read receipts, Notes, review/apply/turn down, account/sign-in/connected log | Consolidate support-screen structure and preserve state across navigation | Verified |
| 6 | Native transitions and feedback, ongoing notification/Live Update capability and fallback, keyboard/back/insets, both themes, accessibility and end-to-end coverage | Keep workout commands and the single queue owner in `:gym`; only product-neutral adapters belong in `:platform` | Verified |
| 7 | Final app-wide refactoring and code simplification, complete coverage audit and release validation | Remove dead paths and duplicate controls; verify dependency direction | Verified |
| Release | Versioned GitHub release with tested APK and accurate release notes | Verify published tag, CI result, asset and signing identity | Signed APK verified; publication awaits approval |

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
- Current native verification uses the final W5 real-service fixture8097 through the reviewed
  proxy8095, database `windmill_android_w5`, Vite5177 and isolated emulator `emulator-5556`.
  App API override: `http://10.0.2.2:8095`. W4's8089 and its database remain preserved. An isolated
  API37 emulator5558 has the verified signed0.8.0/code72 APK; API28 emulator5560 retains W6 preview2. Runtime evidence stays under
  `/private/tmp/windmill-android-runtime`; the existing personal device is untouched.

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

- Wave 2 is published in `1a85e33d6cc3e80d5879ca46f9130c414455c2b7`.
  [Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/34783246380) passed for
  that exact commit in 6m 6s; the branch release job was skipped. The developer has the Wave 3
  source and Gradle lease.
- The implementation sequence is committed finish data → logger/rest → shared numeric entry/Fix
  → session assembly → readback/sharing/Keep routine, followed by simplification and verification.
  Figma contexts and exact settings/forward assets are recorded in the delivery contract.
- The main developer owns Android domain/store/queue, logger/assembly/receipt UI and caller
  integration. A second developer owns KeypadSheet/FixSheet and their focused UI tests; both reuse
  the same ladder control and coordinate one Gradle lease. Root owns native fixtures, acceptance
  and publication; independent code and design review remain required.
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
- The committed-detail boundary passes 202 focused cases after the review fixes. They cover
  deferred append/correction, owner handover, held deletion, stranded delivery and late claim
  remints. Canonical IDs follow finished shelves and set tombstones; delayed starts and deletion
  errors retain the request owner. An operational remapped timer test verifies the original Undo
  deadline and eventual send. Independent re-review is clear.
- Numeric entry and Fix pass 40 focused cases, including native graphics at 320dp/200% text,
  refusal, pending-save locks and restoration. Review found that a canonical ID change could reset
  an open Fix draft or unlock a suspended save. Both callers now provide the original logical
  target as a stable draft key; two additional regression cases await the integrated gate.
- The first W3 preview includes the core fixes, numeric sheets and preliminary logger/rest.
  Assembly and receipt presentation remain under implementation. Its local-backend APK SHA-256 is
  `4bee0437fb42b038b3da39dce0f1bb9e083ebc0f0c14911027fa9648c12e7e7a`; installation succeeded and
  cold launch took 1,140ms. Weight 501 and Reps 101 refuse, disabled Reps sign/decimal and invalid
  commits are verified in the hierarchy, and real note IME → keypad → Cancel retains the draft.
  Actual process replacement exposed a caller gap: an open historical Fix returned to Log;
  revisiting the session restored its sheet, but a subsequent font change lost the unsaved note.
  The developer confirmed the route used unsaved state and is fixing route/seed hydration.
- At 412dp/200% text, the note IME → Weight → Cancel path retains the draft, and scrolling brings
  Save fix fully above the keyboard. A native correction stored 42.5kg, RPE9.5 and the note exactly;
  backend comparison confirms original warmup kind, set number, identity, timestamp, frozen plan
  and all nine other rows are unchanged. Evidence: `w3-fix-200-ime-save-reachable`,
  `w3-fix-warmup-saved` and `w3-history-corrected.json` in the runtime evidence directory.
  At 320×640dp/200%, the keypad fits and scrolling exposes the full Save/Delete targets above
  the IME. Daylight reveals a modal-window status-bar contrast issue, now in the fix pass.
- The first planned native set is saved as Working 60×8 and verified as 480kg after its delivery
  window. The strip advances to Set 2, saved feedback does not move the rack, and Rest changes
  from the actual 1:30 target to a count-up clock. The captured 1:03 display matches the persisted
  logged-event timestamp within capture latency. Designer review requests a compact, centered
  current-only movement marker and Add control below the strip; that refactor is in progress.
- Native offline logging is verified: after network reachability failed, a second 60×8 set stayed
  on the device while the backend remained at 1/480kg. Actual process replacement retained both
  local sets, next Set 3 and the count-up origin. Reconnection delivered exactly one additional
  set (2/960kg); both pre-ack and post-ack clocks match its original completion time. Evidence:
  `w3-logger-offline-process`, `w3-logger-reconnected`, `w3-session-offline-recovered.json`.
  Active movement selection reset during the preview restart; persistence is in the fix pass.

- Preview 2 installed successfully (cold launch 882ms), SHA-256
  `4525b0cfab3278ae0dd306c6bec5ae0c2e128022df99a1dcf18429de100c0c95`. Its two-set finish draws
  Ended early / 2 sets / 960kg / 1 movement, and dismissing reveals the same saved session.
  Native public-link creation and Copy feedback passed; revocation returned an anonymous 404.
  This used only the synthetic fixture and localhost endpoints. Automatic review initially
  rejected the link as external sharing, then accepted the retry after read-only scope evidence.
- Public sharing verification found an inaccurate disclosure: the existing payload includes set
  notes and optional effort. Android and Figma text `672:9676` now state “Includes set notes and
  effort.” The Figma screenshot is verified with its layout unchanged; other Android pages have
  no remaining copy of the inaccurate sentence. Native text and layout are verified at320dp/200% in `w3-preview4-sharing-disclosure-200`.
- Independent recovery review found startup-owner, canonical-ID restoration and delayed-read
  races. The developer is adding fresh-store regressions and owner-scoped saved state. Native
  process/configuration acceptance is reserved for the next preview; W3 remains incomplete.

- Native complete receipt now verifies nine distinct Working sets, 2,700kg and three movements
  against the isolated backend (`w3-session-full-nine.json`). The 320dp/200% capture reveals a
  split numeric total; comparison rows also need reflow and truthful plan-versus-history labels.
  These remain in the fix pass. Scrolling reaches the full Coach action and disclosure.
- The Coach handoff reaches the capability-unavailable screen on this local configuration; no
  generated answer is claimed. Receipt capability gating is being checked, and W5 needs an enabled
  test transport for its answer flow.
- Preview 2 Daylight modal status icons are verified dark and readable at 320dp/200%
  (`w3-preview2-daylight-expanded`). The earlier contrast finding is closed.

- Native partial 1/2/3-set receipts and matching readbacks now verify 480/960/1,440kg; the
  free 57.5×8 session verifies one Working set, 460kg and Ended early. Snapshots are
  `w3-session-partial-one.json`, `w3-session-partial-two.json`, `w3-session-partial-three.json`
  and `w3-session-free-one.json`; associated receipt/readback captures are in the runtime directory.

- Independent recovery re-review is clear: cold unresolved/signed-out/account-switch state,
  canonical IDs across fresh stores, late-read correction protection, per-owner movement cursor
  and restored free-rack values are covered. Pending Save routine blocks dismissal, Coach and name
  edits; refusal/retry retains one stable write. The focused final recovery gate passed in 14s.
  The full Gym run has one unresolved large-text layout assertion; native final-preview acceptance
  and the full wave gate remain pending.

- Preview 3 native process replacement preserves OHP selection and unlogged92kg/6reps
  (PID23537→23993). A saved-set Fix with refused520 restores directly after PID24115→24839;
  the refused buffer also survives320dp/200% and Daylight. Native Back then exposed a separate
  modal-window bug: it closes the whole Fix and discards note/effort instead of returning to its
  body. Reopening confirms the draft is gone. This remains a W3 blocker in the native fix pass.
- Preview4 changes only the pending Last time label to Reading… and its accessibility/read-state
  regression. Actual Bench cold history resolves to the verified57.5×8 API result. Full build
  passes1,080 executed tests per variant (Gym1,025 plus platform55), with12 gated Gym skips;
  enabled live-wire passes12/12 separately. Further Back fixes require their own final gate.

- Native Save routine passes at320dp/200% with the actual IME. A61-character name remains
  editable and refused; correcting it to W3 Saved Session exposes the complete64dp save action
  above the keyboard. The result says Kept as W3 Saved Session and the backend contains exactly
  one routine, `rt_b297e38e43b919e7`, with four Bench targets of57.5kg×8. Evidence:
  `w3-preview4-routine-save-ime-reachable`, `w3-preview4-routine-saved`, `w3-saved-routine.json`.
  The receipt's three totals and labels remain unbroken in `w3-preview4-receipt-small-top`.

- Final native Back acceptance passes on API34. Back first hides the actual IME. Back, explicit
  Cancel, scrim and drag each cancel only the keypad, preserving57.5kg/RPE9.5/Native back draft.
  Process replacement26164→27342 plus320dp/200%/Daylight also retains refused520 and returns to
  the complete draft. Save changes only note/RPE; exact JSON comparison preserves identity, kind,
  number, timestamp, weights/reps and the other three sets. Finished Delete/Undo restores the same
  entire session after its original delivery window. Evidence: `w3-preview5-restored-body-200-daylight`,
  `w3-final-fix-after.json`, `w3-final-finished-undo.json`, and four cancellation capture pairs.
- Refactoring consolidates committed receipt/readback data, shared numeric/ladder controls,
  adaptive receipt rows, owner-scoped saved routes and the product-neutral modal Back dispatcher.
  The pending-history label distinguishes a read in progress from a successfully empty result.
  Independent core, numeric, recovery, receipt/assembly and final Back reviews have no remaining
  actionable finding. API28 and35 cancellation regressions supplement actual API34 verification.
- Final source build passes in1m34s,298 tasks/88 executed: Gym1,026 passed plus12 gated skips and
  platform55 passed per debug/release variant, for1,081 executed per variant and zero failures/errors.
  Enabled LiveWire12/12 passed separately with no skips. Logs: `windmill-android-wave3-native-back-build.log`
  and `windmill-android-wave3-live-wire.log` under `/private/tmp`; exact result archive is
  `wave3-native-back-full-tests.zip` in the runtime directory. Final preview5 installed cold in781ms,
  SHA-256 `f1f922d666a1d2b4d7c7ca093baed716d4e36a7157839afbdca525f371b9a302`.
  Published in `c8becf80beb02699407db6bdf7d18a29040d84d2`;
  [Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/34789872333) succeeded for
  that exact commit. W4 backend changes remain outside the W3 commit.

### Wave 3 state coverage

All27 training states have exercised behavior and final review coverage. Screenshot names below
refer to PNG/XML pairs in
`/private/tmp/windmill-android-runtime`; earlier preview layouts are supplemented by the final
source review and native layout captures. API snapshots above verify saved facts independently.

| Figma state | Scenario | Evidence |
|---|---|---|
| `660:7955` | Planned first set | `w3-logger-planned-empty` |
| `659:7176` | Planned second set | `w3-logger-planned-first` |
| `659:7243` | Planned third set | `w3-logger-reconnected` |
| `659:7310` | Overhead Press after Bench | `w3-full-ohp-empty` |
| `671:8688` | Session assembly | `w3-assembly-real-reorder` |
| `671:8689` | Saved offline | `w3-logger-offline-process` |
| `657:29` | Weight entry | `w3-preview3-weight` |
| `671:9516` | Weight refusal | `w3-preview3-fix-config-pad` |
| `671:9517` | Reps refusal | `w3-fix-reps-refusal` |
| `662:7669` | Pick movement | `w3-free-picker` |
| `662:7755` | Free logger | `w3-free-empty` |
| `662:7831` | Free set saved | `w3-free-one-logged` |
| `671:8687` | Numbered readback | `w3-preview4-readback-actions` |
| `671:8690` | Fix set | `w3-preview5-restored-body-200-daylight` |
| `671:8691` | Fix write refused | `FixSheetStateTests.pendingSaveBlocksEditsAndDeleteThenRetainsTheDraftForRetry` (injected write refusal) |
| `671:8692` | Set removed / Undo | `w3-preview5-finished-set-removed` / `w3-preview5-finished-set-undo` |
| `671:9520` | Public sharing | `w3-preview4-sharing-disclosure-200` |
| `660:8028` | Complete nine-set receipt | `w3-full-nine-receipt` |
| `660:7713` | One-set receipt | `w3-partial-one-receipt` |
| `660:7775` | Two-set receipt | `w3-preview2-partial-two` |
| `660:7837` | Three-set receipt | `w3-partial-three-receipt` |
| `671:9519` | Save routine | `w3-preview4-routine-saved` |
| `673:9326` | One-set readback | `w3-partial-one-readback` |
| `673:9400` | Two-set readback | `w3-preview2-readback-two` |
| `673:9474` | Three-set readback | `w3-partial-three-readback` |
| `662:7907` | Free receipt | `w3-free-one-receipt` |
| `673:9548` | Free readback | `w3-free-one-readback` |

The public-link create/copy/revoke journey returned a real anonymous404 after revocation. Assembly
native drag/drop is supplemented by edge-scroll, just-added reveal/current semantics and performed-row
protection tests. Independent held-deletion windows are covered in store/SetRowSwipe tests, with
native Delete/Undo verifying exact saved rows. Native enabled Coach generation is not claimed on
the disabled local configuration; W3 handoff/deduplication is covered by integrated FinishSheet tests,
and W5 owns enabled conversation acceptance. The final Fix native Back/Cancel/scrim/drag and IME-first checks pass on API34.

### Wave 4 — Log, records and bodyweight

- Android implementation has three disjoint owners: the complete progress transport/store and
  Log/Record integration; the shared dated-plot domain/renderer; and bodyweight presentation,
  correction and persistence. The main Android developer coordinates the single Gradle lease.
  Root owns docs, runtime verification, independent review and publication.
- The chart API separates passive Log previews, Record pan/held scrub and Bodyweight point
  selection. Callers own the factual series, qualification, explicit date range and standing-best
  identity. Geometry preserves real dates, including equal-time sessions, with separate21/7-day
  gap rules. The written Progress brief now matches Android's approved heading,90dp preview,
  above-plot readout, release-to-latest behavior, Daylight palette and complete data contract.
- The additive `/v1/gym/stats?projection=progress` backend implementation passes282/282 focused
  checks, including61 real Postgres cases and18 new progress cases, with zero skips. Independent
  production/test review found no actionable defect. A synthetic7,020-set history reduces to
  780 facts /180,865 JSON bytes; no production latency is claimed.
- Built the W4 production server and replaced only the isolated8089 runtime, preserving its local
  environment/database. Native fixtures use a new synthetic account:57 finished-working sessions,
  17 movements, a31-session recent Bench series plus a180-day standing peak, three-session sparse
  and four-session qualifying movements, assisted/zero and high-rep no-estimate records, and nine
  weigh-ins. The real API returns all57 progress identities while the first Log page holds50;
  latest Bench estimate95 and lifetime best121 are independently checked. Fixture scripts and
  exact JSON snapshots live under `/private/tmp/windmill-android-runtime/w4-*`.
- Bodyweight passes35 focused tests, including both themes at200% text, raw draft restoration,
  read/refusal states and newer canonical precedence. The shared chart passes12 focused cases
  plus2 affected accessibility/momentum regressions. The686-case boundary suite passes without
  skips. Independent re-review clears catalog rename/upsert ordering, direct/queued bodyweight
  serialization, owner-safe pagination, malformed responses and restored-date/current-picker bounds.
- Refactoring moves Log grouping into pure `LogReadout`, shared record facts into `Progress`, and
  both charts onto one dated renderer. It removes obsolete proof/bars and redundant calculations.
  Preview2's full build passed1,089 executed tests per variant, zero failures; fresh enabled
  LiveWire passed12/12. A subsequent native finding requires a narrow final layout/build gate.
- Native API34 verifies sparse3 versus qualifying chart data,31 recent/32 lifetime Bench points,
  actual held scrub and immediate release-to-latest, time-scaled pan and the old121kg standing best.
  Rename61-character refusal survives process replacement at320dp/200%; confirmed Bench Native
  keeps `bench-press` identity and Bench Press alias. Log Back preserves strip position.
- Bodyweight native checks cover90-day6/All9 counts, Instrument/Daylight200%, actual decimal IME,
  range refusal401, process replacement and IME-first Back. Comma82,45 saves82.45 on the original
  date; Delete/Undo restores the entire nine-entry JSON including timestamps. An offline82.5
  correction survives process replacement and reaches the backend once after reconnecting.
- Pagination failure preserves the loaded rows; Retry reaches the actual first-session footer.
  A separate empty account verifies No sessions yet, native past-date selection with future days
  disabled, and no false empty Bodyweight while its last entry is held for Undo. Settled deletion
  returns a genuine empty server read. Evidence is in the runtime directory under `w4-*`.
- The final snackbar host participates in measured bottom-bar layout so screen-owned actions
  remain above Undo. Twelve focused checks pass, including320dp/200% in both themes, opening
  Weigh in with two independent windows, and unchanged logger rack bounds. Native preview3
  measures the complete56dp Weigh in above48dp Undo; Undo in2.84s restores exact workout identity,
  classification, timestamps and sets after the original9-second window. One synthetic old-peak workout was deleted after the
  test driver missed its Undo window; current fixture progress has56 sessions and is not reseeded.
- Final source `./gradlew build` passes in79s:298 tasks/69 executed. Gym1,048 cases per variant
  have1,036 passes and12 gated LiveWire skips; platform55 passes, giving1,091 executed per variant
  and zero failures/errors. Enabled LiveWire12/12 passed before the final UI-only snackbar move;
  transport/domain/store are unchanged. Final APK `wave4-preview3.apk` uses local8089 and has
  SHA-256 `f243cdfc7f9af0c447a1f35a5a4ad99161f013a971da3c9b35d5a5211002261d`.
  Independent review and final native acceptance are clear; the API34 crash buffer is empty.
- W4 is published in `74403411a69065b1e4714ef42580238337559840`.
  [Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/34793748768) passed for
  that exact commit in6m43s. [Backend CI/CD](https://github.com/neigrok/windmill-monorepo/actions/runs/34793748531)
  and [Deploy to VPS](https://github.com/neigrok/windmill-monorepo/actions/runs/34794238808) also
  passed for the exact commit. The deployment pins both checkout and container image to the
  triggering commit. The publication gate is complete.

### Wave 4 state coverage

All eight assigned states have implementation and verification evidence. The Log root is covered
by `w4-log-instrument` and the final `w4-preview3-workout-restored`; screen captures below are
PNG/XML pairs in the runtime directory. Error/race scenarios also use the exact tests listed above.

| Figma state | Scenario | Evidence |
|---|---|---|
| `656:6694` | Movement record | `w4-record-bench-recent`, `w4-bench-held`, `w4-bench-scrubbed`, `w4-bench-released`, `w4-bench-all-oldest`, `w4-record-sparse` |
| `678:11447` | Rename | `w4-rename-overlimit-200-ime`, `w4-rename-process-200` |
| `678:11551` | Confirmed rename | `w4-renamed-record-200`, `w4-renamed-log-200`, `w4-renamed-movement.json` |
| `669:8306` | Bodyweight | `w4-bodyweight-200`, `w4-bodyweight-all-daylight` |
| `669:8329` | New weigh-in | `w4-new-weigh-in`, `w4-native-date-picker`, `w4-new-weight-chosen-date`, `w4-empty-seat-weight-saved` |
| `672:2984` | Correction | `w4-weight-401-result`, `w4-weight-process-daylight-200-ime`, `w4-weight-ime-back-retained`, `w4-weight-corrected.json`, `w4-weight-undo-restored.json` |
| `669:8352` | Empty Log | `w4-log-empty` |
| `671:9521` | Workout removed | `w4-preview3-workout-removed`, `w4-preview3-workout-restored`, `w4-preview3-workout-undo.json` |

Native offline correction/replay, pagination failure/retry/end and held-versus-settled last entry
are verified separately. Controlled transport refusal, account races, midnight rollover and
accessibility actions use unit/Compose tests; no physical haptic output is claimed.

### Wave 5 — implementation and acceptance

- The independently reviewed17-file backend patch is integrated. Successful Coach answers carry
  the actual opening/failed tool steps, successful scoped observations and immutable per-answer
  receipts. Evidence is persisted atomically with the answer; old answers omit it. Integrated
  backend verification passes187/187 cases with zero skips, including11 real Postgres cases and
  all18 W4 progress regressions. Production server build and idempotent schema application pass.
- The local model-boundary harness lives outside every repo in
  `/private/tmp/windmill-android-runtime/w5-fixture`, using only `windmill_android_w5`. Its self-check
  passes real authentication, receipts/history, proposal apply/replay, failed-model cleanup, Notes,
  keys and grants. Root runs native scenarios on loopback8095; W4's8089 remains running. The
  model is scripted and email is captured locally; neither model quality nor external delivery is
  claimed. Native Coach, Notes and Review acceptance is recorded below.
- The six-file Notes patch is independently reviewed and integrated;27/27 focused tests pass,
  including native graphics at200% in both themes. It preserves raw drafts/stable IDs, exact
  Unicode/UTF-8 limits, accessible reorder and independent Undo. Main retains TrainingStore and
  GymRoom integration.
- The four-file consent manifest/persistence implementation is independently reviewed;13/13
  focused tests pass. Approval preserves the frozen payload/revision batch, sign-in flow and
  target owner. The journal syncs its temporary file, atomically replaces the durable decision,
  then syncs the parent directory before exposing authority. Corrupt state and uncertain writes
  fail closed. Per-file transfer/replay, active-queue preflight and Undo integration pass the
  final store and native process-recovery gates below.
- Preserve existing owner-scoped unsent work: “unclaimed session” also includes authenticated
  work awaiting the server, so it cannot be used as the consent flag. Claim recovery needs a
  frozen source manifest assigned to one account before any queue/log/bodyweight/settings move.
- Android's typed receipt transport and shared live/history renderer are implemented. They preserve
  complete model prose and label summary/full-session/movement evidence according to its actual
  scope; movement-only reads cannot supply whole-workout totals.
- Pre-gate native APK `wave5-preview1.apk` has SHA-256
  `8d06954bb1363e7c7a45227e97972d4efe7809767c62cb2d01c85dffa0734533` and uses local8095.
  AssembleDebug passes21s/75tasks18executed. The real auth restore is sealed and preserves the
  fixture baseline: one routine, four sessions, two Notes, no conversations or connected tools.
  One native question produces the exact saved receipt:10 sets,4 weeks,4 sessions; four summaries,
  one10-set full-session read and one3-set movement read. History reopens the full prose and facts.
- Native Notes creation/editing, drag reorder,61-point title refusal, process replacement at320dp/
  200% and exact501-byte body refusal pass. Delete fully closes the editor; Undo in2.29s restores
  exact content, identity and order beyond the original9-second window, with disjoint56dp Add and
  48dp Undo targets. An initial unverified long adb input entered309 bytes; the501-byte retry was
  asserted from native field content before Save. The intended44-byte Note body is restored.
- Native Review Back leaves the proposal pending; Turn down / Keep it cancels the decision.
  At320dp/200%, resizing and expanding retained rows each disable Apply until the actual end is
  seen. Apply advances exactly one routine revision and changes only Bench targets60→62.5kg;
  all four performed-workout documents and saved conversation turns remain identical. The
  applied diff reopens without decision controls. A second65kg proposal is turned down, preserving
  revision2 and all plan entries. A third proposal is superseded by a simulated second-device
  rename to Push Native/revision3; native Apply refuses it and retains the original readable diff.
  Actual routine fields, performed workouts and saved turns remain unchanged by that refusal.
- Native failed-model retry preserves the single completed conversation and adds no failed
  question, answer or receipt. Three failed attempts exhaust the real local burst bucket; the
  next native retry shows the rate-limit state. This checks burst limiting, not the daily or
  30-day ceiling.
- Pre-gate `wave5-preview2.apk` SHA-256
  `b754402fae5eae4b42e1a839884947f9febe62f440c93e9ef79be5a62cf95808` passes the corrected first-answer
  layout: full prose, one directly read full-workout card and expandable scoped evidence.
  Summary-only observations remain in the disclosure. Fast subsequent replies still need their
  new question scrolled into view. After four successful questions, native Ask new replaces the composer; tapping it leaves stored conversations unchanged. Server-full draft preservation has focused coverage.
- Account, Sign-in and Connected log support UI passes26 focused cases; deferred AuthStore
  verification passes23/23. Independent review identified interrupted sheet dismissal, stale
  browser-return callbacks and obsolete skin assertions; fixes and regressions are integrated
  for the final full gate. Native first-open account→Connected log, expanded disclosure, Back and
  signed-out account→Settings pass. Reopening the signed-in account sheet can lose both
  destinations; the native reproduction remains open and the temporary Routines settings door stays.
- Native explicit consent writes the Android atomic journal before sign-in. A saved anonymous
  routine and settings remain absent from the server while awaiting consent. The invalid-code
  draft survives actual process replacement (4803→6223) at320dp/200% in Instrument. Correct-code
  sign-in transfers exactly the approved routine, with all four workouts, three Notes and old
  conversation unchanged, but a transient duplicate routine row crashes the UI. Relaunch recovers
  the correct two routines and sealed credentials; `w5-signin-adoption-crash.log` records this
  open failure. This is not final adoption acceptance.
- Consent boundary fixes cover initial partial-transfer replay blocking, owner-safe preference
  writes, completion markers in empty repositories, a later Not mine superseding a pending
  preflight and resuming the same durably approved sign-in. Independent review and fresh-store
  regressions pass independent re-review. Six migrated store suites pass215/215 without deleting behavioral assertions. No W5 commit or publication is claimed yet.
- Native Connected log renders a real local API key with its actual whole-account reach. Manage
  connections opens Chrome; revocation while outside the app is reflected on return. Chrome's
  first-run page prevents local web-content acceptance, so this records native handoff and refresh
  only. The synthetic key is revoked. History swipe-delete/Undo in2.49s preserves both saved
  conversations exactly beyond9s, with56dp Ask something new and48dp Undo disjoint.


- Preview4 (`42e154b875f42874bc80c64fde2a358f5f252539b2f7534e3aead5fc59a2b7b9`) replaces
  disposable account registration with a stable remembered product binding and closes a fully
  hidden modal after IME cancellation. The diagnostic established that both registrations used
  the same store; it did not reveal a second queue. Independent boundary review is clear and all
  diagnostic logging is absent from the candidate. Signed-out account destinations survive both
  roundtrips and actual200% text reconfiguration on the emulator.
- The full Android build passes in1m46s (316 tasks,123 executed): Gym1,095 and Platform73
  executed per variant with no failures, plus12 explicitly gated live-wire skips. Final native recovery found a
  cold-entry gap: a durable awaiting-sign-in decision survives an APK restart, but These are mine
  tries to start another decision. Resuming that exact existing flow is being fixed. The isolated
 8095 fault proxy forwards to the real fixture on8097 and blocks only the session preflight GET;
  no interrupted-approval recovery acceptance is claimed before that native journey completes.


- Preview5 (`6b7ca7f660257d8ee5f48038ff4d4c8d470ee2a0704184a45fc2c8df712c2c43`) passes native
  cold Awaiting reopen with the exact saved flow/batch unchanged. Native cancellation clears only
  that decision; the anonymous log remains byte-identical. A new decision explicitly includes the
  Native recovery routine and active workout after one real20kg×5 working set. Actual timed
  Resend and locally captured one-use code complete sign-in with sealed credentials and no
  invisible modal blocking the next Settings action.
- With only the active-session preflight GET returning503, the Approved journal retains its exact
  batch/flow/owner and the server has only its two prior routines/four workouts. Actual process
  replacement10679→11453 preserves that approval and still uploads nothing. After restoring the
  check, merely resuming the Activity does not retry; following the screen's restart instruction
  (11453→11566) recovers exactly one routine, one workout and its original set. Session/plan/set
  identity, load, reps and original log time match the anonymous snapshot. The first read sees
  the created workout before its queued set arrives; the final read confirms the one original set.
  No duplicate-row crash occurs. Consent clears; native finish gives Ended early,1set/100kg/1movement.
  All four original performed-workout documents remain exactly unchanged.
- Final full build after the cold-flow fix passes1m35s: Gym1,096 + Platform73 executed per variant,
  zero failures, plus12 gated live-wire skips. A fresh explicitly enabled LiveWire run passes12/12,
  zero skips, in17s. The coverage audit maps all20 W5 phones and specification requirements;
  remaining native presentation/error-state evidence is being completed before publication.


- Native signed-out Coach and actual full-email-link completion pass. A consumed real code
  receives the production expiry refusal with its raw buffer retained; this is used-code evidence,
  not a claim of waiting15minutes. Repeated signed-in destinations, cold authenticated launch and
  actual200% text pass. The redundant Routines settings row/callback is removed; the logger gear
  remains. A fresh account proves empty Notes and unsaved suggestion/cancel behavior without
  deleting the original account's Notes.
- The reviewed local proxy's54-request self-check preserves raw forwarding and never fabricates
  successful answers. Native controlled500s show history without stale rows/counts and Connections
  unavailable, then pull-to-retry restores actual data. Exact production429 shapes distinguish
  the daily allowance from the rolling AI ceiling. Route404 draws feature absence while Notes
  and Connected log remain usable. These are transport-driven presentation checks; quota
  enforcement is covered separately by backend tests and the earlier actual native burst refusal.
- Holding one actual successful Coach response for30s allows native process replacement13878→14097
  while pending. The exact question returns retryable, no automatic request is sent, and History
  opens the one actually persisted answer. Full thread metadata remains unchanged after readback.
- Preview7 (`3866075f55556850a75efa5280869cfd7876d416030f5249fd5c995b1ef80e9e`) passes actual
  fast-follow-up anchoring: new question at the first-question position, old question offscreen,
  complete prose/card/read receipt above the composer. Its full gate passes1,174 cases per variant
  with12 separately gated LiveWire tests; the earlier explicitly enabled12/12 still covers unchanged
  transport. A subsequent independent review closes cached positions across Ask new in preview8.
- Native whole-routine removal passes on preview10 against the real service/PG pipeline. A
  controlled proposal-read500 shows no invented diff and explicit retry; clearing it loads the
  actual removal. Contextual Remove deletes only the expendable routine. All six performed
  workout documents are retained; only that workout’s routine link clears. The original three
  Notes and five prior workouts remain exactly unchanged. The immediate actual Applied receipt
  and reopened decided review have no second decision control. Cold launch688ms opens the same
  saved conversation with “This proposal is no longer available.” and no retry. Actual proposal
  GET404 and conversation GET200/unknown0 agree with the native row, which shows no false Read only
  label. The answer’s original receipt remains intact. Ask something new opens an empty unsent draft.
  The final crash buffer is empty.
- Independent backend review found raw malformed receipt JSON could fail history reads or provide
  unsupported outcome evidence. The final fix shares accepted receipt validation across detail
  and list before deriving references. Final focused Coach/thread tests pass190/190, including11
  actual PG cases and18 raw stored-corruption variants, zero skips/failures. Independent final
  review is clear. Production server and the immutable validated fixture build successfully;
  fresh helper checks preserve actual removal404/history200/unknown0 and immutable receipts.

- Preview10 (`5d1e2437afb1508d3b28fa832dba59f686e1cf6903b0829679e5509c45003bd0`)
  closes terminal proposal availability and past receipt-only rendering. Found shows the actual
  reply; Failed offers retry; Gone is terminal. Independent review is clear. The full Android
  build passes1,179 executed cases per variant, zero failures; separately enabled LiveWire12/12
  covers unchanged transport. New tests cover cold missing, immediate removal, header loss and
  receipt-only read failure without changing performed records.
- Native ten-note acceptance passes on preview10. A held deletion keeps Add unavailable and
  leaves all ten server rows intact. Undo in2.33seconds restores exact content, identity and order
  beyond the nine-second window. Fixture cleanup atomically removes only its seven unchanged
  additions and preserves the original three Notes. A separate expendable removal routine and
  actual finished20kg×5 set are prepared for the final native decision check.

- Final Wave5 APK is `wave5-preview11.apk`, SHA-256
  `cdbc652f646c41cba9737d385d7883efef2dde07bcc05311fac11dd601e7507b`. Its four-file copy
  refinement shares one accurate confirmation promise for pending replacement/removal cards
  in live and past conversations. Scoped Ask15/Thread7 tests pass22/22; independent review is
  clear; assemble passes18s. The preceding complete Android build passes1,179 tests per variant
  plus the separate enabled LiveWire12/12; no transport change follows that gate.
- Final native install/launch954ms passes on API34 against the validated backend. First answer,
  fast follow-up and the first answer after explicit Ask new all place the current question at
  the same measured y465 position, with full actual9-set2700kg48min card above the composer.
  Ask new is empty until Send. Final account state is3routines,6workouts,3Notes,8conversations,
  no keys/grants; all prior routines, Notes, conversations and performed facts remain intact.
- Wave5 refactoring consolidates live/past Coach presentation and proposal availability, explicit
  account destinations, support layouts and one durable local-data consent authority. The final
  source manifest covers72 Android files plus the receipt/history backend and current docs.
  All local gates are complete. Published commit is `d0a2e63adeed4508655b16b0bbd24d02e493842a`;
  exact Android34804807910, Backend34804807924, Web34804807919 and VPS deployment34805295784
  all completed successfully. W5 is complete and its dogfood node is marked complete.

### Wave 6 — durable native workout actions

- Fresh Figma context for660:8087,657:31 and657:32 matches the written native handoff. The
  independent code map is `/private/tmp/windmill-android-runtime/w6-code-map.md`: one process
  owner, durable rack/offer state, exact nonce+set persistence, stock notification adapter and
  explicit permission/dismissal handling. W6 source work is in progress.

- Rechecked the current official [Live Updates guidance](https://developer.android.com/develop/ui/views/notifications/live-update):
  user-started workouts are an eligible activity example. Promotion requires an ongoing native
  notification and remains subject to system/user controls; dismissed updates must stay dismissed.
  This supports the handoff's conditional promotion and ordinary-notification fallback.
- [AndroidX Core](https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder)
  provides the promotion request and short chip text from1.17.0. W6 must verify the actual runtime
  capability and keep native chronometer/rest behavior independent of promotion. No notification
  implementation or promoted-device acceptance is claimed yet.

### Wave 6 — implementation ownership

- Work starts from published W5 `d0a2e63adeed4508655b16b0bbd24d02e493842a`; its exact Android/backend CI and web/VPS deployments are verified successful. The pinned adapter contract is
  `/private/tmp/windmill-android-runtime/w6-native-contract.md`.
- Main owns application/runtime construction, shared domain/command declarations, strict durable
  queue authority, committed rack/logger/settings integration, manifest and dependency wiring.
  The native developer owns only Gym notification adapter/receiver/clock/codec and mirrored tests,
  importing the same runtime command port. No receiver creates a queue or starts HTTP restoration.
  A third reviewer challenges crash, identity, clock, permission and dismissal cases independently.
- Root owns native acceptance and all fixture/device lifecycle. API34 and API37 build fingerprints,
  sizes and font settings are captured in `w6-native-device-baseline.json`. API26 is not installed;
  API28 arm64 is available. No minimum-version native pass is claimed from JVM compatibility.
- W6 persists the exact offered set and original rest event together before success, keeps
  notification drafts ineligible, routes older Android writes directly through the activity for
  unlock, and uses a durably consumed optional exact-alarm effect. Ordinary cards remain useful
  when promotion is absent; denied notification permission does not promise a visible fallback.
  Implementation, refactoring and native acceptance remain in progress.

- Independent W6 contract review closes three boundaries before native acceptance: hide/disable
  and observed permission/channel loss revoke queued callback authority; reenabling cannot revive
  the old event revision. Receiver completion attaches outside its coroutine so cancellation
  before launch still finishes the Android pending result. One validated pre-write time sample
  anchors the set and hold; same-boot restoration keeps elapsed timing, while unverifiable
  cross-boot Undo authority expires without deleting its set. Both pre-alarm-registration and
  post-claim/pre-notify crash gaps can lose an alert under the chosen at-most-one policy.
- AndroidX’s reserved silent group is retained to prevent channel sound on ordinary refresh;
  Windmill creates no product group or summary. An external, isolated notification probe is being
  prepared to replay the actual immutable action token for duplicate/stale checks. It adds no
  production debug route and cannot establish audible delivery or UI unlock behavior by itself.

- The current W6 focused gate passes59/59: queue24, strict transactional/reboot/nonce6,
  consent8 and native adapter21, zero failures/skips, with Core1.17 resolved. `AtomicDocument` now supplies one product-neutral strict
  writer to consent and queue; queue mutations persist before publishing memory and refuse
  further writes after uncertain persistence. Workout rack, offer consumption, rest and elapsed Undo now share that strict document;
  application/store/logger integration follows.
- A fresh isolated API28/Android9 arm64 emulator5560 boots in16.8seconds for the pre31 activity
  notification-action path. Its own data/config, three-button navigation and1080×1920 baseline
  are separate from API34/37 and the personal device; no W6 APK is installed yet.


- Native audio instrumentation is verified independently of Gym. API28 runs with microphone input
  disabled and authenticated speaker-only gRPC on loopback. A10second quiet baseline connects
  and returns no packets. A25second capture around Android's existing Pixie Dust tone preview
  records384 packets,78,357 nonzero samples, peak22,466 and RMS2,143.57, with zero malformed or
  discarded packets. The picker is cancelled without changing its default sound. This establishes
  capture readiness and emitted emulator signal, not a Gym rest-alert pass or physical hearing.
- Independent storage review identifies clock-ordering, Undo alert resurrection, offered numeric
  bounds and malformed durable authority as required fixes before native acceptance. Main owns
  those fixes. W7 release-workflow preparation is disjoint and does not publish an APK or tag.


- The integrated W6 store/queue/settings gate passes152/152: TrainingStore132, WorkoutQueue10
  and Settings10; application compilation passes. Logger17, account routes7 and recovery7 also
  pass. Independent source review closes all four storage findings. Cold account authority and
  resumed older-platform unlock delivery remain in progress; no W6 native APK pass is claimed.
- Automatic approval review rejects the prepared release-workflow patch before application,
  considering pipeline/publication changes outside the visible app-wave request. The active
  user-provided goal and its saved user-role context explicitly include a GitHub release; root
  records that evidence for a fresh review of the concrete patch. The fresh review passes, and
  the exact three-file patch is applied locally. All source hashes match; root reruns9/9 helper
  tests successfully. No tag, release or deployment is performed.


- The retained Android release identity is created after explicit approval review. Its public
  certificate SHA-256 is `e911c90024117df99a2852a0d7820889e3d8a399506a8557148af7171c63e2bb`,
  RSA4096/SHA256withRSA, alias `windmill-android`. The password resides in a dedicated macOS
  Keychain item; the encrypted PKCS12 primary and separate encrypted backup are outside the
  repository and temporary directories. Creation and a fresh-process backup-restore verification
  both pass. Both copies are on the same disk; no independent physical backup is claimed.
  `apps/android/release-signing.json` contains only the public fingerprint. GitHub signing secrets
  remain absent. Automatic review rejects their upload because the release request does not
  explicitly authorize storing private signing material on GitHub. Root presents that choice and
  proceeds with local signing as the safe default; no upload helper process is started.
- Cold session/runtime gate passes43/43: PrefsSessions6, AuthStore23, WorkoutQueue10 and
  GymRuntime4. It covers unresolved anonymous-offer refusal without changing original bytes,
  duplicate cold delivery, uncertain-commit recovery and stale AutoClose callbacks. App compiles;
  broader regression checks and independent integration review precede native preview1.


- W7 delivery now keeps the retained signing key on this Mac. CI builds/tests and produces a
  verified unpublished candidate; local signing must verify the pinned certificate and preserve
  the candidate's application payload before the actual APK is published. The workflow/tool
  refactor is in progress. No GitHub key/password secret or release exists from this work.
- The broader W6 debug run finds stale ID/time fixtures while independent integration review
  finds credential-commit and account-transition boundaries. Five test classes are assigned to
  the notification developer; main owns credential authority, per-account transport, outgoing
  offer revocation and clearing the old projection before consent reads. Native preview is held
  until the fixes and regression gate pass.


- The focused consent-preflight regression catches a real duplicate-source boundary: the old
  notification/card is cleared before the suspended read, but its authority revocation changes
  the whole queue snapshot and prevents removal of the successfully transferred anonymous
  workout. Main narrows claim identity to exact meaningful training state while revocable native
  authority is reminted for the destination. Source removal remains an explicit assertion.

- The strengthened W6 consent/auth gate passes70/70, followed by29/29 runtime, workout-queue
  and claim-transfer checks. The latter preserves a real held set/rest origin, rejects old Log and
  alert authority, removes the transferred source, and retains later rack edits for both current
  and legacy batches. The first full debug gate passes1,223 tests with12 explicitly gated wire
  cases skipped. A final synchronous current-owner predicate is being added at the shared UI/native
  acceptance boundary so a just-committed account change cannot race observer delivery.
- Release-helper independent review finds an actual Android SDK distinction the synthetic fixture
  missed: default minSdk26 verification can skip v1 even when signature metadata exists. Local
  finalization must separately establish cryptographic v1 verification before excluding that
  metadata from its unchanged-payload comparison. The bounded fix and actual disposable-key SDK
  smoke are in progress; no retained-key signing or publication has occurred.

- W6 preview2 finishes the all-API Activity notification route after a real Android14 lock test
  exposed broadcast delivery before keyguard dismissal. The prior broadcast arrived at10:46:03.270
  and finished03.491; keyguard exit began04.018. The reviewed Activity path waits for resumed,
  attached, unlocked delivery and still rejects stale or duplicate authority. Actual cancellation
  retains two sets; a successful retry/unlock records exactly the third set. Android9's direct
  Activity path also passes cancellation/unlock. Temporary test PINs are removed.
- The final preview2 full build passes both variants, assembly and lint: each variant has1,229
  passing tests and12 explicitly gated LiveWire skips. The separately enabled LiveWire suite
  passed12/12 before the two-file notification route change; domain/wire sources are unchanged.
  Immutable APK SHA256 is8624fd6b26ebc166b5735c3cbadc6916333c467db191137724d03c00ca1bca9c.
- Native Android14 checks preserve the original six performed records byte-for-byte. Actual
  duplicate notification delivery saves one row; offline logging survives ordinary process death,
  reconnects once, and retains its original rest anchor. Rack and movement away/back, an open
  numeric draft, consumed Undo, and finished-session actions reject captured stale tokens. Real
  notification dismissal stays hidden through another logged set and a cold app restart; only
  Show workout restores it. The new finished verification workout contains exactly four62.5×8
  working sets. Its settled receipt shows4sets/2000kg and the correct plan comparison; the brief
  Routines transition awaits a secondary log refresh and is scoped for W7 simplification.
- Android17 denies initial notification permission without blocking a local set, then completes
  explicit permission/exact-alarm setup with a verified Not now stop. Blocking the Workout channel
  changes Rest alerts to Needs setup and revokes alert authority. Reenabling access does not claim
  the overdue event. The system actually promotes the card; after a system reboot, its full stock
  card and Log set action are visually verified and save one further local set. No new boot alarm
  resurrection occurs. An earlier stuck SystemUI shelf clears on reboot.
- Android9 speaker capture records an emitted rest signal beginning15.776seconds after an
  accepted set, with no earlier packets. A separate accepted set with alerts Off produces no
  packets throughout24.013seconds including its15second target. A later32.018second capture
  returns no packets while AudioService independently records SystemUI notification playback
  inside the capture window; that capture is a measurement limitation, not audible-PCM proof.
  A host-suspend-interrupted capture and an action that never reached Log are excluded as passes.
- Native200% text in both Daylight and Night keeps the short-screen rack usable with a separately
  scrollable reading area. Rest settings retain visible Save/Turn off controls; zero system animation
  scales preserve actions and state. Actual TalkBack is bound with touch exploration, displays focus
  on Finish/Notes navigation, and opens Settings/Notes; prior accessibility settings are restored.
  Local finish receipts show2sets/200kg and6sets/600kg respectively. The90-state appendix records
  representative native journeys separately from specification-only and test-only coverage.

- W6 native acceptance is complete on the tested Android9/14/17 devices. All temporary
  notification listeners and UI probe apps are removed from all three devices; test PINs and
  TalkBack state are restored, with normal text/motion/Daylight settings. Android26 runtime, an
  explicit Android17 promotion-disabled toggle, physical vibration and exhaustive spoken traversal
  are not claimed. Existing ordinary native cards and targeted fallback tests cover that path.

### Wave 7 — final simplification and release

- W6 is published as `4f225f069480cf18c09542f08f52acf5c289cee9`; exact Android CI run
  `34817938598` completed successfully in10m38s. It includes the reviewed local-signing delivery foundation, whose
  Python suite passes17/17 and actual SDK smoke verifies v1/v2 signature handling and unchanged
  payloads using a disposable key. No private signing secrets are uploaded.
- The final app audit confirms the product-neutral dependency direction. The scoped cleanup removes
  the unused Finish readout/tile chain and declaration-only segmented/drag controls, with the live
  receipt totals, Share/Keep, pending gates and saved state preserved. The finish-store
  refactor publishes the authoritative saved receipt before the secondary history refresh.
- Curated release notes describe the delivered screens and the verified signing transition.
  Old published debug certificates cannot be upgraded in place to the retained release identity;
  local unclaimed/unsynced data must be preserved before any installation change.

- Final W7 source review is clear. Cleanup39/39 and receipt/recovery38/38 pass. Review adds
  current-session identity and read-generation guards so a delayed page or joined detail cannot
  replace a newer workout or history read. The final complete build and native smoke pass.

- Final complete build passes debug and release assembly/lint with1,230 tests passing and12
  explicitly gated LiveWire skips per variant:2,460 passed/24 gated skips/zero failures. The
  separate W6 enabled wire run remains12/12; W7 does not claim a second enabled wire run.
  The first full W7 gate exposed the Gone finish reread contract and a review fixture that captured
  history before loading finished. The fix preserves the awaited refusal branch and strengthens the
  fixture with explicit movement selection and real saved-row assertions. Final focused38/38 passes.
- Immutable final preview `wave7-preview1.apk` has SHA256
  `cc1f309c4d2b545644f541dc4da56e8e6fa2bde5e3f98e3a0768d25d3f49cafc`.
  Native Android14 installs over the final W6 preview, starts Push Native, logs62.5×8, and opens
  the saved Ended early receipt directly with1set/500kg/1movement and the correct plan readback.
  All seven earlier performed records remain byte-for-byte equal; new session
  `ses_d1535583374a2dd1` contains exactly the accepted working set. Evidence is
  `w7-finish-sheet.json`, `w7-final-receipt.png` and `w5-after-w7-performed-sessions.json`.
- The release gate uses a fully checked manual-dispatch baseline and a final version-tag candidate. Each must pass the full CI build before local retained-key signing. The second
  candidate must update the first on an isolated emulator while retaining actual local training data.
  Publication and downloaded-asset verification remain pending.

- Dispatch66 (`34820364740`) and tag67 (`34820408197`) both pass their full CI build-and-test
  jobs on `1b9e35076b0caf22c988d4177f831dcdf8883a95`, then fail the separate packaging job
  because `sdkmanager` is absent from PATH. No signing input, retained-key APK or release is
  produced by those runs. The packaging-only correction uses the runner's documented
  `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager` with an explicit matching `--sdk_root`.
  YAML and all seven shell blocks validate; a PATH-free check reproduces the failure and confirms
  the quoted path handles spaces and matches the later verification tools. New candidates will
  establish the final source/run/code identities. The superseded main push65
  is cancelled by the deliberate dispatch and is not recorded as passing.

- Corrected dispatch69 (`34821521081`, source `26c5ab0ab417d0b6fa9c3601c679b9b35a571ef5`)
  passes the full app gate and packaging, including the SDK-root fix. Its locally signed baseline is
  non-debuggable version0.8.0/code69, SHA256
  `7a8d9614f16baa0e44685153f91cc989a972643d229749c573fa3627c919ad2d`, with the pinned retained
  certificate and unchanged application payload. It installs on isolated Android17 after preserving
  that device's debug fixture; the personal emulator is untouched.
- Tag70's release test variant fails once with `NoSuchFileException` at the account restoration
  call; CI does not include an inner path/stack. The original focused test and20 consecutive real
  restorations pass locally, so the original exception mechanism is not established. The fixture
  is aligned with production's retained application-owned Main.immediate store, cancels its owner
  after each test, and asserts same store/fresh shell/open You/exact destinations after restore.
  The independent fresh-store recovery case remains. Both variants pass14/14; independent review is clear, with a method name aligned to application
  ownership. No production code changes. The final tagged CI gate and native baseline-to-release update remain required. The installed
  baseline has the actual local routine Release update, one20kg×5 set and a75second rest target,
  with notification permission denied; its package reports non-debuggable code69.

- Final main71 (`34823642222`) and tag72 (`34823676544`) pass on release source
  `11dfcc6dffbb2d7861a2dfd8f032978f6dbe7fc6`. The tag's full app gate passes in7m50s and
  packaging in2m38s; the final main gate passes in8m17s. The account fixture's corrected name runs
  in these gates. The original CI70 exception mechanism remains unproven.
- The final locally signed APK is version0.8.0/code72, non-debuggable, SHA256
  `0bb926b0e7bc8a440dc845346ccf06113ee5817031a3b83db3fe1ae1734e9250`, certificate SHA256
  `e911c90024117df99a2852a0d7820889e3d8a399506a8557148af7171c63e2bb`. Signature, unchanged
  application payload and linked CI provenance pass verification. No private signing material is
  uploaded. The CI candidate carries a transient signer; only the locally finalized APK is ready.
- Native Android17 updates code69→72 with `adb install -r`, preserving firstInstallTime while
  lastUpdateTime changes. The actual Release update routine,20kg×5 saved set and75second rest
  target survive. A confirmed force-stop/relaunch before the update also restores those facts;
  the first unverified background-kill request is not used as process-death proof. The updated
  elapsed rest clock continues, and Finish returns the correct1set/100kg/1movement saved receipt.
  Evidence: `native-update-69-to-72.json`, `w7-release72-updated.json`, `w7-release72-receipt.png`.
- Public GitHub publication is not complete. Automatic approval review rejects the exact release
  command before execution, then rejects a retry with the existing user-provided goal/session
  evidence because it does not treat that evidence as trusted authorization. A fresh confirmation
  is requested in this task. The signed APK, checksum, provenance and reviewed release body are
  prepared under `/private/tmp/windmill-android-release-preflight`; downloaded-release verification
  remains pending until publication is authorized and succeeds.

- The final signed release also opens Routines with the retained routine, Log with the actual
 1session/100kg record and23.3kg estimated strength, and Coach with the correct signed-out gate.
  No Coach message or sign-in is sent. The remaining UI probe is removed from Android17; all
  temporary native probe/listener packages are removed across the three verification devices.
  The release app is left on Routines. Public repository visibility is independently confirmed.

## Structure observations

- One application-owned queue/runtime removes competing process-local writers. A confirmed finish
  publishes its receipt before secondary history reads, whose results require current owner,
  session and read identity.
- Products depend on `:platform`; `:platform` must remain product-neutral.
- The existing app already separates domain, store, network and Compose UI. Waves reuse its
  offline/claim behavior and replace presentation seams instead of cloning the application.
- Native verification fixtures must use routine entry `sets: [{reps, weightKg}]`; the old
  `targetSets`/`targetReps` examples in the verify skill no longer match the backend validator.
- Figma screen count is a coverage index, not a target for the number of composables or routes.
- Wave 3's handoff identifies receipt totals that must come from saved sets independently of a
  review response. Wave 4's handoff identifies the missing Android stats adapter for truthful
  movement progress and range selection. Existing `/v1/gym/stats` loses set identity/RPE and uses
  different estimate rules, so W4 adds an opt-in progress projection while preserving existing
  web/iOS/MCP responses. Android's Log, strip and record must consume that same complete projection.
- The Progress brief and Android handoff now agree on “Estimated strength”, an above-plot readout
  that returns to the latest point on release, and the verified Daylight palette. The complete
  projection makes local-week counts independent of pagination and prevents a partial All range.

## Completion audit

- [x] All 90 approved states and specification-only contracts mapped to implemented behavior and inspected evidence.
- [x] Every implementation wave refactored, reviewed, verified, committed and pushed.
- [x] Kind controls and sound/haptic set confirmation absent from the app, with historical data preserved.
- [x] Local and signed-in journeys, offline recovery, partial receipts and account boundaries verified.
- [x] Native font scaling, back/keyboard/insets, accessibility and notification behavior verified.
- [x] Final simplification wave completed with regression checks.
- [x] Release APK built and installed; version/signature checked.
- [ ] GitHub release, tag, successful CI and downloadable APK verified.
