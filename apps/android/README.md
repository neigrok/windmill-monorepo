# Windmill Android

A Kotlin/Compose app for gym: workout entry, routines, history and Coach. It shares the Windmill
account and backend. There is no subscription surface.

## Layout

| Module | Responsibility |
|---|---|
| `:platform` | Bearer HTTP transport, account/session storage, sign-in, tokens and product-neutral shell. |
| `:gym` | Android training runtime, device storage, presentation models, network/notification adapters and Compose UI. |
| `:app` | Composition root; one auth store, gym runtime, training store and notification adapters shared by activity, receivers and the Quick Settings service. |
| `:sync-core` | JVM JSON/JCS, registry descriptors, clocks, joins, identities, fractional order and digests. |
| `:sync-api` | JVM product values, Replica port, transaction readers and typed commit failures; depends only on sync-core. |
| `:sync-schema` | Generated JVM gym and journal registries and composition. |
| `:sync-engine` | Android memory/SQLite engine, writer slices, observations, HTTP/live transport, recovery, subscriptions and lifecycle sessions; bounded injected telemetry. |
| `:sync-model-server` | JVM reference model with probe, gym and journal bindings, admission, replay and live events. |
| `:sync-testing` | JVM strict client/server corpus, stepped memory engine, simulated network, mandatory properties, replay fuzz and layering. |
| `:domain-kit` | JVM values, readers, plans, drafts, action runner, ordering and refusal subjects. |
| `:domain-kit-testing` | JVM strict kit corpus, checks and layering. |
| `:gym:domain` | JVM gym actions, training reads, progress, units and rules; every shared gym domain vector but `recovery-actions.json`, pending until saved-workout recovery leaves the store. |

The eight JVM modules and Android engine library contain the SyncAPI, client runtime, model server
and kit. The full build enforces corpus coverage, properties, replay fuzz, schema freshness and
strict layering; see [coverage, gates and remaining work](SYNC_FOUNDATION.md). The app composes
that runtime for gym, with signed-out workout imports and account decisions.

Products depend on `:platform`, never on each other. See [repository structure](../../STRUCTURE.md).
The app is portrait-only. Shared gym rules live in
[backend architecture](../../backend/products/gym/ARCHITECTURE.md), UI rules in
[brand foundations](../../docs/design/brand-foundations.md) and the Gym Figma file, and Coach's retry/stream/image rules in
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
Android Keystore). Account and engine credentials share one vault. Installation access uses the
same Keystore key through its own vault; its installation boundary owns failure reporting. Each vault
loads its Keystore key once, and again after a failed seal or open. It keeps the last eight secrets
it opened or sealed in memory, never a failure. A sealed value that a write removes, replaces or
fails to store leaves that memory; the vault lists the last 32 such values and never keeps them
again, not even for a read already in flight. Restoring an unchanged account, or saving the engine
credential already stored, seals and writes nothing. Backup is disabled by both manifest and
extraction rules; a Keystore failure has no plaintext fallback.
Offline restore retains a previously bound account as unverified. Only a confirmed 401 expires
identity. Sign-out stores the exact account, Keep/Discard choice and engine completion phase in a
sealed intent. Startup resolves that intent before ordinary auth restore, credential bootstrap or
sync workers, and finishes an unreadable choice as Keep; a finished engine transition retries only the original account’s credential cleanup.
Verified sign-in proposals have a separate sealed credential. The current account changes only
after the engine accepts the decision; cancelling a proposal keeps the previous account and work.

Account deletion has a separate sealed operation record, read before ordinary auth restore and
sync startup. An unknown result keeps the exact account, proof and request instant fenced until
session-independent result recovery proves closure. Known closure persists cleanup owed before
Discard, removes the original replica, owner workout controls and Coach archive/photos, and clears
only the captured credentials. Decryption or storage ambiguity fails closed. Coach owner epochs
reject late writes after cleanup, including after a fresh verified sign-in restores the same account
during its grace period. The anonymous installation identity and binding are retained.

The application owns one SQLite engine and runtime, with separate anonymous, bound and dormant
account replicas. Android subscribes only to gym; signed-out work never pushes. An empty account
accepts signed-out training automatically. When both sides hold training, sign-in presents pinned
**Add** / **Discard** counts, including refused imports retained on this phone. Work changed while
the choice is open requires a fresh decision. Sign-out asks before ending the account. Unconfirmed
changes offer **Keep** in the dormant account replica or **Discard** from this phone; **Cancel**
restores the current account’s writable standing. The held question survives UI recreation, and
local writes and ordinary sync activity remain fenced until the choice resolves.

Before numbering each nonempty outgoing batch, the runtime makes a fresh authenticated hello and
requires the server's `schema` to meet the client's registry `minVersion`. An unknown or older
server leaves ready work unchanged and retries with exponential jitter and a one-second minimum;
commit, foreground and leave wakeups do not bypass that floor. Cached schema metadata is for reads,
not delivery authorization. Idle, held-only and dependency-blocked queues make no delivery hello.
This adds one handshake per push batch. Reads remain available while the server is older; the
server's own `426 upgrade-required` still stops an older client normally.

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
delivers it. Bulk history, session and progress reads use an injected background dispatcher;
Compose state and writes remain on the main dispatcher. Parsed history is shared per replica and
engine revision, including device-journal changes, and expires at the next session auto-close
boundary. A superseded read cannot publish into a different seat. Pending status shown by the
workout uses a published read plus unconfirmed local set values, without storage reads during
recomposition. A refusal by the log's rules is said on screen and is not reported as a failure.
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
start, complete saved set and finish are acknowledged in order. The original source, values and
time survive; concurrent changes leave the source available for another retry. Settings Retry
schedules reconciliation before reporting completion. Sets carry no kind: every logged set counts
toward training totals and history.
The native **Workout** Quick Settings tile uses the notification snapshot. Its subtitle advances
only while the shade listens; reopening restores the current workout and latest-set clock. An
inactive tap opens Routines without starting anything. An active tap rechecks the owner and workout
before opening it. Routines requests clear read-only pushed navigation and preserve open drafts;
each request is consumed once, including across activity recreation.

`GymNavigator` keeps the tab and the pushed stack across recreation, and `Standing` decides what
Back means. `GymStage` moves the room's frame and keeps each frame's saved state under the frame's
key: pushes and pops travel along the shared X axis and tab changes fade through, 300 ms with
emphasized easing. A back gesture shrinks a pushed screen, the logger or the routine editor toward
90 % over the frame its release returns to. A Back that lands during a release cannot stop the pop
it committed to; it waits for the stage to settle and then acts on where the room stands. A busy
`BackHandler` swallows the gesture. A `BackGuard` vetoes the preview and asks instead of leaving;
only the standing frame's guard counts. The routine editor registers one: on a draft holding unsaved
work, Back, the gesture and its back arrow ask *Discard routine changes?*, a clean draft leaves at
once, and a save in flight swallows Back.
`KeepOnBack` lets a screen keep typed entry before Back leaves it; the logger's rack registers one.
Every sheet is a `WindmillSheet`, which previews Back from its own window and finishes a close it
has begun even when another Back arrives. With Remove animations on, all of these cut.

The rack and Fix set keep native number input separate from committed values. IME Done and explicit
Log set / Save fix validate the current buffer. Leaving a field commits a valid typed value the way
Done does, and an invalid one keeps its refusal and the committed value; Cancel restores the
committed value. The logger owns the rack's entry, so Hide, Finish, Back and a move to another
movement commit a valid typed value first.
`NumberEntry` owns signed/comma parsing and performed-set bounds, while `NumberStepper` owns the
stable editor, accessibility actions and accepted-change feedback. Planned target fields retain
separate domain rules. Focused number editing owns horizontal drag so it cannot page movements.

The routine movement form edits Name, Equipment and Targets together. Add/Done stages the outer
routine draft; only its Save writes the existing `SaveRoutinePlan`. Drafts retain opening movement
metadata, raw legacy equipment/count, rest intervals and stable creation identities. The store owns
an admitted save through caller disposal; the room checks its owner, identity revision, replica and
save attempt before closing the editor. A signed Regular load moves its unit below when the inline
content would clip, retaining the chosen text size, side controls and native horizontal editing.

App workouts start from a saved routine. Workouts received from another surface without a routine
retain their movement picker and read as **Free workout**. Receipts do not create routines.
The bundled movement catalogue uses backend seed identities. Only Coach
threads, attachments, shares and connected-log credentials use REST, through `GymRest`.
`coach/` groups conversation models, storage, photos and screens. `CoachStore` owns chat selection,
thread reads, retries, streaming and confirmed conversation deletion in the application scope;
`TrainingStore` composes it with the current account and routine refresh. `LocalCoach` atomically
retains stable chat identities, selected chat, drafts, prepared photos, turns, request identities,
confirmations and scroll position. An upload cancellation retires automatic resume and keeps its
draft for explicit Retry. Request callbacks and Stop replies remain bound to their admitted attempt,
including a retry with the same request identity. A deliberate Coach entry or New chat creates a fresh identity;
History, sheets and recreation restore the selected identity. A pending reply stays in its originating
chat while other chats remain available. Retry retains identity and Stop preserves completed work.
Signed-out History reads only the stable anonymous owner's local archive and calls no server History
endpoint. Signed-in archives remain retained and become visible only to that same authenticated owner;
account and anonymous archives are never silently copied or merged. Read-only receipts use What Coach
read; replies containing proposals, writes, routine drafts/results or unknown tools retain their
existing receipt/control presentation and wording. Ordinary messages use native chat bubbles and
Nunito typography; a long press opens the message's Copy action. Markdown tables keep structured
cells and plain-text copy. The reveal stays mounted from the empty pending message through its
terminal answer; Stop exposes all received text. Material3 decorates the existing state input, so
selection and draft ownership remain in one place. An available anonymous installation can ask in its original local chat. Bound or unavailable
installations retain History and drafts without an anonymous composer; submitted work can recover
by GET. Typed account-required replies use the fixed Sign in state. Daily caps retain the composer
and persist the server retry deadline; expiration never sends automatically.
After successful owned routine and workout reads, an empty Gym initially opens Coach when Coach can
answer: signed in, or signed out while this phone's anonymous access is available. Otherwise it opens
Routines; an account waits for its first pull. Saved or deliberately chosen navigation wins. Setup chats retain two local
greeting bubbles until their first accepted message, with the native photo picker and new-routine
editor doors. Ordinary fresh chats keep the empty composer.
Every ask declares `routineReview`, and new Coach routines
remain drafts until **Save routine**. Review shows movements, targets, equipment and whether loads are total, per
dumbbell or added bodyweight load. A save runs in the store's scope, so leaving Coach does not cancel it; a draft the
server no longer holds or cannot write loses its Save. Confirmation receipts survive relaunch under their account,
retries retain the same server operation, and a draft reads as saved when the thread or this phone's receipt says so.
Equipment metadata resolves through the current catalogue for history and training receipts; set volume
counts one or two dumbbells while estimates keep the entered weight unit. Shared HTTP framing lives in `net/GymHttp.kt`.
`sharing/` owns public workout links and their card; sharing a workout does not involve a Coach conversation.

Notes live with the account. They retain an unread state until the account's first pull
completes; subsequent pulls refresh the open notebook, and refused saves show their refusal.

Applying a routine removal saves its proposal snapshot and command identity together in the
account replica's device journal. Retry and reopening use that same command. Its explicit server
result survives interrupted waits, timeouts and relaunch; the receipt stays durable until its review
footer is visible while the app is resumed. Routines keeps an unshown removal review reachable
after the routine disappears. Refusals retain their engine notice; dismissing it clears the refused
journal entry. Receipt acknowledgment failures keep the receipt available and report
`gym.proposal_receipt_shown`; successful presentation emits `gym_proposal_receipt_shown` with
`outcome=applied`.

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

The [design capture rig](tools/DESIGN_CAPTURE.md) builds against an isolated local stack, captures
current native board states in both appearances on an API 36+ Pixel emulator, and checks cold
startup with a private debug readiness probe. It preserves the APK, screenshots, manifest and an
open-workout CPU trace. Its recipes grow alongside the Android board tasks.

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

The published [0.12.1/code184 release](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.12.1)
uses tag `android-v0.12.1` at `ddb82fb86d9307ac59e7082ce21c4deecf39ed29`,
[Actions run 39076676004](https://github.com/neigrok/windmill-monorepo/actions/runs/39076676004),
attempt 1, from a tag push. Both jobs passed. Local finalization verified the retained certificate,
non-debuggable package, unchanged application contents and linked provenance. All three anonymously
downloaded assets are byte-identical to the accepted files. The APK SHA-256 is
`89c12c59745d9ef941136ce8ec37a21fcbd1e17c4350cbb60a1d4cd1e294f2f2`.
The release workflow supplies `-Pwindmill.updateUrl=https://github.com/neigrok/windmill-monorepo/releases/latest`;
the APK contains that destination, which resolves to this release.

Android 14 acceptance ran on the `Pixel_API34_Root` emulator against the production configuration,
signed out, without TLS interception, a proxy or an added CA, after earlier builds were uninstalled.
The public 0.12.0/code168 APK's finished two-set workout and live one-set workout survived
`adb install -r`. The live workout accepted a second 25 kg × 5 set, then a third 30 kg × 5 set in
airplane mode; all three survived force-stop/restart offline and finished at 375 kg beside the
original workout in the Log. An independent clean install opened the empty Routines screen.

Account and telemetry checks used debug-key builds against a local backend. A signed-in upgrade from
0.12.0's source kept the account and the live workout; restore, sync, Finish and sign-out passed, and
sign-out left no stored account or sync credential. Against a local Sentry collector, a server
outage in the foreground and lost network in the background filed no error and arrived as
`sync_engine` events with `failure_kind=unreachable`; two outages of failing pulls filed one error
each, tagged `http` and `500`. Signed-in acceptance was not repeated on the published-key APK.

Distribution is by sideload. Published APKs through 0.7.1 use different debug certificates and
cannot update in place with the retained release key. This build reads no device records written
by 0.10.0 or earlier; installing 0.11.0 first moves them into the engine. Uninstalling removes
device-only records; preserve them before changing installation. When both sides hold training,
choose Add to transfer signed-out records.

Spoken TalkBack acceptance is unverified.
