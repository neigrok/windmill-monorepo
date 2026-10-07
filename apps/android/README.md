# Windmill Android

A Kotlin/Compose app for gym: workout entry, routines, history and Coach. It shares the Windmill
account and backend. There is no subscription surface.

## Layout

| Module | Responsibility |
|---|---|
| `:platform` | Bearer HTTP transport, account/session storage, sign-in, tokens and product-neutral shell. |
| `:gym` | Android training runtime, device storage, presentation models, network/notification adapters and Compose UI. |
| `:app` | Composition root; one auth store, gym runtime, training store and notification adapter shared by activity and receivers. |
| `:sync-core` | JVM JSON/JCS, registry descriptors, clocks, joins, identities, fractional order and digests. |
| `:sync-api` | JVM product values, Replica port, transaction readers and typed commit failures; depends only on sync-core. |
| `:sync-schema` | Generated JVM gym and journal registries and composition. |
| `:sync-engine` | Android memory/SQLite engine, writer slices, observations, HTTP/live transport, recovery, subscriptions and lifecycle sessions; bounded injected telemetry. |
| `:sync-model-server` | JVM reference model with probe, gym and journal bindings, admission, replay and live events. |
| `:sync-testing` | JVM strict client/server corpus, stepped memory engine, simulated network, mandatory properties, replay fuzz and layering. |
| `:domain-kit` | JVM values, readers, plans, drafts, action runner, ordering and refusal subjects. |
| `:domain-kit-testing` | JVM strict kit corpus, checks and layering. |
| `:gym:domain` | JVM gym actions, training reads, progress, units and rules; every shared gym domain vector. |

The eight JVM modules and Android engine library contain the SyncAPI, client runtime, model server
and kit. The full build enforces corpus coverage, properties, replay fuzz, schema freshness and
strict layering; see [coverage, gates and remaining work](SYNC_FOUNDATION.md). The app composes
that runtime for gym, with signed-out workout imports and account decisions.

Products depend on `:platform`, never on each other. See [repository structure](../../STRUCTURE.md).
The app is portrait-only. Shared gym rules live in
[backend architecture](../../backend/products/gym/ARCHITECTURE.md), UI rules in
[gym design](../../docs/design/gym/briefs/00-README.md), and Coach's retry/stream/image rules in
[the conversation contract](../../docs/gym-coach-contract.md).

## Build

Run from `apps/android`:

```sh
export JAVA_HOME=…    # JDK 17+; CI uses Temurin 21
ANDROID_SENTRY_DSN=https://local-check@telemetry.invalid/1 ./gradlew build --max-workers=4
```

- `local.properties` supplies `sdk.dir`; Android Studio writes it on first open.
- Modules use `compileSdk 36`, `minSdk 26` and Java/JVM target 17.
- Keep the full monorepo: the ladder suite reads `packages/api-contract/gym-ladder.json` directly.
- Compose UI tests use Robolectric; its first run downloads `android-all` from Maven Central.
- Sync foundation checks read the shared registries and corpora directly; the schema generator and
  independent JCS oracle checks also require Python 3 and Node.js.
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
Android Keystore). Engine credentials use the same vault. Backup is disabled by both manifest and
extraction rules; a Keystore failure has no plaintext fallback. Offline restore retains a previously
bound account as unverified. Only a confirmed 401 expires identity. A durable sign-out fence prevents
a restart between Keep and credential removal from signing the account back in.
Verified sign-in proposals have a separate sealed credential. The current account changes only
after the engine accepts the decision; cancelling a proposal keeps the previous account and work.

The application owns one SQLite engine and runtime, with separate anonymous, bound and dormant
account replicas. Android subscribes only to gym; signed-out work never pushes. An empty account
accepts signed-out training automatically. When both sides hold training, sign-in presents pinned
**Add** / **Discard** counts, including refused imports retained on this phone. Work changed while
the choice is open requires a fresh decision. Sign-out uses **Keep**, retaining unsent account work
in its dormant replica and selecting an independent anonymous replica.

Before every sign-in, `WorkoutImports` prepares each signed-out workout for the account. A finished
workout becomes one durable atomic strict import. An unfinished one becomes a start that refuses
joining another open workout; its sets follow under their own identities once the account
confirms that start, and the server assigns their set numbers. A planned start waits for the
account pull and refuses a changed frozen routine plan. Conflicting workouts remain inspectable on
the phone, with an explicit **Keep** action that imports them finished at their last set.
Dismissing a notice does not remove workout content. Refused imports retain their source on the
phone. Gym settings shows the reason and offers explicit correction and retry; dates, sets and
frozen routine lineage are never silently changed.

## Training runtime

`TrainingStore` keeps the training interface and runs training reads and writes through
`EngineTraining` and `:gym:domain`; a write commits to the selected replica at once and the engine
delivers it. A refusal by the log's rules is said on screen and is not reported as a failure.
`WorkoutControls` (`windmill-gym-sets.json`) holds the open workout's device controls used by the
shared `GymRuntime` and notification receivers: movement order, the movement in hand, the rack's
offer and the clock each set was logged at. It is a projection of the selected replica, rebuilt
when the replica changes. It also retains accepted sets until their engine commit succeeds.
Finish and projection refreshes recover those sets before clearing the controls; a failed recovery
keeps them for retry. An adopted workout's Finish also waits for its start acknowledgment and
commits its owed sets before the finish command; while waiting, it retains the controls for Retry.
Finish receipts read the committed replica. The adoption journal retains submitted sets until their
server results arrive. A locally stranded set can be retried into the finished workout through a
guarded correction when the server advertises registry 6. A late `session-finished` refusal, a
finish or overlap that prevents correction, or a server advertising an older registry uses a
separate workout with new account identities: its
start, complete saved set and finish are acknowledged in order. The original source, values, time
and kind survive; concurrent changes leave the source available for another retry. Settings Retry
schedules reconciliation before reporting completion.
The bundled movement catalogue uses backend seed identities. Only Coach
threads, attachments, shares and connected-log credentials use REST, through `GymRest`.
`coach/` groups conversation models, storage, photos and screens. `CoachStore` owns thread reads,
retries and streaming; `TrainingStore` composes it with the current account, shared Undo windows and
routine refresh. `LocalCoach` retains account-scoped drafts, request identities and partial replies;
retry retains identity and Stop preserves completed work. Shared HTTP framing lives in `net/GymHttp.kt`.
`sharing/` owns public workout links and their card; sharing a workout does not involve a Coach conversation.

Notes live with the account. They retain an unread state until the account's first pull
completes; subsequent pulls refresh the open notebook, and refused saves show their refusal.

Workout logging persists consumed actions and timestamps. Rack, movement, account and finish
changes invalidate stale actions. Notification logging requires unlock and current identity;
native paging must settle before rack edits or logging. The silent ongoing notification can become
a system Live Update. Dismiss hides it for that workout; Show workout restores it. Elapsed and
latest-set clocks survive relaunch and freeze at finish. There are no rest alerts or set-confirmation
signals. The UI displays kilograms even with an account preference of lb.

A 426 from the engine presents **Update required**.
The local replica remains intact while network synchronization is paused. Update destination
configuration and observability are documented in [Android observability](../../docs/ANDROID_OBSERVABILITY.md).

## Local verification

Use the full build above for both variants, lint, assembly and shared engine/domain gates. For
device checks, build with `-Pwindmill.apiBase=http://10.0.2.2:8096` and use `Pixel_API34_Root`.
Follow [the backend runbook](../../backend/RUNNING.md) with a separate database loaded from
`schema.sql`, on port 8096.

Install an APK built from `android-v0.11.0` with the same test signing key, log finished and
unfinished workouts signed out, then install this build over its data and sign in: the workouts
arrive as imports with their IDs and frozen routine lineage. Check crash/restart and
refused-import recovery. Log offline, restart, reconnect and verify the server records; exercise
Add and Discard with data on both sides, and Keep at sign-out. A same-debug-key source upgrade
does not establish published release signing.

The live-wire suite requires a fresh local account credential and a single-use magic-link token
issued against that backend; the runbook's direct-database development code uses the normal auth
door. Keep credentials out of logs. Run each variant with:

```sh
WM_ANDROID_WIRE_TEST=1 WM_WIRE_BASE=http://127.0.0.1:8096 \
  WM_WIRE_BEARER="$WM_LOCAL_BEARER" WM_WIRE_LINK_TOKEN="$WM_LOCAL_LINK" \
  ./gradlew :gym:testDebugUnitTest --tests '*LiveWireTests' --max-workers=4
# Repeat with :gym:testReleaseUnitTest and a fresh single-use link.
```

Stop listeners by the selected port, drop the test database, stop the emulator and any ADB/Gradle
daemon started for the check, and remove temporary credentials. Verification counts and installed
app observations belong in the task report, rather than a lasting evidence file.

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

The published [0.11.0/code160 release](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.11.0)
uses tag `android-v0.11.0` at `192bc26182ad18f4d377d9a320af52f7406d3226`,
[Actions run 37385912056](https://github.com/neigrok/windmill-monorepo/actions/runs/37385912056),
attempt 1, from a tag push. Both jobs passed. Local finalization verified the retained certificate,
non-debuggable package, unchanged application contents and linked provenance. All three anonymously
downloaded assets are byte-identical to the accepted files. The APK SHA-256 is
`de1a8cc89655c145d4c7ea8b56d7e6f7b474b12dc3789608d608daaf18648581`.
The release workflow supplies `-Pwindmill.updateUrl=https://github.com/neigrok/windmill-monorepo/releases/latest`;
the APK contains that destination, which resolves to this release.

Android 14 emulator acceptance used the public 0.10.0/code108 APK, signed out against the production
configuration. Its routine, finished 20 kg × 5 workout, live two-set workout and 72.4 kg weigh-in
survived `adb install -r` with their IDs, values, timestamps and frozen plans intact. The live workout
accepted a third set, then a fourth in airplane mode; all four survived force-stop/restart offline.
Finishing retained 400 kg volume alongside the original 100 kg workout. The routine and original
workout opened correctly. An independent clean install opened the empty Routines screen.

Signed-in source/debug-key upgrade, Add/Discard/Keep and offline server delivery reuse
[completed A2 acceptance](https://github.com/neigrok/windmill-monorepo/commit/10680fd17f521fc4e9dd957b3f9459028565e254)
and [final A2 CI](https://github.com/neigrok/windmill-monorepo/actions/runs/37383639801).
[Notes coverage](https://github.com/neigrok/windmill-monorepo/blob/3c814064d7b80ac76b8a833e75e9f8a7ecdc93af/apps/android/gym/src/test/kotlin/works/windmill/gym/ui/EngineNotesScreenTests.kt)
is Compose/engine-model testing. Signed-in acceptance was not repeated on the published-key APK:
Android application code is unchanged from A2 at `3c814064`; the release adds the update destination.

Distribution is by sideload. Published APKs through 0.7.1 use different debug certificates and
cannot update in place with the retained release key. This build reads no device records written
by 0.10.0 or earlier; installing 0.11.0 first moves them into the engine. Uninstalling removes
device-only records; preserve them before changing installation. When both sides hold training,
choose Add to transfer signed-out records.

Spoken TalkBack acceptance is unverified. Routines tab labels clip at 320dp with 200% text; see
[the design consistency ledger](../../docs/design/consistency.md).
