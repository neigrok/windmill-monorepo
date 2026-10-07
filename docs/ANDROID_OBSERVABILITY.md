# Android observability

Android errors use the Sentry Android SDK. Behavioral events use the first-party
`POST /v1/events` intake, which accepts anonymous and authenticated batches, stores them and
forwards them to Amplitude. The Android APK contains
no Amplitude API key. `Telemetry` is injected through the application, account, HTTP transport,
workout stores, the SQLite sync runtime, signed-out workout imports, notifications and Compose
provider; tests default to `Telemetry.None`.

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
adopted set uses the existing import reconciliation and Retry boundaries below.
The first-launch onboarding gate reports unreadable workout presence, unreadable first-launch state
and failed launch-marker writes under the static operation `onboarding_storage`; failed inspection or
flag persistence skips automatic onboarding rather than treating an unknown phone as empty.
Session decoding and Keystore failures use a bootstrap Sentry sink, available before account storage
is read. HTTP failures are owned by the shared transport, so workout stores do not report them twice.
SDK exception deduplication is disabled because the transport's malformed exception is a singleton;
separate failed requests must still produce separate events.

Sentry sends stack traces and exception types. Its final send hook removes exception messages,
request details, extras, breadcrumbs and user identity. Screenshots, view hierarchies, replay, NDK
capture, logs, tracing and profiling are not enabled. Coach questions, answers, workout names, email
addresses, tokens, authorization headers and response bodies are excluded. Crash reports rely on
stack/type, release and operation tags; cross-event navigation history is in behavioral metrics.

The application adapts `EngineTelemetry` to the existing `Telemetry` interface. The engine's
bounded queue carries static operation/outcome enums and allowlisted refusal codes. Unexpected
storage, read, writer, transport and lifecycle failures report under `sync_<operation>`; expected
HTTP refusals, including update-required responses, emit metrics without Sentry issues. The engine
owns hello, push, pull, live, retries, deadlines and cancellation. Engine network failures use
bounded operation/outcome labels; intentional request/socket close and coroutine cancellation do
not report issues. Unchanged engine transactions enqueue no success telemetry.
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
Settings Retry and a corrected set kind enter import reconciliation before their
`gym_import_recovery` completed event. Completion means the local retry was scheduled, not that
the server accepted it. A scheduling failure retains the source, reports at the Settings boundary
and emits no completed event; cancellation propagates without a failure report.

The update dialog responds to an engine 426 without deleting local work.
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
| Training | `gym_session_started`, `gym_session_finished`, `gym_set_logged` | common metadata only |
| Bodyweight/notes | `gym_bodyweight_saved`, `gym_note_moved` | common metadata only; successful local commits, no event for an unchanged drop |
| Routines/proposals | `gym_routine_saved`, `gym_proposal_outcome` | action, outcome |
| Engine refusals/failures | `sync_engine` | operation, outcome, failure_kind |
| Workout imports | `gym_import_recovery` | action, state, outcome |
| Account decisions | `gym_sign_in_decision`, `gym_sign_out` | state, action, outcome |
| Connectivity | `sync_connectivity` | state |
| Update | `client_update_required` | state, action, status, outcome |
| Reliability | `api_request_failed`, `client_error` | operation, method, route, status, failure_kind, duration_ms, network_phase |

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
./gradlew :platform:testDebugUnitTest
```

`AndroidTelemetryTest` exercises the real Sentry SDK and first-party HTTP transport against local
collectors. `EventQueueTest` covers retry identity, restart recovery, account isolation, offline
suppression, one delivery report per failure streak and exact onboarding names/finite properties.
HTTP tests cover concurrent diagnostics,
listener composition, timeouts and response decoding. Release-tool tests cover signing custody,
provenance and telemetry configuration.

`EngineIdleTests` drives an online and an offline hour using the shipping engine, runtime,
HTTP transport, telemetry adapter and durable event queue with a stepped clock and real local
HTTP/WebSocket collectors. It checks zero idle HTTP requests and queued events, then verifies
recovery after a closed live connection. `EngineNotesScreenTests` checks unread versus empty
notebooks, first-pull refresh and server-refused saves through the gym engine.

Native crash delivery and vendor receipt require a separate installed-app check. Local collectors
and a successful build do not establish either.
