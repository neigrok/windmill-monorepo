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
input and its enforced 2,000-token output ceiling.

UI checks query the exact current accessibility value after returning from a Live Activity. A
retained element can carry an older snapshot even when the same attachment's fresh query shows
the completed write; the ledger assertions still verify every saved set and its identity.
Log navigation permits one recorded re-tap inside its existing deadline only while the original
Routines tab remains selected and no alert or sheet is present. The target and content assertions
remain exact; this recovers a lost synthesized tap without claiming first-tap delivery is reliable.

Release **0.2.0 (18)**, source `a4bdb146c74189ffeca4516012bc3243aec5e2db`, is uploaded to
App Store Connect by [iOS release run 18](https://github.com/neigrok/windmill-monorepo/actions/runs/39152817121).
The 2026-10-18 run passed archive, stored-certificate verification and export; Apple confirmed
*Uploaded package is processing* and *Upload succeeded* at 18:17 UTC. The retained `ios-dsyms-18`
artifact contains the app and workout widget dSYMs. Export reported the nonblocking warning
*Upload Symbols Failed. The archive did not include a dSYM for the Sentry.framework*.
Production Sentry symbolication is not verified. Apple's completed processing and tester
availability are not exposed by this workflow and have not been directly verified.
