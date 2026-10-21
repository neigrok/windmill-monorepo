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

Signed-in Coach setup uses the existing conversation, attachment transport and Gym sync door.
Native verification covers selecting a photo, restoring its unsent draft after relaunch, uploading
its bytes, receiving two durable routine receipts, reopening the remote photo and starting a
created routine. The native run uses the real client and local C++ backend with a fixture provider;
the separate opt-in backend workflow exercises the actual provider with isolated free and One
accounts. Setup exposes only its eight supported tools, reducing request context while preserving
owned training history, movement IDs and durable writes. Reservations use each request's estimated
input and its enforced output ceiling. Coach offers up to 2,000 output tokens; its budget transaction
can select a smaller ceiling, at least 1,024, that fits every applicable balance. The provider receives
that exact reserved ceiling. The cost offer is durable so retries preserve the original reservation.

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

Production runs `bfede62ac3009a32cf6a9c0b3b4f2f2c92769bd3` with USD enforcement enabled.
[Activation deployment](https://github.com/neigrok/windmill-monorepo/actions/runs/39306863773)
verifies the intended image, process settings and schema 6 readiness; independent public health
returns HTTP 200. Configured limits are $0.25 per month for verified free accounts and $7 per funded
One period, with free spending capped at $5 per day and $100 per month. Alerts target the configured
owner address. Anonymous composition is disabled in that deployed build, and Journal voice
remains unavailable pending supported audio accounting.

UI checks query the exact current accessibility value after returning from a Live Activity. A
retained element can carry an older snapshot even when the same attachment's fresh query shows
the completed write; the ledger assertions still verify every saved set and its identity.
Log navigation permits one recorded re-tap inside its existing deadline only while the original
Routines tab remains selected and no alert or sheet is present. The target and content assertions
remain exact; this recovers a lost synthesized tap without claiming first-tap delivery is reliable.

Release **0.2.0 (19)**, source `bfede62ac3009a32cf6a9c0b3b4f2f2c92769bd3`, is uploaded to
App Store Connect by [iOS release run 19](https://github.com/neigrok/windmill-monorepo/actions/runs/39307121727).
The 2026-10-19 run passed archive, stored-certificate verification and export; Apple confirmed
*Upload succeeded* at 19:06:59 UTC. The archive-derived status artifact confirms version `0.2.0`,
build `19`, bundle `works.windmill.app`, processing `VALID`, internal state `IN_BETA_TESTING` and
external state `READY_FOR_BETA_SUBMISSION`. External beta review has not been submitted by this
release. The read-only check does not inspect individual tester membership or device installation.

The retained `ios-dsyms-19` artifact contains the app and workout widget dSYMs. Export reported the
nonblocking warning *Upload Symbols Failed. The archive did not include a dSYM for the
Sentry.framework*. Production Sentry symbolication is not verified.

Anonymous Coach uses one installation boundary, one durable request record and one domain import
Action. The import validates every routine before one engine Plan commits routines and replay metadata.
Installation issuance is coalesced across account transitions; its Keychain record is separate from
account credentials. Local draft adoption writes the target archive and source marker atomically before
removing the source, so retry preserves pending responses, photos, goal choices and unsent drafts.
Stop waiting preserves the original request and cannot promise cancellation of provider spending.
Static refusal copy is shared by current errors and retained records. Model-server UI fixtures exercise
the same transport decoding and domain import as the opt-in HTTP verification.

Anonymous onboarding verification passes the three atomic-import domain cases, 89 native Coach
cases, nine real-tree architecture checks and 42 app-tool checks. The final Coach run includes the
replay case where newer goal choices remain in the composer. Light, dark and Accessibility XXXL UI
flows verify creation receipts, Keep, opening a routine and starting an anonymous workout. Real HTTP
verification against the isolated C++ backend and fixture provider covers goal and normalized-photo
generation, atomic import, workout start, installation binding, account adoption and local archive
retention. The native UI's bounded setup events reach the first-party intake and local observer.
These native checks use a deterministic provider; they do not establish actual-provider quality.

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
Local verification covers all 11 corrected UI cases and the three anonymous appearance variants,
89 Coach unit tests and 42 app-tool tests. Fixture boundaries and the final navigation assertion pass
independent review.
