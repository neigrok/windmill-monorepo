# Android implementation

The [Android task backlog](../../androidgym_tasks/README.md) ships one commit per task, in dependency
order. Visual work requires the task’s human-approved Figma state. A batch reaches main after
adversarial review, simplification, targeted checks and native/local-stack acceptance.

## Task 01 — background reads and native capture rig

The local-only rig builds and validates its debug API origin before installation, creates its own
Postgres database and API 37 Pixel 8 emulator, and drives deterministic MCP/sync fixtures and Coach
responses. It captures ten current native states across Dark and Daylight, preserving the APK,
SHA-256, source revision, dirty status, readiness measurements, idle trace and failure manifest.
Recipe board names include dotted, suffixed and letter-prefixed canonical IDs. The
[runbook](../../apps/android/tools/DESIGN_CAPTURE.md) documents recipes and cleanup.

TrainingStore publishes background read results only while their account, replica, revision and
workout still own the request. EngineTraining caches the parsed log by complete engine revision and
auto-close deadline under the engine lock. Pending delivery status reads published state during
recomposition. Bounded retries retain connection and selected-history intent; an abandoned read
cannot leave an account loading forever, replace an edited rack, or use another account’s last time.
Log refresh and pagination share a mutex so a queued Finish refresh cannot supersede awaited
external-workout adoption. Engine writes and Compose state publication remain on main.

The integrated gym Debug suite passes 1,167 tests with 17 opt-in live-wire cases skipped (1,184 total,
139 classes). Sync-engine Debug and Release each pass 183 tests; the debug app assembles. Four capture
tool tests pass. Explicit delayed-read tests cover account switches, repeated revisions, connection
and restore completion, edited rack preservation, observer liveness and failure operation names.
Compose tests await semantic readiness or coroutine completion without blocking main behind the
log-read mutex. The fixture owns and cancels its child scope before closing its engine.

Comparable no-Sentry-DSN baseline and task01 APKs use the same debug readiness probe, fixture and
emulator configuration. Cold rendered readiness is 9,205 ms versus 1,821 ms. Ten-second idle traces
record 649.977 ms versus 369.043 ms of main-thread CPU; the final trace contains no sampled main-thread
engine read or pending-set query. The integrated telemetry-enabled APK reaches rendered Routines in
1,655 ms; its independent accessibility selector takes 3,898 ms. Ten captures pass, with no ANR or
fatal exception. Host timing is kept separate from device readiness and the comparable CPU pair.

## Task 06 — set semantics

The app model, rack acceptance, performed rows and saved-workout recovery have no set-kind API or
control. Every set contributes to counters, totals, history, last-time prefill and early-finish rules.
Legacy kind fields are ignored when decoding; new set writes omit them. Shared compatibility vectors
remain unchanged. Debug and Release real-wire suites each pass 17 cases with zero skips. A further
Debug run passes all 17 against the backend auth-receipt/schema prerequisite on main.

Native acceptance logs eight 60 kg × 8 sets across two routine movements. The receipt and backend
readback count all eight sets and 3,840 kg. A local REST import carrying warmup, working, drop and
failure values retains all four sets; the installed app shows four ordinary rows and 960 kg. No kind
control appears. Local recovery compatibility is covered by the unit and wire suites.

The simplified rack has one acceptance path for every logged set. Recovery retains source documents
for retry without a separate kind-correction state. Wire summary fields retain their existing names;
they count every set. The app still contains history/read projections alongside the shared domain;
future consolidation should preserve the shared estimate qualification and equipment-load rules.

## Task 12 — logging above plan

Movement navigation has no heavier-than-plan offer or implicit routine write. The logger retains
only the movement-transition guard and closes an active sheet before choosing the next movement.
Routine-editor saves and accepted Coach proposals remain the explicit routine-write paths. All 156
targeted tests pass with zero skips. The workout regression asserts unchanged routine content and
revision, no dialog or transient message, and one content-free set event per logged set.

Native acceptance logs four sets for each of two movements against targets of three sets at 30 kg.
All eight performed sets use 60 kg. Navigation and Finish show no retarget sheet or alert, and the
entire routine response is exactly equal before and after the workout. Removing the isolated retarget
API leaves the guarded routine draft save as the editor’s one write path. Proposal comparison rows
are private to their remaining screen.

## Task 13 — routine-only app starts

App starts require a routine ID. The action decision checks the loaded routine and open-workout state
atomically before creating a workout, while a repeated session identity remains idempotent. Routines
has no free-start action, and receipts have no routine-save form or callback. All 233 targeted tests
pass with zero skips. Externally started workouts and legacy imports retain the optional routine
format, existing movement picker and shared **Free workout** title.

Native acceptance verifies both removed controls. An MCP-started workout without a routine is received
after app restart, opens **What are you lifting?**, logs a set, finishes with a **Free workout** receipt
and reopens its detail. The receipt counts one set and 480 kg. Receiving, finishing and reopening it
adds no app-start event. Receipt state is keyed by session ID; it reads the saved workout and offers
its existing Coach action.

## Batch acceptance evidence

The integrated run is saved at `/private/tmp/windmill-android-batch/task01-native`, including
`capture-manifest.json`, ten board PNGs, manual acceptance PNG/XML, exact routine and session
readbacks, `batch-acceptance-summary.json`, first-party events and structured backend write logs.
Its APK SHA-256 is `98436a9b55060c04d3a8660324cdb27a6b83aacb4790718dd5f41784dbde68c1`,
built from `00225342d91185c23120519e925454a79fbd1e82` plus the reviewed task01 changes. The native
fixture uses the integration schema and matching original backend binary; the newer backend
compatibility check is the separate 17-case Debug real-wire run.

The first-party intake receives exactly nine `gym_set_logged`, two `gym_session_finished` and one
`gym_session_started` event. Those events contain only common application metadata; there is no
routine-save event. Backend logs contain successful sync pushes, event intake, external MCP start
and legacy REST import observations. A deliberately malformed private workout file produces the
installed-app Sentry event `643df758b3d0447cb0a5fca53886ce8c` under `gym.storage.read` at the local
collector. The envelope omits exception messages, the synthetic file sentinel, fixture content and
credentials. The exact backup is restored and the app opens normally. This verifies local SDK
transport and first-party intake, not hosted vendor receipt.

The full-suite XML is archived at `/private/tmp/windmill-android-batch/task01-full7-xml.tar.gz`.
Comparable performance artifacts are `/tmp/windmill-android-capture-quiet-baseline` and
`/tmp/windmill-android-capture-quiet-final2`; both preserve their APK and manifest. Future ticking
logger or notification recipes need layout/body settlement instead of exact accessibility-tree
identity. Later visual tasks add their own approved board recipes; these captures do not claim
those screens already match Figma.

## CI verification and Finish readiness

Finish derives its enabled state from observable workout and account readiness, a current session,
and the in-flight Finish guard. Reconnecting the same account disables the existing action while
its background read is pending, including when the loaded data is unchanged. A disabled tap makes
no engine write, finish event or technical failure; after readiness returns, one Finish preserves
all sets and emits one `gym_session_finished`.

Receipt and restored-row tests await their semantic state. The retry fault is armed at the
retry-start event, immediately before its transaction, so unrelated observer reads cannot consume
it. Onboarding tests assert the Routines heading and New routine action, keep their introduction
and lifecycle assertions, and restore mutated launch intents in `finally`. The existing-data fixture
constructs only the launch gate instead of starting the Application twice. A deliberate assertion
after an external intent completes with one expected failure and XML output in 14.782 seconds.

CI bounds the Gradle step to 55 minutes within a 60-minute job and always uploads unit XML and HTML
reports with 14-day retention. This budget accommodates the verified 31-minute healthy CI run and
leaves time to upload diagnostics after a step timeout. The focused gym checks pass 36 cases in each variant; onboarding
passes 35 in each variant, with no skips. All 22 capture and release-tool tests pass.

The local full `./gradlew build` passes in 10 minutes 49 seconds, including lint and APK packaging.
Gym Debug and Release each pass 1,168 tests with 17 opt-in live-wire skips (1,185 total); app passes
47, platform 129 and sync-engine 183 in each variant. Domain, layering, model-server, corpus and
shared replay/property gates also pass. Complete XML and per-task counts are preserved at
`/private/tmp/windmill-android-batch/ci-full-build-xml.tar.gz` and `ci-full-build-counts.json`;
`ci-teardown-probe.json` records the bounded deliberate-failure check.

Native acceptance on API 37 starts and finishes two routine workouts, each retaining one 30 kg × 8
set and a 240 kg receipt. Backend session readbacks match both completed workouts; intake records
exactly two starts, two logged sets and two finishes with common metadata only. The routine response
is unchanged after the first workout. No new local collector exception event appears during acceptance.
Two native Routines captures are retained. The cold probe reaches rendered readiness in 1,930 ms,
with no ANR/fatal report; the one-second trace is 75,564 bytes. The fixture completes and removes its database and emulator.
Evidence is in `/private/tmp/windmill-android-batch/ci-native`, including `acceptance-summary.json`,
receipt PNG/XML, readbacks, events and APK SHA-256
`d2420a036179ea65b4d378aa77cebdc0d18db26a8313cff6cc59e462fe5cc0ea`, built from `b4ce8fb3` plus
the reviewed CI changes. Delayed-read disabled-action behavior is verified by the deterministic
Compose regression; the native flow verifies normal readiness, persistence and telemetry.

## Task 02 — shared color roles

The gym palette owns native error and on-error roles separately from refusal text. Daylight uses
verdigris for the app and onboarding, gold-700 for record text and the approved warm record wash.
Unused hover and pressed accent fields are absent; native state layers belong to the shared-part
implementation. The routine picker uses the approved surface role and the live-link Revoke action
uses the accent. All 35 focused palette/account/onboarding/planning/sharing tests pass with zero skips;
four capture-tool tests pass. Native colour acceptance covers all four recipes in Dark and Daylight.
The final picker body uses #161C1D / #F8F6F4; the live-link Revoke action uses the accent.
Remaining Name-field and picker-height differences belong to task 18 (consistency 11q).

The shared palette is the one color source for app chrome, account chrome and the gym onboarding
accent. This task adds no events or write boundaries. Existing Coach action structure and review
paths remain under the release scope exclusion.

Task 02 evidence is in `/private/tmp/windmill-android-colour-roles-installed-final`: the final APK,
its manifest, picker PNG/XML pairs, focused-test XML, palette checks, runtime log and observability
summary. Its APK SHA-256 is `1154e9bb01ad3f67dd4803129221790f418669ad414cc4ff3a9ebad71cd40928`.
The manifest links the six unchanged editor/share captures to
`/private/tmp/windmill-android-colour-roles-final2` and that capture APK. The eight-capture run has
no ANR or fatal exception, a 1,579 ms ready frame and a nonempty 410,150-byte idle trace; the final
picker pair also has no ANR or fatal exception. The exact runtime scans are retained locally.

The local event intake contains only allowlisted application labels and no fixture names, emails
or share addresses. Two successful share-write observations resolve to one idempotent share row;
all three routine revisions remain 1 after the cancelled editor captures. Palette changes add no
write, event or failure boundary. The local Sentry collector receives SDK session envelopes; no
new technical failure is observed. This verifies local intake and SDK transport, not hosted receipt.


## CI fixture scheduling

Engine-room fixtures run ordinary reads on their owned coroutine dispatcher, with immediate Main
execution for synchronous Robolectric setup. Explicit held and background dispatchers still exercise
read invalidation, account isolation and delayed same-account Finish readiness. Receipt and restored
rack interactions await the corresponding enabled action or loaded value. The Coach proposal check
drains its scheduled program refresh before asserting the complete proposal list.

All 140 focused checks pass in each variant, including the entire Finish, workout recovery,
training-store, background-read and Settings screen classes. Full gym Debug and Release each pass
1,169 tests with 17 opt-in live-wire skips (1,186 total), zero failures and zero errors. Both full
variants complete in 2 minutes 31 seconds. Evidence is preserved in
`/private/tmp/windmill-android-batch/ci2-focused1-xml.tar.gz`, `ci2-full-gym-xml.tar.gz`,
`ci2-full-gym-counts.json` and `ci2-full-gym.log`.

This verification change adds no product code or observability boundary. The native Finish,
persistence and telemetry acceptance recorded above applies to the unchanged runtime. CI uploads
XML and reports even when tests fail, and the remote job terminates within its configured bound.
