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
| 4 | Log history, movement records/rename, bodyweight entry/correction, pagination and empty states | Share record rows and coherent loading/error/empty states | Verified locally; publication gate pending |
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
- W4 publication is the remaining wave gate.
  Publication must also pass Backend CI/CD and its automatic Deploy to VPS run: the existing
  workflow pins both checkout and container image to the triggering commit. The release APK uses
  windmill.works and therefore depends on successful backend deployment, not only Android CI.

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

### Wave 5 — integration preparation

- A separate backend implementation is assigned to `codex/android-w5-coach-evidence` in
  `/private/tmp/windmill-android-wave5-backend`, based on published W3. It must leave the W4
  worktree/runtime/database untouched and remain uncommitted until independent review and
  integration after W4 publication. The new checkout was created from `c8becf80`; W4 remains
  untouched. The typed receipt contract is pinned in the delivery handoff, including actual
  opening/failed tool steps, successful scoped observations and immutable per-answer persistence.
  Backend implementation is frozen and independently reviewed:169/169 focused cases pass with
  zero skips, including eight real Postgres cases; production server builds and idempotent schema
  application pass. Integration waits for W4 publication. A deterministic local model-boundary
  harness is being prepared outside the repo for native acceptance; no vendor/email run is claimed.
- Notes implementation is assigned separately in `/private/tmp/windmill-android-wave5-notes`.
  It owns only Notes list/editor, pure limits and mirrored tests; main retains TrainingStore and
  GymRoom integration. Current callbacks are pinned, with raw drafts/stable IDs, exact Unicode/
  UTF-8 limits, accessible reorder and independent Undo. Consent's durable manifest schema is
  still being pinned before implementation.
- Read-only preparation identified two required data boundaries: Coach currently discards read
  facts before storing answer history, and normal anonymous workout/bodyweight data is adopted
  automatically during account connection. The existing “These are mine” row covers legacy
  quarantine only. W5 must persist authoritative answer evidence and require an explicit durable
  ownership decision before transferring anonymous data.
- Preserve existing owner-scoped unsent work: “unclaimed session” also includes authenticated
  work awaiting the server, so it cannot be used as the consent flag. Claim recovery needs a
  frozen source manifest assigned to one account before any queue/log/bodyweight/settings move.
- Capture Coach evidence at successful tool responses, preserving summary/full-session/movement
  scope and the historical facts the answer actually saw. Store it atomically with the answer;
  old answers have absent evidence. No new endpoint, schema or consent implementation is claimed.

### Wave 6 — native capability preparation

- Rechecked the current official [Live Updates guidance](https://developer.android.com/develop/ui/views/notifications/live-update):
  user-started workouts are an eligible activity example. Promotion requires an ongoing native
  notification and remains subject to system/user controls; dismissed updates must stay dismissed.
  This supports the handoff's conditional promotion and ordinary-notification fallback.
- [AndroidX Core](https://developer.android.com/reference/androidx/core/app/NotificationCompat.Builder)
  provides the promotion request and short chip text from1.17.0. W6 must verify the actual runtime
  capability and keep native chronometer/rest behavior independent of promotion. No notification
  implementation or promoted-device acceptance is claimed yet.

## Structure observations

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

- [ ] All 90 approved states and specification-only contracts mapped to implemented behavior and inspected evidence.
- [ ] Every implementation wave refactored, reviewed, verified and published.
- [ ] Kind controls and sound/haptic set confirmation absent from the app, with historical data preserved.
- [ ] Local and signed-in journeys, offline recovery, partial receipts and account boundaries verified.
- [ ] Native font scaling, back/keyboard/insets, accessibility and notification behavior verified.
- [ ] Final simplification wave completed with regression checks.
- [ ] Release APK built and installed; version/signature checked.
- [ ] GitHub release, tag, successful CI and downloadable APK verified.
