# Journal and Gym refinement observations

The Journal's written-day projection requires non-whitespace text. Mood, energy and invitation
retirements cannot create a day. Erasure retains the sync version needed to prevent stale devices
from resurrecting writing, while Journal reads, exports and counts exclude it. Adoption presents
written days and preserves the engine's original counted tokens for authorization.

The iOS app injects immediate removals into its action runner. Shared engine hold semantics remain
available to other clients. Whole-workout and conversation deletion use native confirmation;
the system may dismiss that confirmation outside its popover on iOS 26. Tests cover cancellation
as well as committed deletion. The app has no Undo band or delayed removal task.

Routine summaries are sheets with Close, Edit and Start. Starting waits for dismissal before
opening the workout. Start stands in the sheet's reach band and spans it. The band is on a surface,
so the movements pass under it on a hard edge over the bar material and no row reads through Start.
`GymIntegrationFlowTests.testRoutineWorkoutReceiptLogRecordWeightNoteAndEdit` holds Start to at least 85% of the
window's width. Workout pages use the native pager and page control. The compact ledger
contains the saved sets and preserves access to earlier rows without a duplicate statistics strip.

Coach history invalidates reads at both the start and completion of deletion, so a concurrent
response cannot restore a deleted conversation. Receipt sharing retains its intent through sign-in
and clears that intent when sign-in is cancelled. Event labels contain no writing, ratings,
workout names, questions or credentials.

The routine sheet, workout, receipt and Log deletion are drawn in light and dark on the Gym file's
[iOS page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2), in flows 02, 03 and 05.

Destructive actions use the system roles and presentation described in Apple's
[action sheet guidance](https://developer.apple.com/design/human-interface-guidelines/action-sheets).
The app keeps Done primary and sharing secondary on the receipt, with Discard in the native
top-trailing options menu.

The web Gym test browser declares its localhost hostname. Without that complete location fixture,
telemetry can open real network requests while tests control timers, contaminating later tests.
The isolated Gym suite passes with the corrected fixture and unchanged application telemetry.

Local verification uses an isolated Postgres database, the rebuilt C++ server, Chromium and an
iPhone simulator. Backend domain, MCP, sync and adapter cases pass; client-only corpus files and
the optional pattern fixture are reported separately as skipped in the C++ domain runner. Swift
domain tests, the 1,601-vector Swift corpus and 792-vector Kotlin corpus pass. Browser Journal e2e
passes all ten scenarios; Gym web tests pass with fourteen existing skips. Native checks cover
Journal erasure after relaunch, routine sheets, workout paging, receipt actions, account adoption,
Coach history deletion and authentication handoffs. Local first-party events and Sentry envelopes
contain only bounded technical labels; the known content and credential scan finds no matches.
External Amplitude forwarding and production Sentry delivery are not exercised by this local run.

Signed-in Coach uses the existing conversation, attachment transport and Gym sync door. Draft
creation holds a durable operation; explicit user confirmation settles it with the exact server-held
document. There is no model confirmation tool. One shared RoutineEntry serializer serves saved
routines and review drafts. Equipment and one/two-dumbbell overrides are additive exerciseName
metadata, keeping immutable seed equipment and raw logged weights intact.

Actual-provider verification on `ff00193b` passes all 77 checks across four generations and 13
healthy model rounds. Typed goal setup and creation cost $0.141863500, a fresh free-account photo
import costs $0.100769750, and the One photo import costs $0.084043000. Both photo flows reproduce
the image's exact exercise grouping and targets without invented weights. Reservations settle at
actual cost with no debt or uncertain holds; replay creates no provider cost. The observed output
ceilings remain 2,000 throughout this run, so reduced-ceiling behavior is established by local
boundary tests. First-party events and local Amplitude/Sentry collectors verify bounded labels and
absence of private canaries; production telemetry delivery is not established by this run.

Schema verification compares complete data and catalog snapshots, including constraint identity.
The output-offer migration adds its constraint only when absent, retaining historical reservations
and avoiding constraint replacement on each deployment. Upgrading from the production schema, repeated
application and all 1,275 Postgres adapter cases pass locally.

Production activation for merged source `617b373a8af3181acc7fc4b9e1b5a64670263f2c` is verified by
the [enabled deployment](https://github.com/neigrok/windmill-monorepo/actions/runs/39571832936) and
[main-source deployment](https://github.com/neigrok/windmill-monorepo/actions/runs/39573012755).
The runtime has USD enforcement and anonymous installations enabled, Cloudflare client-IP handling,
an installation network key present and a 2,000-token output ceiling. Public checks at
2026-10-21 08:47:42 UTC pass all eight assertions: schema 6, credential issuance, format and readback,
a private `no-store` response, and the unbound
anonymous lifetime allowance of $0.05 with no used or reserved cost. These activation checks make no
provider calls. Verified free accounts receive $0.25 per month and funded One periods receive $7,
with free spending capped at $5 per day and $100 per month. Alerts target the configured owner address.
Journal voice remains unavailable pending supported audio accounting.

UI checks query the exact current accessibility value after returning from a Live Activity. A
retained element can carry an older snapshot even when the same attachment's fresh query shows
the completed write; the ledger assertions still verify every saved set and its identity.
Log navigation permits one recorded re-tap inside its existing deadline only while the original
Routines tab remains selected and no alert or sheet is present. The target and content assertions
remain exact; this recovers a lost synthesized tap without claiming first-tap delivery is reliable.

Release **0.2.0 (22)**, source `3b563f5e69053ac0eb1d51609951a8f6a577ec64`, is uploaded to
App Store Connect by [iOS release run 22](https://github.com/neigrok/windmill-monorepo/actions/runs/40195776761).
The 2026-10-25 run passed archive, stored-certificate verification, symbol retention and export;
Apple confirmed *Upload succeeded* at 13:11:00 UTC. The archive-derived `testflight-status-22`
artifact confirms version `0.2.0`, build `22`, bundle `works.windmill.app`, processing `VALID`,
internal state `IN_BETA_TESTING` and external state `READY_FOR_BETA_SUBMISSION`. This release
changes no tester groups and submits no external beta review or public App Store release. The
read-only check does not inspect individual tester membership or device installation.

The release includes the six approved Gym flow corrections from PR #35. Its iOS and release inputs
match merge `446f2d6698f14dd2787332e76fad2c6ee7f7d0f4`; the only later changes are Roadmap
documentation. [Main-source iOS CI](https://github.com/neigrok/windmill-monorepo/actions/runs/40039570945)
passes, including all 714 app tests, package/Release builds and the three UI shards.

The retained `ios-dsyms-22` artifact contains the app and workout widget DWARF symbols and is kept
for 30 days. Export reported the nonblocking warning *Upload Symbols Failed. The archive did not
include a dSYM for the Sentry.framework*. Production Sentry symbolication is not verified.

Anonymous Coach uses one installation boundary, durable request records retained per conversation
and one domain import Action. The import validates every routine before one engine Plan commits routines and replay metadata.
Installation issuance is coalesced across account transitions; its Keychain record is separate from
account credentials. Local draft adoption writes the target archive and source marker atomically before
removing the source, so retry preserves pending responses, photos and unsent drafts.
Stop waiting preserves the original request and cannot promise cancellation of provider spending.
Static refusal copy is shared by current errors and retained records. Model-server UI fixtures exercise
the same transport decoding and domain import as the opt-in HTTP verification.

The current anonymous HTTP harness passes 112 checks against the isolated backend and deterministic
provider, including greeting, context continuation, drafts without server routine writes, replay,
legacy goal/program/photo inputs, budget accounting, injected failure reporting and local event/log
privacy. Deterministic checks do not establish actual-provider response quality.

Coach fixture authentication completes before the app model is published. Anonymous fixture scenarios
retain their local seat until the test uses the account flow; view-time preparation only seeds data for
an existing account. This keeps setup activation independent of fixture sign-in timing. Anonymous
navigation checks require the Coach setup controls while Notes and Connected log retain their account
gates. The shared return-navigation assertion names its expected control and retains History for
signed-in callers.

Offline verification fixtures use a fixed clock across cold launches and resumes, so UTC midnight does
not change the page under a local-persistence assertion. UI shards assign integration cases with the
workout/account group and onboarding/shell cases with routines/journal; all 16 UI classes remain
selected exactly once. The grouping balances the measured class durations without reducing coverage.
Native verification is repeated for the current Coach review and dialogue flow; the retained CI and
release artifacts identify their own source revisions and do not establish this working tree’s checks.

Coach greeting visibility has its own durable acceptance state, independent of draft text, attachments
and navigation choices. The anonymous dialogue request retains its exact bounded context and request
identity; successful dialogue may have no routines. A result is separate from a save: both anonymous
and account drafts use one review surface, and only explicit Save produces creation receipts.
Anonymous result replay remains one atomic domain import and is available after deliberate account
adoption; resumed bound-installation work reads the retained request without dispatching another model
call. Account confirmation consumes the immutable server document and updates the conversation’s
held draft and receipt together.

Stream liveness comes from transport activity, including SSE comments. The app does not infer a
broken Coach connection from a quiet model interval or the sync channel’s separate reconnect state.
A real dropped active stream retries its stable request a bounded number of times, preserving partial
output; accepted transport activity clears the reconnect notice. Allowance recovery is separate from
balance display, and signed in a spent allowance offers no upgrade while paid plans are closed.

Exercise identity and equipment share one editor. Read paths resolve current names from the stable
catalogue identity. External-load volume uses each set’s equipment basis and one/two-dumbbell count,
while displayed load and strength estimates retain the entered per-dumbbell amount. Workout rack
feedback updates immediately; persistence coalesces rapid taps into one save, which also runs before
sign-out, a seat change and backgrounding, so the last accepted value is kept. A tap made while an
account change is under way is refused with *The rack could not be changed. Try again.* Routine rows
expose reorder handles directly; root creation controls use one bottom-trailing plus. The Live
Activity’s primary clock anchors to the most recent valid set, or session start before the first set.

The focused native Coach suite passes 93 tests, including a transport configured from the production
8-second authentication session: Coach overrides its idle timeout to 60 seconds and stays live
between heartbeat comments. The fixture-backed anonymous light and signed-in review/save UI cases
pass. These checks exercise explicit Save, durable replay, failed-send draft retention, greeting
persistence, and the absence of automatic routine creation. A final simplification removes unused
allowance-display and automatic-import progress state; broad final verification belongs to the phase
gauntlet. The actual provider and external production telemetry are not exercised by this run.

Coach offers routine drafts only to a client that sends `routineReview: true`, which every current
client does on each ask; an older build that omits it gets no draft tool, and Coach tells it new
routines need an app update or Routines. Nothing is ever written without the lifter's Save.

Exercise edits use an account-scoped receipt committed with the sync-engine mutation. Lost Coach
acknowledgements recover that original result without overwriting a later user edit. Swift history
reads resolve the same equipment quantity as the other surfaces; their tests cover paired/single
dumbbells and changed equipment while preserving the original set values.

The review fix passes all 128 Swift GymDomain tests across 13 suites. Backend verification passes
2,178 domain cases (28 intentional skips), 280 MCP cases, 729 sync cases and 1,291 adapter cases,
including lost-acknowledgement recovery after a newer exercise edit.

Native iOS 26.5 simulator verification passes 11 affected UI flows across focused runs, including a full
routine/workout/history/weigh-in/note flow against the local sync backend. Seed renaming preserves
history identity and raw set values; the keyboard leaves the One/Two dumbbell selector reachable.
Rapid minus/plus presses update the visible rack and log those exact values. Both root empty states
have one reachable plus, native reorder handles stay active while target editing remains available,
and keypad digits clear the commit footer. At the largest text size the current workout row remains
whole, Coach greeting actions scroll above the composer, and the actual final review target clears
the Save footer by at least 28 points. Dark review contrast and the equipment load-basis captions
have retained native PNG evidence. Coach HTTP checks use a deterministic local provider fixture;
actual-model response quality and physical-device interaction feel are not established by them.

The rack save task weakly captures its owning GymModel. Its regression retains WorkoutState while
releasing that owner, and delayed work cannot dereference the state's unowned model. Durability and
failure tests exercise explicit flush boundaries, rapid edits through reconciliation, and account
transitions. The layout pass shares ledger header content between normal and accessible layouts,
and permanent reorder uses the existing target-navigation state without adding another route.

The affected app unit suites pass 367 tests across twelve suites: 269 in the ten unchanged suites,
then 98 in the final workout/picker run, including owner teardown and the explicit flush boundaries.
The complete app unit target passes CI run 39597020292, job 119211740948, alongside the packages and
build gate. Local focused execution succeeds after preparing the dedicated simulator. The final
rapid-button UI check also exercises the weak-owner persistence fix.

The Coach composer uses a direct safe-area inset without a backing panel. Its native field and
the parent focus state share the same host, so Done and tab-bar visibility follow keyboard focus;
the greeting retains its scrollable layout at accessible text sizes. The signed-in UI helper requires
Done to dismiss the keyboard without losing the draft, then refocuses and sends. Anonymous checks
require the same keyboard, Done and tab-bar behavior. The retained Xcode 26.3 / iOS 26.5 result
contains five passing focused UI flows: signed-in Coach in light and dark, anonymous Coach at the largest text size, and Log
in light and dark. The Log correction retains an exact assertion for the barbell label,
`Weight, 90 kg total`. The native flows use local model-server fixtures; they verify keyboard focus, draft
retention, navigation, review clearance and weight editing without making a claim about live model
quality. The build-for-testing is clean, and the focused result contains five tests with zero failures.

A Coach handoff carries the account it was asked under. An account change drops only a handoff
asked under another account, so the sign-in that a receipt's Share with Coach waited for keeps its
question, and Coach refuses a handoff from another account. The greeting steps aside while a message
is on its way and returns after a failed or refused one. Confirming a draft reports
`gym_coach_routine_confirm` and words each answer by what the draft can still do; access recovery is
drawn once, only where signing in can help. Movement edits write only the fields
that changed, and the load basis reads *kg each* for two dumbbells and *kg* for one.

The six iOS Gym flow corrections use human-approved designs in
[the flow contract](../../../docs/engineering/ios-gym-ui-flows.md); their delivery status lives on the
linked Figma flows. Dogfood nodes use `ios-gym-ui-oct23-*`.

Coach separates the visible conversation from the request owner. A versioned owner archive retains
nonempty chats, drafts and interrupted results for local History, including signed-out use. Fresh
entry does not clear prior work or create empty rows. Remote History refresh is read-only and keeps
an unsent draft; owner guards prevent late reads from reaching another account. No-op navigation
keeps History timestamps stable.

The Log carries `WeighIn.recordedAt` through the read model without a schema change. Factual weights
are independent of optional highlights, so highlight limits cannot hide them. Local day groups,
workout cards, separated weigh-ins and subordinate record markers distinguish their destinations and
deletion behavior. Day-only records follow timed records without an invented clock time.

The weigh-in sheet measures its content and stages a native graphical calendar in the same sheet
after dismissing the keyboard. Cancelling the calendar keeps both the prior day and typed kg;
accepting a date does not persist the weight. Correction keeps the original day fixed.

The workout ledger limits default-height rows while allowing accessibility expansion. One sheet
destination sequences assembly dismissal and picker presentation, preserving the rack through
selection and cancellation. The duplicate statistics strip is removed.

The receipt uses two full-width actions with the Coach crown, plus a native top-corner Discard menu.
Confirmation uses the actual set count; cancellation retains the originating receipt. Coach handoff
keeps its existing send and sign-in continuation, with account transitions disabling all actions.

The combined routine movement form stages metadata and targets together. `SaveRoutinePlan` validates
captured routine and exercise baselines and persists one atomic batch; failed or stale saves cannot
leave metadata partially committed. Outer Cancel drops the complete draft. Swift, Kotlin and
JavaScript share the transaction contract, including optional counts, guarded target load units and
local former-name storage. Android and web presentation is unchanged. JavaScript engine-backed tests
cover atomic retry after storage failure, concurrent refusal, cache persistence and held-delete Undo.

Recorded checks for these flows include 29 Swift Bodyweight tests, 14 focused routine-domain tests,
142 Gym domain tests, five optional-count test functions including 36 routine corpus cases, Android
domain parity (680 corpus cases) and 721 JavaScript Gym tests, including all 680 applicable shared
product vectors and 36 routine cases. Full `npm run build` passes 3,170 ordinary tests and four
performance tests with no failures or skips, strict domain types, sync bundling, Vite and landing
shells; layering scans 13 kit and 19 domain files with no findings. Evidence is in
`web-gym-parity.log`, `web-routine-plan-tests.log` and `web-routine-parity-build.log` under
`/tmp/ios-gym-ui-verify`. The signed Xcode 27.1 app/test build succeeds. The full signed app-unit run
records 712 of 714 passing tests; the focused Bodyweight rerun passes all 15 tests, including the two corrected
expectations. There is no second complete 714-test result. The Xcode 27 architecture-probe failure
reproduces on clean `a352e56b`; pinned Xcode 26.3 CI is the full compatibility gate.

Focused native results cover Coach conversation and pending-answer captures, pending draft/history
recovery, both anonymous Coach journeys, signed-in ask/apply/history, and live-workout picker
cancel/reopen/custom creation. Log screens and entry actions pass in both appearances. Compact-phone
checks pass routine cancellation, keyboard/validation/large text, weigh-in keyboard/validation,
calendar date staging, largest-text end clearance and workout captures. Final Finish verification
passes five tests across `compact-finish-approved` and `compact-native-target`, including all four
edges of the 44-point menu target and the approved gold crown/52-point action captures. Designer
review accepts the captured states of all six flows (`runtime-design-review.md`); Coach and receipt
large-text pixels remain outside that review. Other evidence is in `coach-weight-review`,
`coach-live-ui`, `log-review`, `log-actions-final`, `compact-ui-review` and `compact-ui-final` logs/result
bundles under `/tmp/ios-gym-ui-verify`. These are scoped results, not complete accessibility coverage.

Both offline journeys pass with the combined movement editor: Add stages the selected entry before
outer routine Save. Signed-in black-hole and signed-out stalled-network checks retain their
cold-launch, resume, relaunch, account, hidden-workout and Journal assertions (`offline-route.log`
and `.xcresult`). Three further tests pass in `routine-route-audit.log` / `.xcresult`: the floating-layer
capture in both appearances and both nightly hidden-workout accessory checks. The nightly tests
create their routine through the combined editor and preserve exact Log clearance assertions after
returning from detail and as the tab bar compacts/expands.

The isolated backend account/Journal journey completes eight steps and delivers 41 first-party iOS
events plus one decoded handled Sentry envelope (`auth_request_code`, HTTP 502). The privacy scan
finds no fixture page text, email or auth code. Evidence is in `telemetry-journey.log` and
`telemetry-evidence.json` under `/tmp/ios-gym-ui-verify`. All three real-backend Gym journeys pass
across `gym-backend-final` and the focused `gym-backend-signed-final` rerun. The signed journey
records 99 first-party events, including the new editor, picker, calendar, fresh-Coach and receipt-menu
steps; the isolated run records 352 structured writes. The Gym privacy scan excludes fixture content,
email, session tokens and links (`gym-telemetry-evidence.json`). External vendor delivery is not established.

The isolated signed Gym journey also passes with 99 events and a clear privacy scan
(`gym-serial-evidence.json`). One non-fully-blocked hang follows edited-set Save as the load-wheel
sheet closes. The original baseline journey passes with 84 events and reproduces the same hang
category at the same boundary (`baseline-native/evidence.json`); original/copied debug-library hash
and UUID match. Together with the three parallel-run reports, this establishes a pre-existing
simulator responsiveness issue, not harmlessness or equivalent severity/rate. The scoped assessment
is `gym-hang-audit.md`.

Dogfood follow-up `ios-workout-load-wheel-responsiveness`: profile edited-set Save / load-wheel
dismissal in a signed Release build on a physical device, repeating open/save/close cycles. Compare main-thread duration and traces with the baseline
before selecting a fix. Current sampled stacks show framework rendering/teardown and no changed flow
function; release-device performance remains unmeasured.

UI tests find a room-menu row by its `room-…` identifier or its room's title through
`XCUIApplication.roomItem(_:)`. `PalettesTests` holds the palettes to exactly the theme catalog's colours, each
carried by the app's bundle.

Every button role a room draws lives in `Theme/RoomControls.swift`: the primary (`RoomPrimaryStyle`), the
secondary (`RoomSecondaryStyle`, its label in the room's ink when given the room) and the glass seat. The drafts
card's decisions are the primary and the secondary at full width, stacked by `CardDecisions` beside `ChangeCard`; a
proposal's stand in one row, Reject then Apply, through `DecisionRow`; a removal is the secondary with the destructive
role. `RoomGlass` is the one Liquid Glass surface, the regular material before
iOS 26, under the seat, the floating act and the transient band. `GymTransient.Band` resolves the band's words
and its one control from plain values, and `GymModel.dismissError(_:)` clears the error a band showed. A read
the room cannot make goes through `GymModel.failRead(_:)`, which says `GymModel.unreadable` and reports under `gym_read`.
`DestructiveQuestion` takes only telemetry and the account. Every card on a room's canvas takes `RoomSpace.cardRadius`,
22 pt with continuous corners, through the `.card` shape; a card the system's inset-grouped list draws keeps the
system's corners.

The refactor draws the same pixels. Throwaway captures before and after it, in Dark and Daylight on iPhone Air
(iOS 27.0) and iPhone 17 Pro (iOS 26.5), compare the Coach greeting, Routines with its floating plus, the routine
sheet's reach-band Start (on `2e36dd27`), The log, the weigh-in sheet, the discard alert, the rack, the receipt,
the transient band at default and AX3 sizes, the welcome and the first onboarding page. With the status bar and
the home indicator masked every pair is identical, except for differences of at most two levels on Liquid Glass
that two runs of the same build also show, and the iOS 26.5 Daylight receipt, whose sheet differs by up to 13
levels between any two runs, the same build's included. Coach's cards were not reachable: the signed-in capture
helpers fail before Coach opens. Their decision style renders byte-identical to the previous one in an
`ImageRenderer` check, light and dark, enabled and disabled. iOS 18's material branch has no simulator here and
is unverified.

The rack's load follows Direction A (Gym · iOS 03.23A, 03.30, 03.34a–c, owner approved 2026-11-07). The numeral is
`LoadField` in both states, so there is no swap between a `Text` and a field and nothing travels on landing; the cost
is that the numeral no longer rolls on a ladder step, a `TextField` taking no `numericText` transition, and the reps
value keeps the roll. The field writes live, every key the load its text stands for, and as it lets go only an unreadable
text writes, restoring the load it opened on, so a change the host made meanwhile — Log set's prefill of the next slot —
is kept (`WorkoutRenderingTests.testAChangeMadeWhileTheLoadIsFocusedIsKeptAsItLetsGo`). Focus is the screen's
`@FocusState`, passed to the rack as a sheet passes it to its `LoadRow`; `WorkoutState.typingLoad` follows it, and a land
flushes the rack at once. The rack is a `ZStack` over a page that ignores the keyboard and keeps the rack's resting height
as bottom padding (`WorkoutLive`), so the pager keeps its full height and hit-testing while the keyboard is up. It is not
a `reachBand`: tried on 26.5, a `safeAreaBar` reported no focus for the field, so a typed 105 appended to the selected
100 as 100105 and the rack never moved. The numeral is sized to its row by measuring its text with its own
face (`WorkoutRack.numeralPoints`, `testAWideLoadKeepsItsUnitInsideTheRackAtLargeText`): `lineLimit(1).minimumScaleFactor(0.5)`
on the `TextField` fits a wide load at xxxLarge but never settles its layout at accessibility sizes — the large-text
render hung past a three-minute allowance until it was removed. A ledger row carries its `load`,
nil while last time is unread, and its `reps`; `Readout.effort(load:reps:)` spells both the row's reading and the logged
summary, and `LedgerCard` draws the rows for the page and for the 03.34 renders alike. Observation: the typed load's
tick and save ride on `typingLoad`'s `didSet`; a small `RackEntry` value (opened load, typed flag) the state owns would
be the cleaner shape if a third entry mode ever appears.

Routines follow Direction L (Gym · iOS 02L.1–02L.8, owner approved 2026-11-07): the editor, the movement form, the
picker and the summary are stock `Form` parts. The targets draft is numeric (`TargetsDraft`: a count over rows that keep
their place past a smaller count, straight or varied, bounded by `RoutineRules`), so a typed-text refusal has nowhere to
land; what the form cannot express the domain never sees, and Save keeps the one refusal left, the load floor. A load
field is one `LoadField` of one of two kinds: logged, a load always a number in its well (the rack, Fix set, Edit sets'
open row), or planned, a routine target that may be none, a stock trailing field. Letting a field go writes nothing — every
key already wrote what its text stands for — so a host lands the last key's load and nothing after it. The rack sizes its
numeral to the text the field reports by preference. The movement form is a sheet stacked over the editor from the
editor's `NavigationStack`, so it opens over the pushed picker too and a Cancel there returns to the search. The Routines
boards draw from one fixture, `-coach-board routines`. The capture exporter's name rule admitted only lowercase, so
`02L.*` captures were dropped until it took the direction letter. In XCUITest a stock menu `Picker` is a Button whose
label is its title alone, a `Stepper` exposes `<id>-Increment` / `<id>-Decrement`, and in a List's edit mode a swipe on a
Button row taps it, so the trash circle is reached through the minus badge; a List keeps a row scrolled above the fold at
a stale frame, so scrolling back to it is counted drags, not a wait on the row. Observation: `MovementEquipmentPicker`
carries a `count` style only because Edit movement's board still draws the segmented pair.

Proposals follow the stock pass (Gym · iOS 08.2P, 08.12P–08.14P, 08.27P, 08.56P, 02L.1P, 02L.9P, 02L.10P, owner
approved 2026-11-08). `ProposalCard` holds one decision — the stall and its Try again, the landed haptic, the queued
decision, the receipt's acknowledgement — and draws it in one of two presentations: the conversation's `GroupBox`
card, or the Routines row's sheet as a `Form` (`ProposalSheet.swift`), whose toolbar applies and whose Reject row
closes it. The change parts are shared from `ChangeBlock.swift` (`ChangeTitle`, `ProposalField`, `ProposalHeading`,
`DecisionRow`); the drafts card, a made movement and the workout receipt keep `ChangeBlock` with its kind word, the
language their boards still draw (consistency 12t). The read line stands under every answer, above its cards. The
capture rig's `-routines-tool-proposal` has Claude, over a connection, propose on the model server — the board's
changes to Push A, and one to Legs that the phone's edit puts out of date — so the sheet has captures
(`RoutinesCaptures.testConnectedToolProposals`). On the `remove` board the same rig has Claude propose removing Arms,
and the sheet's Remove asks first (02L.11P, `RoutinesCaptures.testConnectedToolRemoval`). The question is the
shared `DestructiveQuestion` as a dialog on the toolbar's Remove itself, so iOS 26 presents it from that button.

The journal canvas is flat (Journal file and the Shell file's onboarding glimpses, owner ruling 2026-11-08): the
room's ground is `journal/canvas` with nothing drawn over it, and both onboarding glimpses that picture the journal — the
Windmill page's Journal band and the Journal page — sit on the same flat ground. The Journal glimpse has no entry beat
left; its caret's blink is its one motion. Observation: *Where to start?*'s `RoomDoor` still washes each door's card
toward its corner in the room's soft accent (`lampSoft`, `accentSoft`); it is a door, not the room, so the ruling left it.

The journal room is calm and native (Journal · iOS 01.5P, 01.6P, 01.8P–01.12P, 02.3P–02.6P, owner approved
2026-11-08). `JournalRoomView` hosts the canvas in a `TabView` of one Pages tab, minimised on scroll up, with Write,
today's count and one saved-state symbol in the tab bar's bottom accessory; a single tab hosts the accessory, and the
tab bar draws Pages as one wide tab until Search arrives. SwiftUI's `.keyboard` toolbar never reaches the UIKit
editor, so the keyboard's bar is UIKit's own `UIToolbar` as the text view's input accessory, its count item without the
shared glass. The editor sizes itself through `sizeThatFits`, so the canvas measures no width in a `GeometryReader`
and the scroll view runs under both bars. The inline ink, the reader and the trail became one stock sheet whose
detents the room drives: a passage lowers it to `.height(140)`, where *Back to tonight* stands; its model keeps one
`sheetDay` and a trail from tonight through the count's day. Mood and energy are hidden on iOS, while the web still
draws them: `JournalRoom.keepDue` waits for the first kept page alone, and the phone saves words through `SaveWords`,
which takes the page's ratings as the phone holds them at the save, so a rating set on the web mid-sentence survives;
a page emptied of words is still removed whole, ratings included. The echo sheet steps aside before an account sheet
(`AppModel.roomSheetUp`), since a presenter holding one sheet silently refuses a second. Disabling the editor while
its text view holds the keyboard resigned it inside SwiftUI's update, and the resign's question to the focus graph looped
the attribute graph (a sample shows `AG::Graph::print_cycle` under `JournalBodyText.updateUIView`), hanging the app
once in a few Done taps; Done now resigns through UIKit and the switch waits for the deferred resign. Observation:
`JournalModelTransport` serves both rooms and its name predates the gym.
