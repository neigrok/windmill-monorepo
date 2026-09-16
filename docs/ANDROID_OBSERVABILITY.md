# Android observability

Android errors use the Sentry Android SDK. Behavioral events use the authenticated first-party
`POST /v1/events` intake, which stores them and forwards them to Amplitude. The Android APK contains
no Amplitude API key. `Telemetry` is injected through the application, account, HTTP transport,
workout stores, notifications and Compose provider; tests default to `Telemetry.None`.

## Configuration

Release assembly requires `SENTRY_DSN`, or `-Pwindmill.sentryDsn`, with a valid HTTPS DSN. The Android
signing-input CI job uses the existing repository `SENTRY_DSN` secret and fails when absent. The
build-and-test job uses a nonproduction placeholder so its full debug/release build requires no
production credentials. Release publication still requires local signing and native acceptance.

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
a static operation and a failure kind. Products supply operations such as `gym_ask` so dynamic
resource IDs and query strings never enter the report.

Expected HTTP statuses 400, 401, 403, 404, 409, 422 and 429 produce product/API failure metrics rather
than Sentry issues. DNS/connect failures produce `failure_kind=offline` metrics; cancellation is
propagated without an issue. Timeouts remain distinct and reportable. Coach uses a 660-second request
budget for the backend's bounded sequence of model/tool calls. An intervening proxy may impose a
shorter limit.

Handled storage, synchronization, notification, authentication and UI boundary failures also report.
Session decoding and Keystore failures use a bootstrap Sentry sink, available before account storage
is read. HTTP failures are owned by the shared transport, so workout stores do not report them twice.
SDK exception deduplication is disabled because the transport's malformed exception is a singleton;
separate failed requests must still produce separate events.

Sentry sends stack traces and exception types. Its final send hook removes exception messages,
request details, extras, breadcrumbs and user identity. Screenshots, view hierarchies, replay, NDK
capture, logs, tracing and profiling are not enabled. Coach questions, answers, workout names, email
addresses, tokens, authorization headers and response bodies are excluded. Crash reports rely on
stack/type, release and operation tags; cross-event navigation history is in behavioral metrics.

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
| Coach | `gym_ask_started`, `gym_ask_outcome` | outcome, failure_kind, status, duration_ms, cap |
| Training | `gym_session_started`, `gym_session_finished`, `gym_set_logged` | storage |
| Routines/proposals | `gym_routine_saved`, `gym_proposal_outcome` | action, storage, outcome |
| Reliability | `api_request_failed`, `client_error` | operation, method, route, status, failure_kind |

## Delivery and limits

The event queue persists before sending, sends batches of at most 50 and retries failures every
30 seconds while the process runs. It retains at most 500 events across accounts. A full queue
rejects new events and reports `telemetry_overflow` once until delivery frees capacity. Storage and
unexpected delivery failures are reported to Sentry without recursively emitting another event.
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

## Verification and structural observations

Run the shared boundary and local collector tests with:

```sh
cd apps/android
./gradlew :platform:testDebugUnitTest
```

`AndroidTelemetryTest` starts the real Sentry SDK against a local HTTP collector and uses the real
first-party HTTP transport against another local collector. It checks private message exclusion,
release/environment attribution, repeated singleton errors, persisted event IDs and numeric Coach
latency. `EventQueueTest` checks retry identity, restart recovery, account isolation and storage and
delivery failure reporting. HTTP tests distinguish server/malformed failures, expected refusals and
timeouts. The gym suite checks product outcomes and handled-error ownership.

The shared boundary keeps vendor APIs out of product code and makes missed outcomes testable with a
recording `Telemetry`. A remaining performance consideration is the small synchronous preference
commit made for every queued event. Native end-to-end acceptance and a live vendor receipt remain
separate checks from local collectors; build success alone is not evidence of either.
