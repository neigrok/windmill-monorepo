# Windmill Android

A Kotlin/Compose app for gym: workout entry, routines, history and Coach. It shares the Windmill
account and backend. There is no subscription surface.

## Layout

| Module | Responsibility |
|---|---|
| `:platform` | Bearer HTTP transport, the agent turn's transport (`platform/agent/TurnHttp.kt`), account/session storage, sign-in, tokens and product-neutral shell. |
| `:gym` | Android training runtime, device storage, presentation models (`works.windmill.gym.presentation`, the screens' projection of `:gym:domain`), network/notification adapters and Compose UI. |
| `:app` | Composition root; one auth store, gym runtime, training store and notification adapters shared by activity, receivers and the Quick Settings service. |
| `:sync-core` | JVM JSON/JCS, registry descriptors, clocks, joins, identities, fractional order and digests. |
| `:sync-api` | JVM product values, Replica port, transaction readers and typed commit failures; depends only on sync-core. |
| `:sync-schema` | Generated JVM gym and journal registries and composition. |
| `:sync-engine` | Android memory/SQLite engine, writer slices, observations, HTTP/live transport, recovery, subscriptions and lifecycle sessions; bounded injected telemetry. |
| `:sync-model-server` | JVM reference model with probe, gym and journal bindings, admission, replay and live events. |
| `:sync-testing` | JVM strict client/server corpus, stepped memory engine, simulated network, mandatory properties, replay fuzz and layering. |
| `:domain-kit` | JVM values, readers, plans, drafts, action runner, ordering, refusal subjects, and what an ability is: catalog, seats and schema check. |
| `:domain-kit-testing` | JVM strict kit corpus, checks and layering. |
| `:agent` | JVM product-neutral agent turn: the driver, its host and transport ports, and the turn wire (frames, event stream, refusals). `:gym` hosts its Coach turn on it. |
| `:gym:domain` | JVM gym actions (`works.windmill.gym.domain.sync`), training reads, progress, units and rules, including signed-out workout recovery (saved-copy checks, stranded-set placement, separate-restore steps); every shared gym domain vector. `gym/store/WorkoutImports.kt` keeps the saved-workout journal's I/O and state machine. |

The JVM sync and kit modules and the Android engine library contain the SyncAPI, client runtime, model
server and kit. The full build enforces corpus coverage, properties, replay fuzz, schema freshness and
strict layering; see [coverage, gates and remaining work](SYNC_FOUNDATION.md). The app composes
that runtime for gym, with signed-out workout imports and account decisions.

Products depend on `:platform`, never on each other. See [repository structure](../../STRUCTURE.md).
Screens read colour from `MaterialTheme.colorScheme` and the room's own `MaterialTheme.gymColors`, and type from
`MaterialTheme.typography`, the brand's `WindmillType` and the room's `GymType` (`gym/ui/GymMaterial.kt`,
`gym/ui/GymType.kt`, `platform/design/Tokens.kt`); `ThemeRolesTests` keeps type sizes and hex colours out of screens.
Dynamic colour is off: the brand palette is fixed.
The app is portrait-only. Shared gym rules live in
[backend architecture](../../backend/products/gym/ARCHITECTURE.md), UI rules in
[brand foundations](../../docs/design/brand-foundations.md) and the Gym Figma file, and Coach's turn, wire and picture rules in
[Gym Coach on the client](../../docs/foundation/mobile/gym_coach.md).

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
- On Robolectric `waitUntil` only sleeps on the main thread, so its condition goes through `runOnIdle` or the semantics tree,
  which idle the main looper. `WaitsRunTheLooperTests` holds the rule.
- Release builds use R8 and resource shrinking; debug stays unminified. `:app:verifyReleaseMapping`
  gates release assembly on the R8 mapping, listed throwable names and bundled library rules.
  Each release APK carries a deterministic ProGuard UUID in `assets/sentry-debug-meta.properties`.
- The app's lint reads `:platform`, `:gym` and `:sync-engine` with it, so an unused resource in any
  of them fails the build.
- Sync foundation checks read the shared registries and corpora directly; the schema generator and
  independent JCS oracle checks also require Python 3 and Node.js.
- `-Pwindmill.apiBase=http://10.0.2.2:8088` targets the host's local backend from an emulator.
  Empty means the production host; any other value must be an http(s) URL, or the app stops at launch.

The placeholder Sentry DSN above is for local build validation. Release assembly requires
`ANDROID_SENTRY_DSN`, or `-Pwindmill.sentryDsn`, for the dedicated Android project. Debug telemetry
is disabled unless `-Pwindmill.debugTelemetry=true` is supplied. Error reporting, event delivery,
privacy and collector tests are described in [Android observability](../../docs/ANDROID_OBSERVABILITY.md).

## Account and device storage

Sign-in uses an emailed six-digit code (`door:"app"`, `POST /v1/auth/verify-code`). The same field
accepts a pasted magic link or `token=` parameter. Other entries are codes; malformed codes are
refused locally. There are no app links.

`SessionStore` seals the credential and verified user together through `SecretVault` (AES-GCM,
Android Keystore). Account and engine credentials share one vault. Installation access uses the
same Keystore key through its own vault; its installation boundary owns failure reporting. Each vault
loads its Keystore key once, and again after a failed seal or open. It keeps the last eight secrets
it opened or sealed in memory, never a failure. A sealed value that a write removes, replaces or
fails to store leaves that memory; the vault lists the last 32 such values and never keeps them
again, not even for a read already in flight. Restoring an unchanged account, or saving the engine
credential already stored, seals and writes nothing. Backup is disabled by both manifest and
extraction rules; a Keystore failure has no plaintext fallback. An older build's plaintext session
is used only after it is sealed and persisted. If migration fails, it stays unused on the phone
for a later launch to recover; reads do not retry the failed migration during that process.
Offline restore retains a previously bound account as unverified. Only a confirmed 401 expires
identity. Sign-out stores the exact account, Keep/Discard choice and engine completion phase in a
sealed intent. Startup resolves that intent before ordinary auth restore, credential bootstrap or
sync workers, and finishes an unreadable choice as Keep; a finished engine transition retries only the original account’s credential cleanup.
Verified sign-in proposals have a separate sealed credential. The current account changes only
after the engine accepts the decision; cancelling a proposal keeps the previous account and work.

Account deletion has a separate sealed operation record, read before ordinary auth restore and
sync startup. An unknown result keeps the exact account, proof and request instant fenced until
session-independent result recovery proves closure, or until the operation is proven to have changed
nothing: a refusal for this phone's date and time (409 `clock-ahead`, or 404 `unavailable` for a send
that left at least 90 seconds inside the five minutes after its stamp by the monotonic clock), or an
unavailable receipt followed by the identical close, still accepted by its session, answering 404.
Either clears the record and lifts the fence without a restart. Known closure persists cleanup owed before
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
joining another open workout; once the account confirms that start, a proposal Coach made on it is
minted again under its own id against the plan the account holds, then its sets follow under their own
identities and the server assigns their set numbers. A finished workout's proposal has nothing left to
apply and does not follow it. A planned start waits for the
account pull and refuses a changed frozen routine plan. Conflicting workouts remain inspectable on
the phone, with an explicit **Keep** action that imports them finished at their last set.
An unexpected failure preparing one item is reported once and keeps its source locally for retry;
other items adopt normally. Reconciliation retries that item after the account pull. A failure outside
an individual item retains the anonymous replica while sign-in selects the account; sign-out returns
to that replica so a later adoption pass can retry its work.
Dismissing a notice does not remove workout content. Refused imports retain their source on the
phone. Gym settings shows the reason and offers explicit correction and retry; dates, sets and
frozen routine lineage are never silently changed.

## Training runtime

`gym/store/` holds one feature store per screen family, each constructor-injected with the shared
`TrainingSeat` (whose replica is in hand, whether this phone may write it, and the one guarded read):
`WorkoutSession` (the workout in hand: rack, sets, movement walk, finish, and corrections to a set or
workout already on the log), `HistoryReads` (log pages and foot, opened details, record, routine
history, progress), `RoutinesStore` (routines, movement catalogue, proposals), `RecoveryStore`
(imports and On this phone), `DeletionsStore` (withheld deletes and their Undo), `BodyweightStore`,
`NotesStore` and `SharingStore` (connected log and share links). `HeldDeletes` holds the weigh-in holds and
the room's settled set deletes: weigh-in lists read the first and set lists the second. `TrainingStore` composes them with `CoachChats` and moves them together on a
change of account, an engine refresh, a restore and an account transition. Screens take a narrow
state interface and an events interface, bound to the stores by a `…Binding` class beside each
screen; previews draw each screen's main states in Dark and Daylight. The stores run training reads
and writes through `EngineTraining` and `:gym:domain`; a write commits to the selected replica at
once and the engine delivers it. Bulk history, session, record and progress reads use an injected background dispatcher;
Compose state and writes remain on the main dispatcher. Parsed history is shared per replica and
engine revision, including device-journal changes, and expires at the next session auto-close
boundary. A superseded read cannot publish into a different seat. Movement records and progress share one guarded read.
An opened workout deleted elsewhere leaves its page and says “That workout is no longer on the log.” Pending status shown by the
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
key. Each pushed visit has its own identity, and its saved state leaves with it. Pushes and pops
travel along the shared X axis and tab changes fade through, 300 ms with
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
The bundled movement catalogue uses backend seed identities. Only shares and connected-log credentials use REST,
through `GymRest`.
`coach/turn/` is the phone Coach: `CoachTurns` (one per application, handed out by
`TrainingStore.coachTurns`) admits a question, records it and runs the turn through `:agent`'s driver;
`GymTurnHost` runs each step under the seat the turn opened with, through `EngineTraining.pinnedOn`, which keeps
`writable`'s one rule and holds to the replica and to whether it is anonymous, so a turn reads and writes nothing
during a transition, under a sign-in's open decision, or under the seat that replaced its own: it waits out what can
still be cancelled, and a change of the active replica or a rebind abandons it. The record takes the streamed text
every 5 s, at each batch, when the app stops and at the end, and the room draws `CoachTurns.liveAnswer` meanwhile. `PictureFiles`
keeps a turn's originals and model copies in `noBackupFilesDir/coach-pictures`, with one metadata row per picture on
the replica; the engine stays in `filesDir`, and neither rides a backup or a device transfer. `TurnLease` holds an
expedited WorkManager job for the length of a turn on API 31 and above. WorkManager starts on demand
(`TurnLeaseHost`, the application's `Configuration.Provider`), `gym/src/main/AndroidManifest.xml` removes its startup
initializer, its foreground service and the permissions it asks for beyond what a job on JobScheduler uses, and a job the system restarts in a
new process finds no turn and ends. The ability catalog is the contract's own `gym/catalog.json`, copied into `:gym`'s
generated assets by a Gradle task and parsed at the first send.

`coach/` groups conversation models, storage, photos and screens. A conversation is the engine's `thread` and
`message` records, on both seats. While a screen of Coach stands in a started app (its tab, a pushed chat, the sheet over
the workout, History), `CoachConversations` reads them off the main thread through the seat's guarded read, again on each
revision of the engine: the chat on screen, every thread's title, and History's rows only while History is up, from what
each row says of a message alone. What Coach read's details wait for its sheet: each time it opens it asks `CoachConversations.withDetails` for one read off the
main thread. A turn running with no such screen keeps its words and asks for no read. `CoachExchange` and `CoachReply` are what a screen draws of them. `CoachChats` holds what the
composer needs for the seat in hand and starts turns; `TrainingStore` composes it with the seat's account.
`LocalCoach` atomically retains what is no engine record: the chats (the composer's identity before a turn opens a
thread, then the thread it opened, and the reader's place), composer drafts, kept drafts and draft photos, under owner
epochs that reject a late write after an account's cleanup. It also retains the onboarding answers earlier versions
stored, readable and with their drafts saveable through `CoachRoutineImports` on the replica they were had on. It drops
the conversations, requests and confirmations earlier versions kept at first load, keeping every draft, and removes the
photos only they named; their conversations stay on the server and on the web, and History starts empty.
A send goes through `CoachTurns` on both seats and its draft stays until the turn is recorded: a refusal keeps it, and a
turn withdrawn before its stream returns the question and its photo to the field. Stop asks the driver. Nothing resumes
per chat, since `CoachTurns` owns the one running turn and it survives every screen. A repeated finish share opens one
turn: its key and its turn commit in one transaction in a `rack:` device row (`OpenTurnOnce`), so a death before the chat
holds its thread finds the first turn again. A deliberate Coach entry or New chat creates a fresh identity; History,
sheets and recreation restore the selected identity. A running turn stays in its own chat while other chats remain
available. Signed-out conversations join the account through the engine's signed-out decision, so no transcript moves
by hand; a signed-out draft moves into the account's chat. An available anonymous installation can ask; bound or
unavailable installations keep History and drafts without an anonymous composer. A routine Coach creates lands at once,
with its card. Ordinary messages use native chat bubbles and Nunito typography; a long press opens the message's Copy
action. Finished http(s) links open in a Custom Tab, and Copy answer keeps their URLs. Long press also offers Copy link
when the full answer has exactly one distinct link. Markdown tables keep structured cells and tab-joined copy. The reveal
stays mounted from the empty pending message through its terminal answer; Stop exposes all received text. Material3
decorates the existing state input, so selection and draft ownership remain in one place.
After successful owned routine and workout reads, an empty Gym initially opens Coach when Coach can
answer: signed in, or signed out while this phone's anonymous access is available. Otherwise it opens
Routines; an account waits for its first pull. Saved or deliberately chosen navigation wins. Setup chats retain two local
greeting bubbles until their first accepted message, with the native photo picker and new-routine
editor doors. Ordinary fresh chats keep the empty composer.
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

`CoachTurnsLiveWireTests` runs turns on both seats and lost opens over the real routes, on a fresh database and a
fresh account. Start the vendor, `python3 tools/fake_coach_vendor.py <port>`, whose output names each model round.
Start the backend with `AI_ALLOWANCES_ENABLED=true`, `AI_INSTALLATIONS_ENABLED=true`,
`AI_INSTALLATION_PROXY_MODE=direct`, an `AI_INSTALLATION_IP_HMAC_KEY` of at least 32 bytes, `AI_ALLOWANCE_ALERT_EMAIL`
naming one of `WINDMILL_OWNER_EMAILS`, any `RESEND_API_KEY`, `RESEND_FROM` and `ANTHROPIC_API_KEY`, and
`COACH_ANTHROPIC_BASE_URL` at that port. `WM_WIRE_BASE` must be a loopback host, and `WM_WIRE_EVIDENCE` is the
folder that takes the test's stores and pictures. Without `WM_ANDROID_TURN_WIRE_TEST=1` it skips:

```sh
WM_ANDROID_TURN_WIRE_TEST=1 WM_WIRE_BASE=http://127.0.0.1:8096 \
  WM_WIRE_BEARER="$WM_LOCAL_BEARER" WM_WIRE_EVIDENCE="$PWD/build/turn-wire" \
  ./gradlew :gym:testDebugUnitTest --tests '*CoachTurnsLiveWireTests' --max-workers=4
```

No test covers: a real vendor round; an NFC or collation case on an old device, since the JVM that runs the corpus and
the device hold different Unicode tables; a turn routed across server processes, since production runs one; whether
the expedited job's quota holds in real use on Android 12 and later.

The other live-wire suite requires a fresh local account credential and a single-use magic-link token
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

## Localization

English is the only language. Copy a person reads is a string resource in the module that reads it:
`gym/src/main/res/values/strings_<area>.xml`, one file per area (the welcome carousel keeps `onboarding.xml`),
`platform/src/main/res/values/strings.xml` and `app/src/main/res/values/strings.xml`. Names carry their module and
area, `gym_<area>_<thing>`, `platform_<thing>` and `app_<thing>`, so merged resources cannot collide; the carousel's
are `onboarding_<thing>`. Manifest labels point at resources too.

- A composable reads `stringResource(R.string.x, …)`; code outside composition reads `context.getString(…)`.
- A count reads `pluralString(R.plurals.x, count, …)` from `platform/i18n/AppLanguage.kt`, never
  `pluralStringResource` or `getQuantityString`: Android picks a plural's category by the system's first language
  even when the app does not ship it, so a Russian phone would read "21 set".
- Placeholders are positional `%1$s`, given a value its own formatter already rendered. `%d` and `%f` format in the
  system's locale and print Arabic-Indic digits on an Arabic phone.
- A sentence is one message: a value fills a placeholder, never a fragment beside it.
- User content, server text, test tags, telemetry names and log lines stay in Kotlin.
- `CopyInResourcesTests` (`:app`) fails on copy written in Kotlin under the source roots it lists and on a literal
  manifest label; the app's lint fails on an unused resource.

A second language ships as its `values-<language>/` folders, one more entry in `AppLanguage`'s `shipped` list, and
`generateLocaleConfig` and `localeFilters` in the app's build, all in one change. Neither build setting comes earlier:
`localeFilters` drops the libraries' own translations, such as Material's date picker, and `generateLocaleConfig`
adds the app to the system's per-app language setting.

## Writing Kotlin here

- Every bound is UTF-8 bytes. `jcs` returns a `String`, so measure `encodeToByteArray()`, never `length`.
- `CancellationException` extends `IllegalStateException`, so a broad catch rethrows it, or a teardown files a failure
  that did not happen.
- `WindmillJson` leaves `encodeDefaults` off, so a field equal to its declared default leaves the body. A wire type
  declares no default on a field the server requires.
- Whatever takes a clock reads only that clock. Robolectric cannot see a read of the ambient clock behind an injected
  one, and CI's slower machines can.

## CI and releases

Recipe, once the commit is on `main` (`V` the version, `SHA` the commit):

1. `git tag android-vV SHA && git push origin android-vV`. CI tests, assembles and uploads
   `windmill-V-signing-input-run-<run id>-<attempt>`: the candidate APK, its SHA-256 and provenance, the mapping.
2. `gh run watch <run id> --exit-status`, then `gh run download <run id> -n <artifact> -D signing-input`.
3. `security find-generic-password -s works.windmill.android.release-signing -a windmill-android -w | python3 tools/release.py finalize --candidate signing-input/windmill-V-signing-input.apk --provenance signing-input/windmill-V-signing-input.apk.provenance.json --mapping signing-input/windmill-V-mapping.txt --keystore ~/.local/share/windmill/signing/android-release.p12 --out final --build-tools "$ANDROID_HOME/build-tools/36.0.0" --expected-event push --expected-ref refs/tags/android-vV --expected-version V --expected-commit SHA --expected-workflow-commit SHA --expected-run-id <run id> --expected-run-number <run number> --expected-run-attempt <attempt>`.
   The `--expected-*` values come from the run, not from the artifact's own provenance.
4. `sentry-cli upload-proguard --uuid <apk.proguardUuid of final/windmill-V.apk.provenance.json> final/windmill-V-mapping.txt`.
5. Acceptance on `Release_API34`: the eight steps below.
6. `gh release create android-vV final/windmill-V.apk final/windmill-V.apk.sha256 final/windmill-V.apk.provenance.json --title "Android V" --notes-file <notes>`, then record the release below.

[Android CI](../../.github/workflows/android.yml) builds/tests relevant main pushes and pull
requests. An `android-v*` tag or versioned dispatch also produces unpublished signing inputs:
a non-debuggable, minified APK, SHA-256, R8 mapping and schema 3 source/run provenance. The temporary signature is not the
release identity. CI has read-only repository permissions and no private signing key.
`versionCode` is the workflow run number and must exceed every previously published version code.

Release signing is local, on the owner's Mac, and the key never enters the repository or CI: the
repository is public, and a sideload signing key cannot be rotated without ending in-place updates for
every installed copy, so a compromised CI must not be able to produce a validly signed APK. The retained
PKCS12 key is `~/.local/share/windmill/signing/android-release.p12` (alias `windmill-android`), with a
copy under `~/Library/Application Support/Windmill/Backups/` and a custody record beside the key naming
both. Its password is the macOS Keychain item with service `works.windmill.android.release-signing` and
account `windmill-android`, piped into the helper's stdin as step 3 shows; it is never written to a file
or a command line. `release-signing.json` pins the public certificate. `tools/release.py finalize` checks independently
verified commit/ref/version/workflow/run identities, receives the password through stdin, verifies
the input, signs and checks the certificate and unchanged application contents. Pass
`--mapping signing-input/windmill-<version>-mapping.txt` alongside `--candidate`, `--provenance`
and the independently verified `--expected-*` arguments. The mapping filename and digest must
match provenance before the helper reads the password. The final output retains the mapping and
its digest, and `apk.proguardUuid` binds the Sentry identifier to the inspected APK. Its APK, digest
and provenance remain unpublished until native acceptance and a same-key update check pass.

After finalization and before acceptance, the release agent uploads only the finalized mapping
whose SHA-256 matches `mapping.sha256` in the finalized provenance. With the Android project
selected through local `SENTRY_ORG` and `SENTRY_PROJECT` and a locally available Sentry token, run:

```sh
sentry-cli upload-proguard --uuid <apk.proguardUuid> <final-output>/windmill-<version>-mapping.txt
```

Check the installed CLI command first with `sentry-cli upload-proguard --help`. Sentry CLI
[supports the UUID override](https://github.com/getsentry/sentry-cli/blob/master/src/commands/proguard/upload.rs);
newer versions mark it deprecated. Confirm that the Android project’s Debug Files page lists the
exact UUID. If no local token is available, record the upload and Debug Files check as pending in
that release’s notes. The mapping goes only to Sentry; never attach it to a GitHub release. CI has
no Sentry upload token, and builds and the release helper perform no mapping upload. Do not force
a production Issue: the release Robolectric envelope test and Debug Files listing provide proof.

Minified acceptance runs after review on a freshly wiped `Release_API34` Google APIs emulator,
using the retained-key candidate with a version code above 309:

1. Check non-debuggable badging with `aapt2`, the asset UUID against provenance, and record APK
   sizes before and after minification in the release notes.
2. Install published 0.16.0/code 309. Signed out, create a finished two-set workout, an open
   workout with a logged set, a bodyweight routine with negative per-set loads, a note and a
   weigh-in. Update with `adb install -r`; preserve all data and finish the open workout. Check
   the AOSP keyboard’s minus key for uniform and per-set loads.
3. Check that `adb logcat -b crash` stays empty and logcat contains no `SerializationException`,
   `ClassNotFoundException`, `NoSuchMethodError`, `NoSuchFieldException`,
   `Resources$NotFoundException`, `Crash reporting unavailable` or `Error delivery unavailable`.
4. Exercise process death with HOME followed by `adb shell am kill works.windmill.app`. Restore
   a routine draft with Vary by set open, logger Assembly/Picker/Fix sheets, a pushed navigation
   frame, session detail and Finish sheet.
5. In airplane mode, log a set, force-stop, restart offline and finish offline.
6. Request sign-in and reach the check-email state using the owner-designated address. If the
   owner signs in, verify session restoration after force-stop, sync pull, a streaming Coach
   answer and sign-out. Record any signed-in checks not run.
7. Independently verify that a clean install opens the welcome carousel and, after Skip, the Coach tab
   with an empty Routines tab. On an emulator with TalkBack,
   also verify heading navigation reaches Movements, History and Performed.
8. Across devices, on one account: a conversation started on iOS reads on Android and the reverse, a running turn
   shows as answering on the other device, and a seat change interrupts it. The web stays on its own conversations
   and shows neither phone's.

The published [0.16.0/code309 release](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.16.0)
uses tag `android-v0.16.0` at `b634b633504f2d0baef5fefd944487c9479bfeb0`,
[Actions run 42484808380](https://github.com/neigrok/windmill-monorepo/actions/runs/42484808380),
attempt 1, from a tag push. Both jobs passed. Local finalization verified the retained certificate,
non-debuggable package, unchanged application contents and linked provenance. All three anonymously
downloaded assets are byte-identical to the accepted files. The APK SHA-256 is
`abcd3652a74e840c7c202aa9637bc6bb35096fad6b6fe61d133b16584af2217a`, at 8,091,020 bytes (the unsigned CI
candidate is 8,073,833 bytes). The release workflow supplies
`-Pwindmill.updateUrl=https://github.com/neigrok/windmill-monorepo/releases/latest`; the APK contains that
destination, which resolves to this release. The R8 mapping, bound to the APK by `apk.proguardUuid`
`2be7ac5f-e208-3acb-9550-b6cfc08892fb`, is not yet uploaded to Sentry: the release machine has no Sentry CLI
or token, so the upload and the Debug Files check are pending.

Android 14 acceptance ran on a freshly wiped API 34 Google APIs emulator with 4 GB of RAM against the
production configuration, signed out, on the release-signed APK. The public 0.15.0/code299 APK's routine and
live workout with one logged set survived `adb install -r` in place; on 0.16.0 a second set logged, Fix set
opened with its bottom **Save fix**, and the saved fix showed in the ledger. The crash buffer stayed empty and
none of the listed exceptions appeared in logcat. Not run on the release-signed APK: step 2's finished
workout, bodyweight routine, note, weigh-in and minus key, 4 (process death), 5 (offline), 6 (sign-in and
anything behind it), 7 (clean install and TalkBack) and 8 (cross-device).

Distribution is by sideload. Published APKs through 0.7.1 use different debug certificates and
cannot update in place with the retained release key. This build reads no device records written
by 0.10.0 or earlier; installing 0.11.0 first moves them into the engine. Uninstalling removes
device-only records; preserve them before changing installation. When both sides hold training,
choose Add to transfer signed-out records.

A spoken TalkBack pass (TalkBack 16, API 37 emulator, 2026-11-01) covered Routines, the routine editor
and its movement sheet, the rack, Finish, signed-out Coach, and a signed-in Coach answer on the capture
rig's local stack. Each element was touched through the emulator's own touchscreen (`adb emu event
mouse`), which TalkBack's touch exploration treats as a finger; adb's `input tap` bypasses touch
exploration, and `uiautomator dump` suspends TalkBack while it reads the screen. With TalkBack's log
level at verbose, logcat records every utterance (`SpeechControllerImpl: Speaking fragment`) and the
text-to-speech engine's word ranges for it. An emulator has no audio check, so the speech is verified
from that log, not by ear. Heard: steppers say their value, *Edit box* and their label once (*3, Edit
box, Sets*); outlined fields say their name once; the editor's discard question is announced as it opens; the routine sheet's
*A workout is already open. Finish it first.* is announced as it appears; *Read 12 workouts · 5 weeks*
is a button. Still said twice: a rack set row (its description, then its drawn set and target), the
editor's movement row (the drag handle's *Move Bench Press, 1 of 1*, then the name), and Finish's
facts read each value apart from its label.
