# Android observability

Android errors use the Sentry Android SDK. Behavioral events use the first-party
`POST /v1/events` intake, which accepts anonymous and authenticated batches, stores them and
forwards them to Amplitude. The Android APK contains
no Amplitude API key. `Telemetry` is injected through the application, account, HTTP transport,
workout stores, the SQLite sync runtime, signed-out workout imports, notifications and Compose
provider; tests default to `Telemetry.None`.

Gym palette selection and onboarding color reuse add no behavioral events or failure boundary.
Existing screen, action and onboarding events retain their current labels and properties.

Shared native controls (`NumberStepper`, `DeleteSwipeRow`, FABs, error buttons and menus) add no
product events or persistence boundaries. Their consumers own validation, write failures and
content-free flow events. Changed/unchanged/refused edit results only control local feedback and
IME completion; raw number text and refusal content are not sent by the components.
The rack and Fix set validate native number buffers locally. Expected syntax and range refusals
produce no Issue. Editing or IME validation produces no event; an explicit invalid Save fix emits
one bounded `fix/refused` result. Accepted rack edits retain the `gym.editRack` unexpected-failure boundary;
Fix set retains `gym.fixSet`. A successful explicit Log set still emits one `gym_set_logged` and
no haptic. A failed controls write keeps the existing recovery sentence visible; automatic editor
cleanup does not report the same failed storage again. Numeric input, selected text and refusal
sentences never become telemetry properties.
Task 07's local API 37 probes each deliver one sanitized `gym.editRack` Issue and one
`client_error`; automatic editor cleanup emits no duplicate. The recovered store accepts another
step/set and finishes. Five committed sets across four sessions match five log events and four
start/finish events. Two transient hello/unreachable results recover with cause unproven. This is
local collector/intake evidence; no hosted delivery claim is made.

## Workout navigation

The rack emits `gym_action` with `screen=workout`, `action=movement_switch|open_workout` and
`outcome=ok`. A movement switch is reported once after the requested movement is selected in the
same account and workout. Gesture cancellation, programmatic pager alignment, stale account
requests and notification refreshes do not create navigation events. The movement title opens the
existing assembly sheet; no movement name, position, load, reps or identifier is a property.
Existing `gym.choose`, `gym.editRack` and `gym.acceptSet` boundaries retain their static operations.
Task 09’s local native intake records four starts, four logged sets and four finishes in each
appearance, with two completed movement switches and two management opens per appearance.
Those canonical windows contain no client errors; this verifies the local intake, not hosted delivery.

This workout emits `gym_action` with `screen=workout`: `remove` uses `ok|refused`,
`picker_open|picker_cancel|reorder` use `ok`, and `picker_add` uses `ok|refused` after the
selection resolves in the same account and workout. A consumed/cancelled reorder never calls the
save callback or emits an event. Drop refusal is expected and creates no Issue. Existing controls
storage and `gym.choose`/`gym.create` boundaries retain their static operation names. Local edited
rack snapshots add no events; raw buffers, movement identifiers and values never enter properties.
Task 11’s installed-app management window records one picker cancel, one picker add, one released
removal and one completed reorder, each `ok`, plus two picker opens, four management opens and
three completed movement switches. It contains no client errors. Stored controls confirm the
removed movement is absent and the released order is saved. This is local intake/readback evidence;
spoken TalkBack and hosted vendor delivery are not claimed.

## Set correction

Fix set emits `gym_action` with `screen=workout|session`, `action=fix` and
`outcome=ok|refused|failed`. The settled store job owns the result after a write starts, so closing or
recreating the sheet cannot cancel the correction or suppress/duplicate its event. `ok` means the
local engine or retained import source accepted the correction; it does not claim server sync.
Expected missing rows, account changes and domain refusals emit `refused` without an Issue. Invalid
numeric Save emits one `refused` from the sheet and does not call the store. Notes, effort, load,
reps, workout/movement names and identifiers never enter properties.

Unexpected correction, import or correction-read failures report under `gym.fixSet`. A publication
failure after a committed correction reports the boundary once and preserves `ok`; an unwritable
controls file retains the existing restart instruction. Late reads cannot publish into another
account or workout. Set deletion retains the separate `gym.deleteSet` and `delete` contract below.
Known failed controls are not written again by log adoption or automatic projection; unrelated
catalogue, log, note and progress reads remain active. The installed-app probe delivers one `fix/ok`
event and one content-free `gym.fixSet` Issue after a persisted correction’s controls publication
fails. It produces no repeated `gym.refreshWorkout` or misattributed `sync_push` failures. The same
window includes one `hello/unreachable` metric of unproven cause, without an Issue; later readback
and the independent recovered edit succeed. Local receipt does not establish vendor delivery.

## Finish and workout discard

Finish emits `gym_action` with `screen=finish`, `action=done|keep` and `outcome=ok`.
The shared workout confirmation emits `action=discard`, `state=shown` on opening and
`outcome=cancelled` on Cancel or dismissal. A confirmed application-owned store job emits one
`outcome=ok|refused|failed` with `screen=finish|session|log`, including when its presenting UI leaves.
A pre-acceptance failure preserves the workout. `ok` means the local deletion was accepted; a later
projection failure reports `gym.discard` without changing that accepted result. Expected refusals
create no Issue. There is no workout hold or Undo at these room doors; weight recovery is separate.

The first anonymous receipt marker reports unexpected phone storage failure at `gym.finishReceipt`.
Keep starts ordinary sign-in and queues no question. Share retains one local request identity through
its matching owner-bound sign-in result and account-data decision; cancellation or replacement
retires that intent. The final account and store seat must match the result before admission. The saved attempt also owns
its exit phase and local chat identity. Replaying that state reopens the same chat without another
fresh-entry or History event; a recorded request is not submitted again. Its admitted question retains
`gym_ask_started`, `gym_ask_outcome` and the `gym.ask` boundary. Restored receipts reconcile against
the current local replica through `gym.loadLog`; unread absence is expected and creates no Issue.
Sign-in results contain at most one active attempt and one consumable result. No local user ID, attempt, request,
workout or chat identifier, question, routine name, amount or failure sentence enters telemetry.

## Coach archive and navigation

Coach chat navigation emits bounded `gym_action` steps with `screen=coach`,
`action=fresh_entry|history_open|draft_restored|reply_open|read_sources` and `outcome=ok`.
Recreation restores the selected chat without a fresh-entry event. Ask transport retains
`gym_ask_started`, `gym_ask_outcome` and the `gym.ask` failure boundary.

The existing local Coach document owns archive failures at `gym.saveConversation` and
`gym.restoreConversation`; draft writes use `gym.saveDraft`, photo preparation uses
`gym.preparePhoto` and photo storage uses `gym.savePhoto`. A failed archive publication retains
its cached state and does not relabel a received server answer as a transport failure. Drafts that
have not reached storage remain recoverable and cannot bypass persistence on Send. Chat identities,
request identities, drafts, photo names/bytes, answer previews and receipt content are never event
or failure properties. Cancelled photo uploads retire their pending request atomically while retaining
the Retry draft. Late photo completion cannot recreate a deleted chat; cleanup retains every photo
referenced by a live draft, request or archived exchange.

History confirmation emits `gym_action` with `screen=threads`, `action=delete`, `state=shown`.
Cancel or dismissal emits `outcome=cancelled`; the application-owned confirmed delete emits one
`outcome=ok|refused|failed`. A successful server receipt precedes removal of retained local metadata;
404 reconciles as already deleted. Local-only drafts delete without a network call. Technical
failures retain `gym.deleteThread`; expected refusals emit an outcome without an Issue. Conversation
deletion has no held window or Undo.

## Coach messages

Copy question and Copy answer emit one `gym_action` with `screen=coach`, `action=copy` and
`outcome=ok|failed`. A failed clipboard write reports once under `gym.copyMessage` and keeps the
existing menu available for Retry. Question/answer text and clipboard contents never enter these
properties or diagnostics. Plain taps and opening the menu do not claim a copy. Jump to latest
emits `action=jump_latest`, `outcome=ok` when the local scroll command is accepted.

The native state-input pipeline retains draft/selection ownership while Material3 supplies its
filled-field decoration. Signed-out local History uses the existing disabled native component:
text/photo drafts stay retained, while editing, adding/removing a photo and Send stay disabled.
Anonymous network composition remains gated by the installation implementation. The signed-out
access-screen body belongs to task 36.

## Deletion actions

Routine, set and note deletion emits one `gym_action` after the settled application-owned job finishes:
`screen=routines|session|notes|note_editor`, `action=delete`, `outcome=ok|refused|failed`. Row disposal does not
cancel that job or suppress its result. `ok` means the exact local receipt was released to the queue;
server acceptance remains the sync result. Expected account changes and domain refusals are events,
not Sentry issues. Unexpected failures report once at `gym.dropRoutine`, `gym.deleteSet` or
`gym.deleteNote`. A release failure that cannot undo its exact receipt is unconfirmed, not restored.

Notes saves emit one store-owned `gym_action` result with `screen=note_editor`, `action=save` and
`outcome=ok|refused|failed`. Save/delete use their final local result; expected refusals are not
Issues. Unexpected failures retain `gym.saveNote`, `gym.deleteNote` and `gym.reorderNotes`.
List and editor deletes retain their separate bounded screen labels. A cancelled handle drag
rolls back its temporary order and emits no `gym_note_moved`.

Weight actions use `screen=bodyweight`: `delete` has `held|closed|refused|failed`, `undo` has
`ok|closed|failed`, and `cancel` has `rewritten`. `held` means a durable engine Undo offer exists;
`closed` means Undo is unavailable and does not claim a queued or acknowledged delete. A successful
same-day write emits `cancel=rewritten` only after the write succeeds. The engine release and sync
write observations cover queue and server progress. Technical hold or Undo failures use
`gym.deleteWeighIn`. Accepted holds and Undo update their exact receipt projection; whole-record
saves use the domain action's accepted values, so no follow-up read can relabel a successful write.
Background/restart/account release never emits a new user action.

The telemetry policy accepts only these finite screen/action/outcome combinations and the existing
notification/tile and Coach combinations. Names, note text, dates, weights, record/receipt IDs and raw failure
messages never enter these events. Installed verification observes one result per settled set/note
delete, one held action per weight request, two successful Undo actions and one background closure.
The background check completes before the nine-second deadline, with no held receipt or Undo after
resume and the delete present in backend readback. Routine swipe success is verified in the paired
appearance recipes.

One controlled local outbox failure leaves the routine present and produces one failed product
event. The existing reporting layers produce correlated `gym.dropRoutine` / `CommitFailure` and
`sync_storage` / `store-failure` receipts for that same failed commit; these are not two independent
failures. Both local Sentry envelopes omit exception values, message, user, request and breadcrumbs.
Shared reporting deduplication remains a follow-up. Evidence in
`/private/tmp/windmill-android-task05/final-band` verifies the first-party intake and local collector,
not hosted vendor delivery.

## Configuration

Release assembly requires `ANDROID_SENTRY_DSN`, or `-Pwindmill.sentryDsn`, with a valid HTTPS DSN for
the dedicated [Android Sentry project](https://none-gcb.sentry.io/projects/android/). The Android
signing-input CI job uses the repository `ANDROID_SENTRY_DSN` secret and fails when absent.
It does not consume the backend's `SENTRY_DSN`. The
build-and-test job uses a nonproduction placeholder so its full debug/release build requires no
production credentials. Release publication still requires local signing and native acceptance.
The DSN is embedded at build time; installed builds keep their original destination until updated.

Sentry initializes before session or workout storage reads. Errors carry `platform=android`,
release `android-<version>-<source revision>`, distribution/version code and environment. CI supplies
the source revision through `GITHUB_SHA`; local builds can use `-Pwindmill.sourceRevision`.
Debug telemetry is disabled unless `-Pwindmill.debugTelemetry=true` is supplied. A local verification
build should also set a local API base and a collector DSN. The default release API base remains
`https://windmill.works`.

The backend requires `AMPLITUDE_API_KEY` and the appropriate regional `AMPLITUDE_HOST` for Amplitude
forwarding, and its own `SENTRY_DSN` for server errors. A successful first-party intake means the
batch is stored; it does not prove Amplitude has accepted the asynchronous forward.

## Error coverage and privacy

The SDK captures uncaught JVM crashes and Android ANRs. Shared HTTP reporting captures unexpected
responses, malformed successful bodies, response timeouts, interrupted transport and failures while
encoding a request or resolving credentials. Each HTTP failure has a method, a coarse route family,
a static operation, a failure kind, `duration_ms` and `network_phase`. Duration uses a monotonic clock
from the start of each invocation through response consumption and decoding. The phase is one of
`prepare`, `queued`, `dns`, `connect`, `tls`, `request_headers`, `request_body`, `response_headers`,
`response_body` or `decode`; it identifies the last observed boundary rather than proving a root
cause. Concurrent calls keep separate diagnostics, and an injected client's event listener still
receives its callbacks. Products supply operations such as `gym_ask` so dynamic resource IDs and
query strings never enter the report. Phase labels contain no URL, host, IP address or body data.

Expected HTTP statuses 400, 401, 403, 404, 409, 410, 422, 426 and 429 produce product/API failure
metrics rather than Sentry issues. The REST transport emits `failure_kind=offline` metrics for
DNS/connect failures; cancellation is propagated without an issue. Timeouts remain distinct and
reportable. Coach uses a 660-second request
budget for the backend's bounded sequence of model/tool calls. An intervening proxy may impose a
shorter limit.

Handled storage, synchronization, notification, authentication and UI boundary failures also report.
Accepted-set recovery failures report at the calling training or account boundary, including
`gym.finish`, `gym.start`, `gym.restoreWorkout`, `gym.connect`, `gym.loadLog` and
`gym.reconcileWorkoutTime`. Failed Finish keeps the durable sets, returns a visible failure and
emits no `gym_session_finished`; a successful retry emits it once. Waiting for an adopted workout's
start and sets is an expected unanswered Finish, without a Sentry issue. Recovery of a stranded
adopted set uses the existing import reconciliation and Retry boundaries below. Finish stays disabled
while account restoration or a same-account background connection is pending. A tap on that disabled
action makes no write and emits neither a finish event nor a technical failure; the completed action
emits one `gym_session_finished` after readiness returns.
The first-launch onboarding gate reports unreadable workout presence, unreadable first-launch state
and failed launch-marker writes under the static operation `onboarding_storage`; failed inspection or
flag persistence skips automatic onboarding rather than treating an unknown phone as empty.
Sign-in shows server refusal words only in the form. Expected code refusals emit the shared API
failure metric without a Sentry issue; unexpected local completion failures report under
`auth_sign_in`. Neither boundary sends the email, code, link or server refusal text.
Session decoding and Keystore failures use a bootstrap Sentry sink, available before account storage
is read. HTTP failures are owned by the shared transport, so workout stores do not report them twice.
SDK exception deduplication is disabled because the transport's malformed exception is a singleton;
separate failed requests must still produce separate events. Sentry groups each handled failure by
its default grouping plus its static operation, so one exception type reported under two operations
forms two issues.

Sentry sends stack traces and exception types. Its final send hook removes exception messages,
request details, extras, breadcrumbs and user identity. Screenshots, view hierarchies, replay, NDK
capture, logs, tracing and profiling are not enabled. Coach questions, answers, workout names, email
addresses, tokens, authorization headers and response bodies are excluded. Crash reports rely on
stack/type, release and operation tags; cross-event navigation history is in behavioral metrics.

The application adapts `EngineTelemetry` to the existing `Telemetry` interface. The engine's bounded
queue carries static operation/outcome enums, allowlisted codes and an HTTP answer's status.
Unexpected storage, read, writer, transport and lifecycle failures report under `sync_<operation>`
as a `SyncEngineFailure`, one Sentry issue per operation; expected HTTP refusals (400, 401, 403,
404, 409, 410, 422, 426 and 429, and 413 on a push), including update-required responses, emit
metrics with their `status` and no Sentry issue. The engine owns hello, push, pull, live, retries,
deadlines and cancellation. A request or live socket that loses the network emits `sync_engine` with
`failure_kind=unreachable` and no Sentry issue: no DNS answer, a refused, reset or cut connection or
handshake, an HTTP/2 connection that shut down or a stream it cancelled or refused, a timeout before
a whole reply, a socket dropped without an HTTP response, an open live socket reset or ended without
a close frame, or a heartbeat with no pong. A close frame with a normal closure (1000) or going away
(1001) emits nothing, and the server's session-ended close (1008) is a `refused` metric with no
Sentry issue. Every other transport failure is a fault, and its `failure_kind` says why: `http` with
the `status` of an unexpected answer, `tls` for a refused certificate or TLS exchange, `protocol`
for a broken status line or HTTP/2 stream reset, `malformed` for a reply or frame the engine cannot
read, including a push's recovery `409` with a malformed envelope, `limit` for an oversized reply or
frame or a full live queue, and `transport` for a live socket the server closes with any other code,
or none, and for any other I/O failure. Both labels reach the `sync_engine` event and, for a fault,
the issue's tags and its `client_error` event; a supplied `failure_kind` is kept, not replaced by
the exception's class. A fault that repeats the fault its operation last filed, the same kind with
the same status or exception, is a metric alone until that operation is answered by a valid HTTP 200
or live frame. Lost network or a refusal ends the run, so the next fault files. A steady fault
therefore files once per outage of its operation.
Each live socket reports only its first end. Intentional request/socket close and coroutine
cancellation do not report. Unchanged engine transactions enqueue no success telemetry.
Before a push batch is numbered, a fresh hello must advertise a server schema at least the client's
registry minimum. A valid response from an older server is ordinary rollout waiting: ready intents
retain their identity and content, no durable refusal or update dialog is created, and no Sentry
issue is reported. The handshake uses the existing `hello` transport observations; real network,
protocol and unexpected HTTP failures retain their existing bounded reports. The retry floor
survives commit, foreground, leave and cancellation wakeups. No new product step or event is added;
the local action's existing event remains the receipt for the user's save.

Runtime-owned workers contain unexpected exceptions at their coroutine boundary and report only
the static operation/outcome. Engine closure cancels the runtime without reporting a failure;
coroutine cancellation is rethrown. Synchronous work already running during closure cannot leak
the engine's closed-store exception into the process's uncaught exception handler.
The application
forwards engine refusals and failures; successful user steps already have their product events,
so background housekeeping never becomes `sync_engine` traffic. A healthy live socket suppresses
periodic fallback pulls; first reads, live hints, doubt resolution and socket recovery still pull.
No replica/account identifier,
record key, source document, workout content or credential enters these reports.

Signed-out workout imports keep their per-replica journal on the phone; its contents and local
refusal reasons are not telemetry. An unexpected reconciliation failure reports under
`gym.import_reconcile`. Settings exposes inspection, correction, Keep and retry; their unexpected
failures report under `gym_import_fix`, `gym_import_keep` and `gym_import_retry`. Account decisions
include pending retained work, pin revisions and preserve unsent account work with Keep. A training
write the log's rules refuse is said on screen and never becomes a Sentry issue.
Settings Retry enters import reconciliation before its
`gym_import_recovery` completed event. Completion means the local retry was scheduled, not that
the server accepted it. A scheduling failure retains the source, reports at the Settings boundary
and emits no completed event; cancellation propagates without a failure report.

Quick Settings taps emit one `gym_action` when their route is handled, or one failed action if the
activity cannot launch. A stale account or workout refuses navigation without a technical Issue.
Unexpected tile rendering, restoration or launch failures report under `gym.tile`. Tile refreshes
and the visible subtitle clock emit no events; event properties contain no workout names, movement
names, account or workout IDs, or elapsed times.

The API 37 tile acceptance packet verifies first-party intake for four successful Routines routes,
six successful workout routes and one intentionally unavailable target. The unavailable target also
produces one `client_error` and one local Sentry envelope under `gym.tile`, with no exception value,
user, request, message or breadcrumbs. Service restoration emits no tile action. The packet is
`/private/tmp/windmill-android-task16/final3`; it verifies local intake, not hosted analytics receipt.

Notification actions emit one `gym_action` per delivered user action through their shared handler.
A locked, stale or unavailable offer is `refused`; refreshing the notification or its chronometer
emits nothing. Accepted notification sets also emit one `gym_set_logged`. Unexpected post, receive
and capability failures retain `gym.notification.post`, `gym.notification.receive` and
`gym.notification.capabilities`. Routine names, movement names, values and clock timestamps are
excluded from both event properties and failure reports.

Every logged set uses the rack acceptance path and emits `gym_set_logged` once. Finish emits
`gym_session_finished`; both events carry no set values or legacy kind labels. Saved workout
imports ignore legacy kind fields and retain their existing load, write and recovery failure boundaries.
Logging above a routine target and moving between movements perform no routine write and emit no
routine-save event. Explicit editor saves report failures under `gym.saveRoutine` and emit
`gym_routine_saved`; accepted Coach proposals retain their own decision boundaries.
App workout starts require an existing routine and emit `gym_session_started` once on success.
Missing routines and duplicate starts are expected refusals, including races during the start
decision; receiving or reopening an external workout emits no start event. The receipt writes no routine and has no routine-save event or
failure boundary. Workout screen-view events retain their existing `workout` label.

Local installed-app acceptance verifies the training event contract: nine logged sets produce nine
`gym_set_logged` events, two finishes produce two `gym_session_finished` events, and the routine
start produces one `gym_session_started` event. Receiving and reopening an external no-routine
workout adds no start event; above-plan logging adds no routine-save event. These intake records
contain common application metadata only. A malformed private workout document reaches the local
Sentry collector under `gym.storage.read`, without exception messages, document content or credentials;
restoring the exact backup returns the app to its normal state. The
[Android implementation record](engineering/android-implementation.md) identifies the APK and evidence.
This checks local SDK delivery and first-party intake, not hosted vendor receipt.

The update dialog responds when the engine stops for an upgrade, on the server's
`426 upgrade-required` or a hello whose `minSchema` is above the app's registry, without deleting
local work. A bare 426, such as a proxy's, is a failure like any other and shows no dialog.
`-Pwindmill.updateUrl=<public Android update URL>` configures its destination. With no
configured URL, **Open Windmill** opens `https://windmill.works`. The release workflow supplies
`https://github.com/neigrok/windmill-monorepo/releases/latest`, labeled **Get the update**.
Installed-app verification must use that public destination.

## Product events

Every event carries platform, app version, build, release and environment. Event properties pass a
bounded allowlist; `duration_ms` is a JSON number so latency can be aggregated in Amplitude. Other
properties are bounded labels. The event schema is `{id, name, clientMs, props}` inside a batch
`{sessionKey, platform: "android", events}`. Persisted UUID event IDs remain stable across retries.

| Area | Events | Useful properties |
| --- | --- | --- |
| Application | `app_started`, `app_foregrounded`, `app_backgrounded` | version, build, release |
| Authentication | `auth_restore`, `auth_code_requested`, `auth_code_sent`, `auth_sign_in_started`, `auth_signed_in`, `auth_signed_out` | outcome, method |
| Navigation | `gym_screen_viewed` | screen |
| Motion settings | technical failure `onboarding_motion_settings` | static operation; motion falls back to reduced |
| Brand onboarding | `onboarding_opened`, `onboarding_page_viewed`, `onboarding_action`, `onboarding_exited` | state, screen, action, outcome |
| Coach | `gym_ask_started`, `gym_ask_outcome` | outcome, failure_kind, status, duration_ms, cap |
| Coach archive navigation | `gym_action` | screen: `coach`; action: `fresh_entry`, `history_open`, `draft_restored`, `reply_open`, `read_sources`; outcome: `ok` |
| Coach messages | `gym_action` | screen: `coach`; action: `copy`; outcome: `ok`, `failed`; or action: `jump_latest`, outcome: `ok` |
| Coach History deletion | `gym_action` | screen: `threads`; action: `delete`; state: `shown`, or outcome: `ok`, `refused`, `failed`, `cancelled` |
| Coach routine confirmation | `gym_coach_routine_confirm` | outcome: `started`, then `saved`, `refused` (the server answered 4xx) or `failed` (5xx, no reply or an unreadable one); no IDs, names or contents |
| Training | `gym_session_started`, `gym_session_finished`, `gym_set_logged` | common metadata only |
| Finish actions | `gym_action` | screen: `finish`; action: `done`, `keep`; outcome: `ok` |
| Workout discard | `gym_action` | screen: `finish`, `session`, `log`; action: `discard`; state: `shown`, or outcome: `ok`, `cancelled`, `refused`, `failed` |
| Workout navigation | `gym_action` | screen: `workout`; action: `movement_switch`, `open_workout`; outcome: `ok` |
| Notification actions | `gym_action` | screen: `notification`; action: `log_set`, `open`; outcome: `ok`, `refused` |
| Quick Settings tile | `gym_action` | screen: `tile`; action: `routines`, `open`; outcome: `ok`, `failed` |
| Bodyweight/notes | `gym_bodyweight_saved`, `gym_note_moved` | common metadata only; successful local commits, no event for an unchanged drop |
| Notes editor | `gym_action` | screen: `note_editor`; action: `save`, `delete`; outcome: `ok`, `refused`, `failed` |
| Notes list | `gym_action` | screen: `notes`; action: `delete`; outcome: `ok`, `refused`, `failed` |
| Routines/proposals | `gym_routine_saved`, `gym_proposal_outcome`, `gym_proposal_receipt_shown` | action, outcome |
| Engine refusals/failures | `sync_engine` | operation, outcome, failure_kind, status |
| Workout imports | `gym_import_recovery` | action, state, outcome |
| Account decisions | `gym_sign_in_decision`, `gym_sign_out` | state, action, outcome |
| Connectivity | `sync_connectivity` | state |
| Update | `client_update_required` | state, action, status, outcome |
| Reliability | `api_request_failed`, `client_error` | operation, outcome, method, route, status, failure_kind, duration_ms, network_phase |

Equipment-aware load labels are read-only and add no event. Routine summary and editor retain
`gym_screen_viewed` with `screen=routine` and `screen=routine_editor`. Loads, movement names and
equipment labels stay out of navigation properties; rename/storage failures retain their existing boundaries.

Root chrome uses the existing `routines`, `log` and `coach` screen labels; the visible title *The log*
does not change event properties. Account routes retain their existing navigation and shell events.
The shared app bar adds no transport, storage or write boundary, and sends no title or account initial.

The Routines FAB retains the existing `routine_editor` screen event and draft-save boundary. It adds
no component event or failure reporter. Removing the standing sign-in suggestion adds no event.
Proposal cards/chips retain their current `proposal` review destination and existing outcome events;
their appearance and destination redesign are deferred. Installed 03/17 acceptance records nine
`routine_editor` views (eight capture activations and one saved draft), one `proposal` view, and one
`gym_routine_saved(action=create)`. The pending proposal and existing routine revisions are unchanged.
Intake properties contain only the existing bounded metadata. The account seat opens and returns
correctly; the shell currently emits no separate You-open event, which task 46 owns.

`gym_proposal_outcome` carries `action` apply or dismiss and `outcome` decided, moved, gone, settled
or failed; iOS records the same turn-down as `reject`.

`gym_proposal_receipt_shown` carries `outcome=applied` after a visible removal receipt's durable
acknowledgment succeeds. A failed acknowledgment reports under `gym.proposal_receipt_shown` and
retains the receipt for retry. Receipt snapshots, proposal IDs and routine names stay on the phone.

Onboarding records first launch and replay from **About Windmill**. It emits an open, each settled
page, navigation actions and an exit. `state` is `first_launch` or `replay`; `screen` is `windmill`,
`roadmap`, `journal` or `gym`; `action` is `next`, `back`, `swipe` or `adjust`; exit `outcome` is
`skipped`, `completed`, `back` or `closed`. Open events accept only state, page events state/screen,
actions state/screen/action and exits state/screen/outcome, alongside the common build metadata.
Other `onboarding_*` event names are rejected. Other property keys and values outside these finite
sets are dropped, even when syntactically valid labels. No picture, page copy or workout content
enters these events.

Exits are terminal: completing or dismissing the pager, an external route replacing it, or the
activity finishing. Home and screen lock emit application lifecycle events without closing the
onboarding flow. Configuration changes retain an eligible introduction; restored state after
process death consults the persisted launch marker and does not reopen a consumed introduction.

## Delivery and limits

The event queue persists before sending, sends batches of at most 50 and retries failures every
30 seconds while the process runs. It retains at most 500 events across accounts. A full queue
rejects new events and reports `telemetry_overflow` once until delivery frees capacity. Storage and
unexpected delivery failures are reported to Sentry without recursively emitting another event.
A delivery that loses the network retries without a report, by the sync engine's `unreachable` rule;
a refused certificate or TLS exchange, a broken status line or stream reset, an unreadable
acknowledgement or an unexpected status reports.
Analytics batches share one OkHttp client and connection pool. Each batch captures its own bearer
before delivery; reusing a connection does not reuse another account's credentials. A reportable
delivery failure carries `operation=telemetry_delivery`, `method=POST`, `route=/v1/events`, elapsed
duration and network phase. It reports once per uninterrupted failure streak and resets after a
successful batch.
A partial acceptance count reports `telemetry_rejected` and removes the entire submitted batch;
the client cannot identify individual rejected entries, so those entries are lost. An unreadable
acknowledgement fails decoding and retries the batch with its original event IDs.

Account shelves remain isolated across sign-in and sign-out. Queued anonymous events always send
without credentials, including after sign-in. Events belonging to another account wait until that
account returns. Tokens never persist in the telemetry queue. A request already in flight retains
its original credential and only acknowledges its original shelf. The backend resolves account
identity from that credential, independently of any client-supplied identity.

Delivery is bounded best effort, not guaranteed exactly once. Uninstall, cleared app data, corrupted
storage, a full queue or an account that never returns can prevent delivery. Stable event IDs let
Amplitude deduplicate retries; the first-party ledger can retain a retried entry more than once.
If both telemetry destinations are unreachable, local persistence cannot itself prove delivery.

## Local checks

```sh
cd apps/android
python3 -m unittest discover -s tools/tests -v
./gradlew :platform:testDebugUnitTest :sync-engine:testDebugUnitTest :app:testDebugUnitTest
```

`AndroidTelemetryTest` exercises the real Sentry SDK and first-party HTTP transport against local
collectors, including per-operation grouping and a supplied failure kind and status. `EventQueueTest`
covers retry identity, restart recovery, account isolation, silent retries on lost network, reports
for transport faults over real sockets, one delivery report per failure streak and exact onboarding
names/finite properties. The engine's `failure-kinds.tsv` (sync-engine test resources) is run by both
`TransportTests` and `EventQueueTest`, so the engine and analytics delivery classify lost network
alike.
HTTP tests cover concurrent diagnostics,
listener composition, timeouts and response decoding. Release-tool tests cover signing custody,
provenance and telemetry configuration.

`EngineIdleTests` drives an online and an offline hour using the shipping engine, runtime,
HTTP transport, telemetry adapter and durable event queue with a stepped clock and real local
HTTP/WebSocket collectors. It checks zero idle HTTP requests and queued events, then verifies
recovery after a closed live connection. `TransportTests` and `SyncRuntimeTests` drop requests and
live sockets on real local sockets and check one `unreachable` event per drop, each fault's kind and
status, and one issue per outage, including a refused certificate, a broken status line and a stream
reset after lost network, a bad live frame across reconnects, and a live socket the server resets,
ends or closes with each kind of close code; `EngineTelemetryTests` carries the same drops through
the application adapter.
`EngineNotesScreenTests` checks unread versus empty notebooks, first-pull refresh and
server-refused saves through the gym engine.

Native crash delivery and vendor receipt require a separate installed-app check. Local collectors
and a successful build do not establish either.

Coach routine confirmation runs in the training store's scope, so leaving Coach mid-save still records `saved`, `refused` or `failed`. It uses the static HTTP operation `gym_coach_routine_confirm`; 5xx statuses, timeouts, interrupted connections and malformed replies report within that transport boundary, while offline and expected 4xx statuses are metrics only. Response validation failures, and a saved routine this phone fails to keep, report `gym.coachRoutineConfirm`; a routine the server saved still counts as saved. A 404 or 422 takes Save away; other refusals and failures leave the same operation available to retry. Account changes prevent late replies from appearing in another account.


### Standalone movement edit

Record opens the approved editor through More → Edit movement without changing its navigation route.
The Record route retains `gym_screen_viewed` with `screen=movement`; progress read failures retain
`gym.loadProgress`. Chart inspection and aggregation emit no values or workout identifiers. Save emits `gym_action`
with `screen=record`, `action=edit` and `outcome=ok|refused|failed`. An unchanged form cannot submit;
dismissal writes nothing. Expected name, stale-state and account-change refusals remain visible in
the sheet and do not create Sentry Issues. Unexpected storage failures report under the static
`gym.editExercise` boundary. Events and failures contain no names, aliases, equipment selections,
load counts, account identifiers or raw exception text.

The local native recipe delivers four `record/edit/ok` events through `POST /v1/events`, with only
the three bounded labels and common application metadata. Backend sync/event write receipts arrive
without fixture names. Store boundary tests verify the refused/failed outcomes and a single static
`gym.editExercise` report for an unexpected commit failure; the live capture does not inject one.

### Record progress reads

The Record native recipe reaches first-party intake with four `gym_screen_viewed` events carrying
`screen=movement` plus common app metadata. Ordinary navigation and Log moment focus emit no
workout identity, estimate or load. Opening the menu/editor and cancelling writes no edit; the
accepted local fixture retains all 18 sets and six finished workouts. Existing progress failures
stay at `gym.loadProgress`; the native capture does not inject a storage failure.
