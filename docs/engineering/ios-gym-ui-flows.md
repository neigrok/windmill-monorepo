# iOS Gym UI flows

The user approved all six revised flows on 2026-10-24. Each developer assignment received its
**✅ Ready for dev** Figma links before visual implementation. Delivery status lives on the linked
Figma flows; this document records their contracts and verification requirements. Source baseline:
`a352e56b` on `origin/main`.

The UI changes are in `apps/ios/App`. Routine transaction parity spans the Swift, Kotlin and
JavaScript domains, shared contract vectors and web command translation; Android and web
presentation is unchanged.

## Approval and delivery

Each flow has one commit containing its implementation, tests, observability and documentation.
The PR preserves these six commits. Delivery requires adversarial review, a simplification/fix pass,
native and local-stack verification, and the repository's CI checks. Figma marks implementation
**🔨 In dev** and completed delivery **🚀 In production**. Shared Workout section `1114:1513` covers
both the live workout and receipt flows, so its status follows both.

## Flow contracts

| Commit | User issues | Required result | Design handoff |
|---|---|---|---|
| Coach entry and conversation | 1, 2, 3 | Opening Coach starts a fresh chat; prior chats are reached through History. Scrolling leaves all bottom tabs available. The composer has the approved field treatment without a rectangular backing panel. | [fresh](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1170-2943), [scrolled](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1203-6633), [pending answer](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1371-39474), [local History](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1371-39539). |
| Chronological log and row kinds | 4, 7, 8 | Bodyweight is part of the chronological log, including a weigh-in recorded between two same-day workouts. Workouts, weigh-ins and new bests have distinct treatments and actions. Weigh in floats on the canvas without a full-width backing panel. | [timeline dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1153-2765), [daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1153-2892), [swipe](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1185-4905). |
| Weigh-in presentation | 5, 6 | The calendar permits another date to be selected. Keyboard and sheet layout avoid excess bottom space and an over-tall sheet. | [typing](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1191-5884), [calendar](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1370-10395), [invalid value](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1370-10756), [correction](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1370-10939). |
| Live workout | 9, 10 | The phone ledger is compact; the unapproved sets/unit/dots strip is removed. Add movement opens a usable picker, adds the selected movement and returns to the logger. | [rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1150-2352), [picker](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1365-9267), [selection result](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1365-9340). |
| Workout receipt | 11 | Crown + Share with Coach and Done use two spaced full-width actions. Discard is in a native top-corner ellipsis menu. Behavior and reachable touch targets are preserved. | [receipt](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1182-4744), [top-corner menu](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1370-38831), [discard confirmation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1370-38879). |
| Routine movement editor | 12 | Targets are editable on the same screen as exercise name and equipment; the separate Targets screen is removed. | [editor dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1181-4473), [editor daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1367-10387), [creation with keyboard](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1367-9840). |

All frames below are in the same Figma file as the links above. Paired IDs are dark/daylight. A flow's
status covers its interaction states. Bodyweight chart reference boards keep their existing chart
design; the revised entry contract is in their caption.

| Flow | State frame IDs |
|---|---|
| Coach | Fresh `1170:2943/3440`; scrolled `1203:6633/6808`; completed History `1172:3561/3672`; pending answer `1371:39474/39597`; local History `1371:39539/39662`. |
| Log | Timeline `1153:2765/2892`; swipe `1185:4905/4971`. |
| Weigh-in | Typing `1191:5884/5985`; chart `1185:5500/5589`; calendar `1370:10395/11185`; invalid `1370:10756/11470`; correction `1370:10939/11653`. |
| Live workout | Rack `1150:2352/2433`; live states `1150:2495/2576`, `1150:2638/2725`, `1150:2793/2869`; assembly `1135:1875/1971`; picker `1365:9267/9417`; selection `1365:9340/9490`. |
| Receipt | Receipt `1182:4744/4871`; early finish `1182:4789/4902`; first receipt `1283:39725/39776`; top-corner menu `1370:38831/38934`; discard `1370:38879/38982`. |
| Routines | Builder `1149:2200/2353`; picker `1181:4379/4589`; editor `1181:4473`/`1367:10387`; creation `1367:9840/10456`; per-set `1367:9998/10599`; refusal `1367:10145/10719`; unsaved `1367:10295/10863`; equipment disclosure `1371:39283/39362`. |

The Coach requirement is explicitly **fresh chat on deliberate entry**. `CoachWorkspace` separates
visible selection from the request-owning `CoachConversation`. `CoachDraftStore` persists a versioned
owner/replica archive in its protected, backup-excluded file; each entry retains its transcript,
composer and photos. Owner-wide setup and rejection marks stay separate from conversation content.
Signed-out History uses the same local archive; signed-in History merges owner-matched server rows.
Opening a cached server row refreshes its turns with a read-only request, retaining its draft. Offline
refresh leaves the cached conversation usable. No-op navigation preserves its local History date.

History retains each nonempty conversation, including drafts, answering/interrupted requests and
unsaved results. It is available anonymously from the local archive. An empty visit creates no History
row and sends no network request. Foreground resume, keyboard/photo transitions, History selection and
context handoffs retain their explicitly chosen conversation. A fresh empty selection persists as
empty across relaunch while all nonempty prior entries remain in History.

Only one request can be active for the owner. A fresh canvas can hold a new draft while the earlier
request runs; Send remains disabled with **Answer in progress** and **View chat** until that request
settles, as drawn on board **08.33**. Request results update their original
conversation even when another canvas is visible. Returning through View chat never creates a new
request or silently resends an interrupted one.

The archive migrates the legacy owner file atomically into one retained conversation. Empty drafts
do not accumulate. Rejection markers, unsaved routine results and request identity survive restoration
and explicit retry. Adoption Add, explicit Discard and account deletion apply to every archived
conversation within that owner. A failed archive save keeps the current conversation recoverable and
reports through the static storage/Gym boundary. This is a private cache format change, with no
backend field added.

The approved log groups entries under explicit local-date headings, with 16-point separation between
days and 12-point separation between independent entries, using existing spacing tokens. Date headings
are accessibility headers, not actions. Workouts use filled cards. Weigh-ins use unfilled rows with
inset native separators above and below. A smaller new-best moment has a narrow vertical record
marker and sits 4 points below its producing workout, with its own progress chevron. Shape, spacing,
labels and hierarchy distinguish the types without relying on color.

A workout card opens workout detail; swipe, context
menu and accessibility discard retain the existing confirmation. A compact weigh-in row opens its
correction sheet; native swipe/context/accessibility Delete removes the same entry. Its context menu
also opens the existing Bodyweight chart/history. New best opens movement progress at its supporting
record and has no independent deletion. The compact record remains estimated strength, visibly
labelled `est`; it does not substitute a performed-set value. Consistency information and
hidden-workout recovery remain reachable without a promoted Bodyweight row.
The existing monthly consistency moment remains a compact secondary unfilled annotation with ordinary
independent-entry spacing. It has no chevron, navigation, swipe/Delete action or attachment to an
unrelated workout.

Weigh-in Date first dismisses the keyboard, then shows a full-width native graphical calendar in
the same expanded sheet. The Figma specimen is the Apple iOS 26 library's Inline picker; implementation
uses SwiftUI `DatePicker` with graphical style. It is not a custom calendar. Date selection is a
local draft: Back cancels the date change, checkmark
accepts it and returns to the preserved weight input; neither saves the weigh-in. Dates after today
are unavailable. Correction keeps the original day fixed. Typing, validation and correction states
must preserve exact domain refusals, prevent double save, survive failure and retain reachable
Cancel/Save at small phone and accessibility sizes.

Routine targets belong to a routine entry. Exercise name/equipment changes apply across the account,
including history; equipment changes recalculate volume while entered weights stay intact. The
approved combined editor uses Done/Add to stage identity and targets in the routine draft. Outer
routine Save is one atomic persistence point; outer Cancel discards all staged changes. Editor
Cancel/back restores that entry as it was on editor open, with the approved unsaved confirmation.
`SaveRoutinePlan` reads the routine and movement records, validates their captured baselines, then
commits the plan and metadata in one batch. Ownership and stale metadata/routine checks prevent a
partial save. All three domain implementations preserve optional counts and guard target load units;
former names stay in the active replica's local product cache. The editor retains optional open
targets, per-set add/delete, Ramp/Match, assistance and dumbbell load units. Bounds remain sets 1–20,
whole reps 1–100, load −500…500 excluding explicit zero and values rounded to zero; blank means
no target. Names retain the current 60-character validation. Old daylight Targets node `1181:4611`
is replaced by combined editor `1367:10387`.

The live workout ledger uses 44-point rows up to three visible rows/132 points, expanding or scrolling
for large text. Movement paging dots and elapsed/rest clocks remain; the duplicate set strip is removed.
Assembly dismisses into one populated picker; selection returns to the live logger with the new
movement current and existing set/draft data intact. Cancel leaves the workout unchanged.

Receipt actions are two full-width controls: **👑 Share with Coach** as secondary glass, then prominent
**Done**. Each is 52 points high at default text size, with 12-point separation, 16-point side insets,
16 points of top breathing room and the actual bottom safe inset. Heights grow with text. Content
scrolls above the action region. The approved gold crown uses the original-color `gym/coach-crown`
asset in `Sources/Theme/Theme.xcassets`; it changes no entitlement behavior.

A native 44-point ellipsis `UIButton` / `UIMenu` occupies the top-trailing toolbar with accessibility label
**Workout options**. Its destructive **Discard workout** item opens the existing confirmation with
the workout's actual set count. Menu dismissal and confirmation Cancel preserve the originating
normal, early or first receipt; confirmed discard opens the Log; refusal keeps the receipt and its
transient. Account transitions disable the toolbar menu as well as the bottom actions. Share retains
`coachUnavailable` gating and the existing sign-in/unavailable hints. Its contextual request keeps
`send: true`, including sign-in continuation. Done opens workout detail. The first-receipt Keep
invitation and failed-review retry stay reachable.

## Implementation boundaries

Paths in the first five rows are relative to `apps/ios/App/Sources/Gym`.

| Area | Source responsibility |
|---|---|
| Coach | `Coach/CoachArchive.swift` owns migration, persistence and adoption; `CoachWorkspace.swift` separates visible and request-owning conversations. `GymRoom.swift` handles deliberate entry and keeps Coach tabs expanded; `CoachTab.swift` owns the composer. |
| Log | `Log/LogPresentation.swift` orders factual weigh-ins separately from optional highlights; `Log/LogTab.swift` draws day groups, row kinds and the floating action. |
| Weigh-in | `Log/BodyweightScreen.swift` owns the content-sized sheet, staged graphical calendar and shared save/delete boundary. |
| Live workout | `Workout/WorkoutScreen.swift` owns one sheet destination and the compact ledger; `Workout/WorkoutSheets.swift` owns the movement picker. |
| Receipt | `Workout/WorkoutReceipt.swift` owns the two actions, native options menu and contextual handoff. |
| Routines | `Routines/RoutineBuilder.swift` stages the outer plan; `Routines/RoutineMovementEditor.swift` combines metadata and targets. `apps/ios/Domain/Sources/GymDomain/Routines.swift` owns Swift `SaveRoutinePlan`; Kotlin, `web/src/products/gym/domain/routines.js` and shared command contracts carry the same atomic transaction. |

## Weight ordering

`WeighIn.recordedAt` persists the instant of the latest save. `Bodyweight.Entry` carries that
optional instant; no new backend field is needed. Its ordering instant is available only when the
save and selected measurement day match in the local zone, allowing same-day measurements between workouts.

The selected local day remains the date of a backdated measurement. When the saved instant belongs to
another local day, or is absent, the row has day-only precision and requires a deterministic placement
within that day. The approved design places these after all timed entries on that selected day
without a clock label. A correction saved on the same day
can change its order because `recordedAt` is the latest save time. If original placement must survive
correction, a separate effective/measurement instant and a broader data contract are required;
`recordedAt` must not silently change meaning.

## Verification and evidence

The implementation is reviewed against the linked Figma states. A design screenshot or a successful
build alone does not establish runtime behavior. The release record must attach native results,
local-stack event/failure receipts and CI results to the six flow commits.

Recorded local checks under `/tmp/ios-gym-ui-verify`:

| Check | Recorded result | Evidence |
|---|---|---|
| Signed app and test build, Xcode 27.1 | Build for testing succeeds. | `all-build-signed.log` |
| Signed app units | Full run: 712 of 714 pass. Focused Bodyweight rerun: all 15 pass, including the two corrected expectations. No second full 714-test run is claimed. | `app-unit-signed.log`, `coach-weight-review.log` |
| Swift Bodyweight domain | 29 tests pass. | `domain-bodyweight.log` |
| Swift routine domain | 14 tests in two suites pass. | `domain-routine-plan.log` |
| Swift Gym domain | 142 tests in 14 suites pass. This is the Gym portion, not a pass for the full package invocation. | `domain-full.log` |
| Swift routine optional-count parity | Five test functions pass, including the routine corpus with 36 cases. | `routine-optional-count-swift-xcode.log` |
| Android routine parity | Domain test task succeeds; corpus reports 13/13 files and 680 cases. | `routine-optional-count-kotlin.log` |
| Web Gym domain | 721 tests pass, including all 680 applicable shared product vectors and 36 routine cases. Engine-backed checks cover atomic storage retry, concurrent equipment refusal, local former-name/count persistence and held-delete Undo. | `web-gym-parity.log`, `web-routine-plan-tests.log` |
| Full web build | `npm run build` passes 3,170 ordinary tests and four performance tests with no failures or skips, strict domain types, the sync bundle, Vite and landing shells. Layering scans 13 kit and 19 domain files with no findings. | `web-routine-parity-build.log` |
| Coach revised UI | Conversation and fresh-entry-while-answering captures pass, as does pending-answer/draft recovery through History: three focused UI tests. | `coach-weight-review.log` / `.xcresult` |
| Coach journeys | Both anonymous journeys and signed-in ask/read/apply/history pass. | `coach-live-ui.log` / `.xcresult` |
| Live workout | Movement picker cancellation, reopening and custom creation without losing the rack pass. | `coach-live-ui.log` / `.xcresult` |
| Log presentation and actions | Screen captures and entry actions pass in both appearances. | `log-review`, `log-actions-final` logs / `.xcresult` |
| Compact editor and weigh-in | Both routine-editor tests, weigh-in validation/keyboard clearance, calendar date staging and largest-text end clearance pass. | `compact-ui-review`, `compact-ui-final` logs / `.xcresult` |
| Offline routine entry | Both signed-in black-hole and signed-out stalled-network tests pass. They stage combined-editor Add before outer Save and retain cold-launch, resume, relaunch, account, hidden-workout and Journal assertions. | `offline-route.log` / `.xcresult` |
| Routine route and accessory layout | Three tests pass: the floating-layer capture in both appearances, Log clearance after returning from detail with a hidden workout, and clearance as the tab bar compacts/expands. Both layout tests create their routine through the combined editor. | `routine-route-audit.log` / `.xcresult` |
| Compact workout | Workout and movement-picker captures pass. | `compact-ui-final.log` / `.xcresult` |
| Final receipt | Five tests pass across two bundles: normal/early/first receipt behavior, confirmed discard, receipt/content and menu/confirmation captures, and all four edges of the native 44-point target. Final captures show the approved gold crown and 52-point actions. | `compact-finish-approved`, `compact-native-target` logs / `.xcresult` |
| Designer runtime review | Reviewed states of all six flows have visual acceptance. Coach and receipt large-text pixels are outside this review's evidence. | `runtime-design-review.md` and its named capture manifests |
| Real-backend Gym | Three journeys pass across the aggregate and focused signed rerun: anonymous adoption, separate finished/open anonymous workouts, and signed routine/workout/receipt/log/record/weight/note/edit. | `gym-backend-final`, `gym-backend-signed-final` logs / `.xcresult` |
| Isolated signed Gym | Signed journey passes again without parallel UI tests; 99 first-party events include the new flow steps. One non-fully-blocked hang is recorded after edited-set Save. | `gym-backend-serial.log` / `.xcresult`, `gym-serial-evidence.json` |
| Baseline comparison | Original signed journey passes in 98.405 seconds with 84 iOS events and the same hang category at the same edited-set Save boundary. Original/copied debug-library hash and UUID match. | `baseline-native/evidence.json`, `binary-identity.json`, `gym-baseline.log` / `.xcresult` |

The isolated backend journey completes eight account/Journal steps: anonymous writing, Keep, backed-up
email sign-in, revoked-session pause, same-account recovery, sign-out Keep, sign-in again and an
injected handled auth failure. Postgres receives 41 first-party iOS events; the local Sentry collector
receives one decoded `WindmillHandledFailure` envelope for `auth_request_code`, HTTP 502. The scan
finds none of the fixture page text, email or auth code. Evidence is `telemetry-journey.log` and
`telemetry-evidence.json`. This verifies that journey's intake and scrubbed failure path.

The signed Gym backend journey records 99 first-party events, including combined-editor stage,
workout-picker open/cancel, weigh-in calendar open/cancel, fresh Coach entry from the tab and receipt
menu activation. The isolated run records 352 structured writes. Its privacy scan finds no fixture
content, email, session tokens or links in events or Sentry envelopes (`gym-telemetry-evidence.json`).
These receipts cover the named local paths; they do not prove external Amplitude/production Sentry delivery.

Three `App Hang Non Fully Blocked` reports occur during parallel Debug simulator journeys. The
isolated signed rerun adds one after edited-set Save, while the existing load-wheel sheet closes;
its sampled stack shows UIKit picker/hosting-view destruction and notification-observer removal.
The original baseline journey reproduces the same category at that boundary, with framework layout
and environment updates. No changed flow function is identified. The baseline is `a352e56b` plus its
already-recorded nonvisual `CoachBubbleShape` compiler-compatibility declaration; only the copied
host was re-signed, and the original/copied debug-library hash and UUID are unchanged.

This establishes a pre-existing simulator responsiveness issue, not harmlessness, equivalent severity
or rate, or release-device performance. Dogfood follow-up `ios-workout-load-wheel-responsiveness`
covers profiling edited-set Save / load-wheel dismissal in a signed Release build on a physical device,
including repeated open/save/close cycles. Compare
main-thread duration and traces against the baseline before selecting a fix. The scoped stack and
timestamp comparison is `gym-hang-audit.md`; baseline and serial privacy scans find no fixture content
or credentials in their event/envelope payloads.

Local Xcode 27.1 architecture-probe failures also reproduce on clean `a352e56b`
(`domain-baseline-architecture.log`); they do not establish a change regression. CI is pinned to
Xcode 26.3 and remains the authoritative full compatibility gate. The pure `CoachBubbleShape` and
archive content predicates declare their nonisolated behavior explicitly. `CoachScreensTests`
expresses its eight cases as a typed loop to avoid the Xcode 27 macro type-check timeout.

The preimplementation `GymWorkoutFlowTests.testPagerAndAssembly` also passed once on iPhone 17 /
iOS 26.5, including movement selection and logging. It did not reproduce the grey screen. Its result
at `/tmp/ios-gym-ui-baseline/workout-pager.xcresult` is baseline evidence, not acceptance of revised UI.

| Flow | Native and local-stack acceptance requirements |
|---|---|
| Coach | Fresh entry and explicit History return; preserved pending work, cached remote refresh, migration and account isolation; full tabs while scrolling; keyboard/composer in both appearances and large text. |
| Log | Full ordered workout → weigh-in → workout assertions; newest weight, weight-only history, pagination, day-only records, correction and timezone cases; row destinations and destructive actions. |
| Weigh-in | From the visible keyboard, open the calendar, choose another day/month, save and reopen that date. Preserve kg, cancellation and failure recovery; inspect compact phone and large text. |
| Live workout | Picker search/add/log/swipe, repeated open, cancellation and custom creation; compact ledger and current-row visibility with large text. |
| Receipt | Options menu, outside dismissal and Discard cancel/confirm retain normal/early/first receipt and actual set count; Done and Coach/sign-in handoff; account transition and unavailable Coach; 52-point default actions with reachable Keep/retry. |
| Routines | Create/edit existing and custom movements with open/shared/varied targets; outer atomic save and cancel, failed commit, stale metadata, changed owner and persisted reopen. |

Native suites live in `Tests/Gym`, `GymWorkoutFlowTests`, `GymCoachFlowTests`,
`GymAnonymousCoachFlowTests`, `GymIntegrationFlowTests`, `GymNightlyFlowTests` and `DesignCapture/*`.
The unit scheme is `WindmillUnitTests`. Nightly and design suites require
`TEST_RUNNER_WM_NIGHTLY_UI=1` and `TEST_RUNNER_WM_DESIGN_CAPTURE=1`, respectively. Follow
`apps/ios/App/README.md` for generation, fixture and owned-simulator setup. Local commands use
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; CI uses Xcode 26.3.

Local-stack acceptance follows `.claude/skills/verify/SKILL.md`: isolated Postgres/backend/Vite,
fixture accounts, real native writes, and inspection of structured write logs, first-party event
rows and scrubbed Sentry envelopes. The event/failure contract is
[IOS_OBSERVABILITY.md](../IOS_OBSERVABILITY.md). First-party intake and local Sentry receipt do not
prove Amplitude or production Sentry delivery. The recorded native checks cover only the named
cases; remaining runtime, accessibility and telemetry acceptance need their own result artifacts.

## Structural observations

- Factual log records are independent of optional highlights, so highlight selection cannot hide weights.
- The read model carries the persisted timestamp instead of introducing a duplicate field.
- Coach selection is separate from request ownership and foreground recovery.
- Workout sheets share one destination with an explicit dismissal handoff.
- Routine metadata and targets commit together through a domain action.
