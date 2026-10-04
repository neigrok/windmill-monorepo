# iOS observability

The journal app uses Sentry Cocoa 9.29.0 through SPM for technical failures. Product events go to
the first-party `POST /v1/events` intake, which stores them in Postgres and forwards them to Amplitude.
The app contains no Amplitude API key. `SyncEngine.Telemetry` is injected into the app, journal model,
authentication, HTTP transport, engine, Keychain and protected storage. Tests default to `NoopTelemetry`.

## Configuration

Release builds require a valid HTTPS `IOS_SENTRY_DSN` for the dedicated iOS Sentry project. The
repository secret is embedded at build time; installed builds keep their original destination.
The backend's `SENTRY_DSN` is independent. CI uses `https://nonproduction@example.invalid/1`.
Debug telemetry is disabled unless `WM_DEBUG_TELEMETRY=YES` is set. Simulator-only launch arguments
`-telemetry -sentry-dsn http://ios@127.0.0.1:8091/42` enable local verification with environment `test`.
These switches and the authentication fixtures are absent from Release builds.

Every event carries `platform=ios`, `version`, `build`, release `ios-<version>-<source revision>` and
`environment`. Sentry uses the same release, environment and build as its distribution. Revision
comes from `WM_SOURCE_REVISION`, `GITHUB_SHA`, or the local Git HEAD. Release defaults to `production`,
Debug to `development`. The default API base is `https://windmill.works`; local verification overrides
`WM_SERVER_BASE_URL` or uses `-server http://127.0.0.1:8089`.

`Tools/prepare_build.py` validates and embeds configuration before compilation. CI and the manual
release workflow use `Tools/generate_project.py` to configure the app target before XcodeGen;
compiler settings and SPM signing identities are not overridden on the command line.

The backend needs its own `AMPLITUDE_API_KEY` and regional `AMPLITUDE_HOST` for forwarding. A successful
first-party intake proves storage, not asynchronous Amplitude receipt.

## Error coverage and privacy

Sentry starts before session or SQLite storage reads. The SDK captures native crashes. Handled
reports cover HTTP/transport and successful-body decoding, journal storage and drafts, SQLite
reads/writes, protected-storage preparation, fork-guard I/O, Keychain reads/writes/deletions and
enumeration, session restoration, code authentication, Apple ticket creation/linking, sign-in-method
reads, Apple removal, adoption and sign-out. The sync engine
reports unexpected admission results, digest resets and doubts that reach the backoff ceiling,
once per doubt episode. Engine and app runtime adapters enqueue static diagnostics through
`BoundedTelemetry`: a serial utility worker invokes the sink outside engine/writer/publisher locks.
At most 128 records wait behind one in flight; overflow silently drops new diagnostics. A blocked
sink cannot delay commits/subscriptions or enter adaptive writer timing.
HTTP owns transport reports; the engine's deadline uses the same invocation
diagnostics to avoid a second report and retains the failure kind in pull/push outcome metrics.

HTTP failures carry method, coarse route family (`/v1/auth`, `/v1/me`, `/v1/sync` or `/v1/events`), a static
operation, `failure_kind`, optional numeric status label and `duration_ms`. Duration uses a monotonic
clock through response consumption and decoding. Sync outcomes also cover application of the reply
to the local store. Expected statuses 400, 401, 403, 404, 409, 410, 422 and 429 are product/API metrics,
not Sentry Issues. Offline/DNS/connect failures are metrics; cancellation is quiet. Timeouts, TLS,
unexpected HTTP responses and decoding failures are reportable. No URL, dynamic identifier, query
string, authorization header or response body enters telemetry.

The promise is **Only you.** Never send journal text, text length, mood or energy values, email
addresses, Apple subjects/tickets/identity tokens, session tokens or response bodies. Apple tickets
live in memory only and are cleared on dismissal, expiry or completion. Product properties pass a finite allowlist of labels;
unknown event names, property names and label values are discarded. Duration is the only numeric
product property and is clamped to 0–86,400,000 ms. Version/build/release metadata is bounded.

The final Sentry send hook removes messages, requests, extras, breadcrumbs, user identity, transaction
and server names, arbitrary tags and custom contexts. It strips exception messages and mechanism
details while retaining compiled exception types, stack traces, release and technical operation tags.
Only bounded technical fields of app/device/OS/runtime contexts and a reconstructed numeric `telemetry.duration_ms` survive.
Device-app hashes, view names and locale are removed. Memory introspection, screenshots, view hierarchy, replay, logs, metrics, tracing, profiling and
MetricKit are disabled. Technical reports contain no product navigation history.

## Product events

The 18-name allowlist below covers the app's screens and actions. Every row also carries the common
platform/version/build/release/environment properties. Scale answers record only that the invitation
was answered or declined; neither the scale name nor its value is recorded.

| Area | Events | Useful properties |
| --- | --- | --- |
| Application | `app_started`, `app_foregrounded`, `app_backgrounded` | common metadata |
| Authentication | `auth_restore` | outcome: anonymous, signed_in, paused, failed |
| Email code | `auth_code_requested`, `auth_code_sent` | method: email; outcome: ok, failed |
| Sign-in | `auth_sign_in_started`, `auth_signed_in` | method: email, apple; outcome: ok, linked, failed, cancelled; linked follows a code link or signed-in attach |
| Sign-out | `auth_signed_out` | outcome: ok |
| First-run screens | `first_run_screen_viewed` | screen: welcome, journal, ink_notes, keep, address, code, you, adoption, discard_adoption, sign_out, 23a, 23b, 23c, 24a, 24b, 24c, 24d, apple_no_account, apple_expired, auth_pending |
| Choices | `first_run_choice` | screen; action: open_journal, show_ink, dismiss_ink, keep, close, email, back, change_email, resend, add, discard, cancel, sign_out, use_account, create_account, remove_apple, retry |
| Optional scales | `scale_invitation_shown`, `scale_invitation_answered` | action: answered, declined |
| Writing | `journal_line_saved` | day_kind: today; emitted after a changed, nonempty body saves, never for scale-only changes |
| Synchronization | `sync_pull_outcome`, `sync_push_outcome` | outcome: ok, failed; failure_kind, status, duration_ms |
| Reliability | `api_request_failed`, `client_error` | operation, method, route, status, failure_kind, duration_ms; optional coarse scope_kind |

Screen and choice events also record visits when the same screens are revisited after first run.
Apple auth operations use static labels `auth_apple`, `auth_apple_create`, `auth_verify_code`,
`auth_methods` and `auth_apple_remove`. Removal uses method `DELETE`; reading methods uses `GET`.
The simulator model follows the same auth-boundary failure reporting, without secrets in diagnostics.
A legacy Apple door returning `created: true` is a decode failure; its session never reaches the engine.
`auth_pending` marks authenticated sign-in awaiting engine recovery; `retry` resumes the retained
identity without repeating code verification or ticket creation. Retries also run after a five-second
delay while the app is open. Paused Apple linking validates the verified account id before bearer
attachment. Apple removal treats HTTP 404 as already removed, alongside 204.
No page counts, record IDs, dates, text, scale values or account identity are included in properties.
The wire schema is `{sessionKey, platform: "ios", events: [{id, name, clientMs, props}]}`.
UUID event IDs and the session key persist across relaunch and retries.

## Delivery and limits

Queue restoration opens and decodes the file on a detached utility worker, independently of journal
startup. A 1 MiB size check precedes reading/decoding, and the read itself is capped to reject growth
between checking and reading. Enqueues await the same restoration and preserve restored IDs.
The actor-owned queue writes atomically before sending, excludes its directory from backup and uses
file protection until first unlock. It retains at most 500 events across account shelves and sends
batches of at most 50. Full queues reject new events and report `telemetry_overflow` once until
delivery frees capacity. Queue failures cannot fail a journal action. Launch and identity changes
attempt delivery, and a running process schedules a flush every 30 seconds. Delivery failures wait
30 seconds before retrying. Storage failures retain dirty state and retry persistence before delivery,
even at capacity, with exponential backoff from 1 second capped at 30 seconds. New events cannot
bypass that storage backoff; a scheduled flush can recover without relaunch or another event.

Anonymous queued events always send without credentials, including after sign-in. An account's
events wait until that account is active with a usable token. Account identity is local queue routing
metadata and is omitted from the wire batch. Tokens remain in memory/Keychain, never in the event
file. A request in flight retains its original credential and acknowledges only its captured IDs.
The backend resolves signed-in identity from the bearer, independently of event properties.

`202 {"accepted":N}` removes the submitted batch. Partial acceptance reports `telemetry_rejected`
and drops the entire submitted batch because the client cannot identify rejected entries. An invalid
acknowledgement retains the events and IDs. Unexpected delivery failures report once per failure
streak, reset after success, without recursively producing a product event. Expected HTTP statuses,
offline and cancellation do not create delivery Issues. Storage errors likewise use Sentry directly.

Delivery is bounded best effort. Uninstall, corrupt storage, a full queue, termination before an
asynchronous enqueue, or an account that never returns can lose events. Stable IDs let Amplitude
deduplicate retries; Postgres may retain repeated accepted entries. Backend forwarding has no durable
outbox, so neither local persistence nor Postgres receipt proves vendor delivery.

## Release readiness

`WM_APPLE_SIGN_IN_ENABLED=NO` is the default: `Tools/Windmill-NO.entitlements` declares no Sign in
with Apple capability. `YES` selects the entitlement and UI only for a configured server/team.
Apple sign-in remains postponed pending developer-portal setup and a real-device check.
`CFBundleVersion` follows `CURRENT_PROJECT_VERSION`. The app's `PrivacyInfo.xcprivacy` declares
UserDefaults for local app state and monotonic time for elapsed durations, with no tracking. Its
collection declarations distinguish journal/auth synchronization from analytics; writing and scale
values have only the app-functionality purpose. Sentry and GRDB bundle their own manifests. The
manifest follows [Apple's required API reasons](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
and [data collection categories](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype).

`.github/workflows/ios-release.yml` runs only through `workflow_dispatch`, with Xcode 26.3. It uses
`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` and `IOS_SENTRY_DSN`. It archives
with automatic development signing (a registered device is required), then exports/re-signs for
App Store Connect and uploads. Build number is the workflow run number. It never forces a distribution
identity onto SPM targets. dSYMs are retained as CI artifacts; uploading them to Sentry requires
authentication beyond the DSN and is not configured with the existing secrets.

## Local checks

Always use `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` locally.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export IOS_SENTRY_DSN=https://nonproduction@example.invalid/1 # Local/CI verification only.
cd apps/ios/App
xcodegen generate
python3 -m unittest discover -s Tools/tests -v
xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,id=<own-simulator-uuid>'
# Build Windmill in Debug and Release for generic/platform=iOS Simulator, then inspect both:
codesign -d --entitlements :- <derived-data>/Build/Products/Debug-iphonesimulator/Windmill.app
codesign -d --entitlements :- <derived-data>/Build/Products/Release-iphonesimulator/Windmill.app
# From each package directory:
swift test # Sync (twice), Domain and SyncTestingSurface
# From Sync:
xcodebuild build -scheme WindmillSync-Package -destination 'generic/platform=iOS Simulator'
# From the repository root:
actionlint .github/workflows/ios.yml .github/workflows/ios-release.yml
```

Regression tests block the technical sink while committing and subscribing, proving it does not
enter adaptive writer timing; they also exercise queue restoration off startup, oversized/growing
files, storage backoff and recovery of a full 500-event dirty queue without relaunch.

The simulator-only `-scenario telemetry-first-run -report <path> -code-file <path>` fixture uses the
real backend with a seeded development code in a throwaway database. It saves anonymously, chooses
Keep, signs in, backs up, exercises session revocation/reauthentication and sign-out, and returns to
the same account. With Resend unset, its final code request forces a real handled 502 auth failure.
Run with `-server http://127.0.0.1:8089 -telemetry -sentry-dsn http://ios@127.0.0.1:8091/42`, a local
Sentry envelope collector and the checkpoint helper described in App/README.md. Inspect `events`
with `props->>'platform'='ios'` and the collector envelope for excluded content and scrubbed fields.
These checks establish first-party and local SDK receipt. Native crash delivery, real Apple sign-in,
Sentry symbolication, Amplitude acceptance and App Store Connect/TestFlight upload require separate
credentials/device or vendor checks.
