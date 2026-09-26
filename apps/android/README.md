# Windmill Android

A Kotlin/Compose app for gym: workout entry, routines, history and Coach. It shares the Windmill
account and backend. There is no subscription surface.

## Layout

| Module | Responsibility |
|---|---|
| `:platform` | Bearer HTTP transport, account/session storage, sign-in, tokens and product-neutral shell. |
| `:gym` | Pure domain rules, durable stores, network/notification adapters and Compose UI. |
| `:app` | Composition root; one auth store, gym runtime, training store and notification adapter shared by activity and receivers. |

Products depend on `:platform`, never on each other. See [repository structure](../../STRUCTURE.md).
The app is portrait-only. Shared gym rules live in
[backend architecture](../../backend/products/gym/ARCHITECTURE.md), UI rules in
[gym design](../../docs/design/gym/briefs/00-README.md), and Coach's retry/stream/image rules in
[the conversation contract](../../docs/gym-coach-contract.md).

## Build

Run from `apps/android`:

```sh
export JAVA_HOME=…    # JDK 17+; CI uses Temurin 21
ANDROID_SENTRY_DSN=https://local-check@telemetry.invalid/1 ./gradlew build
```

- `local.properties` supplies `sdk.dir`; Android Studio writes it on first open.
- Modules use `compileSdk 36`, `minSdk 26` and Java/JVM target 17.
- Keep the full monorepo: the ladder suite reads `packages/api-contract/gym-ladder.json` directly.
- Compose UI tests use Robolectric; its first run downloads `android-all` from Maven Central.
- `-Pwindmill.apiBase=http://10.0.2.2:8088` targets the host's local backend from an emulator.
  Empty means the production host.

The placeholder Sentry DSN above is for local build validation. Release assembly requires
`ANDROID_SENTRY_DSN`, or `-Pwindmill.sentryDsn`, for the dedicated Android project. Debug telemetry
is disabled unless `-Pwindmill.debugTelemetry=true` is supplied. Error reporting, event delivery,
privacy and collector tests are described in [Android observability](../../docs/ANDROID_OBSERVABILITY.md).

## Account and device storage

Sign-in uses an emailed six-digit code (`door:"app"`, `POST /v1/auth/verify-code`). The same field
accepts a pasted magic link or token. There are no app links.

`SessionStore` seals the credential and verified user together through `SecretVault` (AES-GCM,
Android Keystore). Backup is disabled by both manifest and extraction rules. A Keystore failure
has no plaintext fallback. Offline restore retains a previously bound account as unverified;
legacy or unreadable identity stays unresolved. Only a confirmed 401 signs out. Resume retries
verification, and transports and local writes remain bound to their selected account.

Device stores use `Seat` keys (`u.<userId>` or `anon`). `LocalLog`, `SetQueue`, `LocalBodyweight`
and `LocalPreferences` support signed-out training. The bundled movement catalogue uses backend
seed ids so local workouts can later synchronize. Legacy files without a seat are attributed once
to the session held when opened; without one, they are quarantined.

Signing in selects an account; it does not adopt anonymous records. Gym settings offers **These
are mine** and **Not mine** for a frozen local-data batch. Signed-out approval binds a specific
sign-in flow; verified identity binds the batch before credential commit. Cancel revokes the intent.

`ClaimConsent` and `LocalClaimConsent` persist source revisions, decision and owner before transfer.
A corrupt consent journal blocks transfer. Repository completion markers let a restart resume
only the approved batch and owner; newer/changed records stay separate. Active-queue preflight
must pass before transfer or replay. **Not mine** gives nine seconds to Undo, then removes only
unchanged captured records. Unverified accounts may use their own local records but cannot finish
an approved transfer until verification succeeds.

## Replay and workout runtime

`ClaimReplay` sends preferences, movements, routines, finished sessions oldest-first, the unanswered
live-session start, then weigh-ins. Finished sessions replay start → sets → finish with
`joinOpenSession:false`. The queue's `unclaimed` bit records an unanswered start, never consent.
Owed sets drain before replay and the settling log read. Failed preferences retry independently;
untouched defaults do not participate. Delayed replies cannot overwrite another account or newer
local revisions.

An explicit start also sends `joinOpenSession:false`. A `session-already-open` refusal reloads
and adopts the existing session while retaining the refusal. Offline, 5xx and `clock-ahead`
responses leave new work on the device for replay. A device-held session idle for four hours
finishes at its last activity on reconnect. First-session onboarding requires successful log and
routine reads, not empty lists caused by failed requests.

`GymRuntime` is shared with notification receivers, which restore local state without HTTP auth.
Logging commits the set, consumed action and timestamp together. Rack edits, movement/account
changes and finish invalidate prior actions; notification logging requires unlock and current
identity. Native exercise paging must settle before rack edits or set logging.

The ongoing notification shows the workout and can become a system Live Update. Dismiss hides it
for that session; Show workout restores it. Workout elapsed and time since the latest retained
set survive relaunch and freeze at finish. There are no rest alerts or set confirmation signals.
The UI displays kilograms even with an account preference of lb.

Preference/routine replacement reads and preserves server-owned fields first. Unknown future or
malformed saved-workout state leaves the queue read-only for recovery; the decoder tolerates the
retired version-1 rest-control keys without interpreting them.

`LocalCoach` persists account-scoped drafts, request/attachment ids and partial replies. Retry
retains identity; Stop preserves partial text and completed actions. Images use authenticated
bodies. `CoachPhotos` normalizes them within 4096 pixels per edge and 5 MiB. New chat clears the
local pending request while retaining server history.

## CI and releases

[Android CI](../../.github/workflows/android.yml) builds/tests relevant main pushes and pull
requests. An `android-v*` tag or versioned dispatch also produces unpublished signing inputs:
a non-debuggable APK, SHA-256 and source/run provenance. The temporary signature is not the
release identity. CI has read-only repository permissions and no private signing key.
`versionCode` is the workflow run number and must exceed every previously published version code.

Release signing is local. The retained encrypted PKCS12 key and password are held separately;
`release-signing.json` pins the public certificate. `tools/release.py finalize` checks independently
verified commit/ref/version/workflow/run identities, receives the password through stdin, verifies
the input, signs and checks the certificate and unchanged application contents. Its APK, digest
and provenance remain unpublished until native acceptance and a same-key update check pass.

Distribution is by sideload. Published APKs through 0.7.1 use different debug certificates and
cannot update in place with the retained release key. Uninstalling removes device-only records;
preserve them before changing installation. Signing in alone does not transfer anonymous records.

Spoken TalkBack acceptance is unverified. Routines tab labels clip at 320dp with 200% text; see
[the design consistency ledger](../../docs/design/consistency.md).
