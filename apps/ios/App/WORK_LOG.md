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
opening the workout. Workout pages use the native pager and page control, and accessible spoken
counts accompany visual set markers. The compact ledger preserves access to earlier sets.

Coach history invalidates reads at both the start and completion of deletion, so a concurrent
response cannot restore a deleted conversation. Receipt sharing retains its intent through sign-in
and clears that intent when sign-in is cancelled. Event labels contain no writing, ratings,
workout names, questions or credentials.

The [Figma refinement boards](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=1063-477)
cover the routine sheet, workout, receipt and Log deletion in light and dark appearances.

Destructive actions use the system roles and presentation described in Apple's
[action sheet guidance](https://developer.apple.com/design/human-interface-guidelines/action-sheets).
The app keeps Done primary and sharing secondary on the receipt, with Discard separated in red.

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

Release **0.2.0 (20)**, source `617b373a8af3181acc7fc4b9e1b5a64670263f2c`, is uploaded to
App Store Connect by [iOS release run 20](https://github.com/neigrok/windmill-monorepo/actions/runs/39572022225).
The 2026-10-21 run passed archive, stored-certificate verification and export; Apple confirmed
*Upload succeeded* at 09:01:38 UTC. The archive-derived status artifact confirms version `0.2.0`,
build `20`, bundle `works.windmill.app`, processing `VALID`, internal state `IN_BETA_TESTING` and
external state `READY_FOR_BETA_SUBMISSION`. External beta review has not been submitted by this
release. The read-only check does not inspect individual tester membership or device installation.

The retained `ios-dsyms-20` artifact contains the app and workout widget dSYMs for version `0.2.0`,
build `20`. Export reported the
nonblocking warning *Upload Symbols Failed. The archive did not include a dSYM for the
Sentry.framework*. Production Sentry symbolication is not verified.

Anonymous Coach uses one installation boundary, one durable request record and one domain import
Action. The import validates every routine before one engine Plan commits routines and replay metadata.
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
balance display, and the Windmill One destination reflects the closed checkout.

Exercise identity and equipment share one editor. Read paths resolve current names from the stable
catalogue identity. External-load volume uses each set’s equipment basis and one/two-dumbbell count,
while displayed load and strength estimates retain the entered per-dumbbell amount. Workout rack
feedback updates immediately; persistence coalesces rapid taps into one save, which also runs before
sign-out, a seat change and backgrounding, so the last accepted value is kept. A tap made while an
account change is under way is refused with *The rack could not be changed. Try again.* Routine rows expose reorder handles directly; root creation controls use one bottom-trailing
plus. The Live Activity’s primary clock anchors to the most recent valid set, or session start before
the first set.

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

The Coach composer uses a direct safe-area inset with a bar-material surface. Its native field and
the parent focus state share the same host, so Done and tab-bar visibility follow keyboard focus;
the greeting retains its scrollable layout at accessible text sizes. The signed-in UI helper requires
Done to dismiss the keyboard without losing the draft, then refocuses and sends. Anonymous checks
require the same keyboard, Done and tab-bar behavior. CI and local verification both use Xcode 26.3
with iOS 26.5; CI uses iPhone 17 and the dedicated local simulator is iPhone 17 Pro. All five focused
UI flows pass: signed-in Coach in light and dark, anonymous Coach at the largest text size, and Log
in light and dark. The Log correction retains an exact assertion for the barbell label,
`Weight, 90 kg total`. The native flows use local model-server fixtures; they verify keyboard focus, draft
retention, navigation, review clearance and weight editing without making a claim about live model
quality. The build-for-testing is clean, and the focused result contains five tests with zero failures.

A Coach handoff carries the account it was asked under. An account change drops only a handoff
asked under another account, so the sign-in that a receipt's Share with Coach waited for keeps its
question, and Coach refuses a handoff from another account. The greeting steps aside while a message
is on its way and returns after a failed or refused one. Confirming a draft reports
`gym_coach_routine_confirm` and words each answer by what the draft can still do; access recovery is
drawn once, only where signing in or Windmill One can help. Movement edits write only the fields
that changed, and the load basis reads *kg each* for two dumbbells and *kg* for one.
