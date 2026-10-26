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
`/tmp/windmill-android-capture-quiet-final2`; both preserve their APK and manifest. Ticking notification recipes use the bounded SystemUI chronometer settlement described below;
app logger clocks still need their own layout/body condition. Later visual tasks add their own approved board recipes; these captures do not claim
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


## Task 15 — notification clocks

The pure workout snapshot carries the latest visible set timestamp across movements, falling back
to workout start before the first set. The selected movement still controls its counter. The native
private card, public lock-screen card and promoted Live Update use that same timestamp. Deletion,
correction and cold restore preserve the domain clock rules. One notification action handler owns
routing, unlock refusal, failure reporting and once-only action telemetry.

The silent DEFAULT channel migration preserves an explicit legacy block and existing new-channel
settings. Both transitions are verified through actual API 37 upgrades: enabled legacy LOW becomes
silent DEFAULT, and blocked NONE remains blocked. A user's subsequent enable persists. The private
card shows workout facts and one action; the secure public card shows only the title and clock
with Android private-notification hiding enabled (`lock_screen_allow_private_notifications=0`).
Public-version rendering follows the user’s lock-screen settings; other privacy settings were not
exhaustively tested. The API 37 system renders its launcher icon and tint on the stock card, while its promoted chip
uses the requested exercise icon and clock. Ledger 11l records this platform-controlled difference
from the illustrative Figma card; no custom notification layout is introduced.

Debug and Release each pass 34 focused notification, domain and runtime checks with no skips,
failures or errors, and both app variants compile. The complete Android tools suite passes 31 tests,
including local mail/auth, partial-prefix fixture pushes, native touch helpers, trace flushing and
narrow clock settlement. The source integrates main's task 27 and task 08 tooling. Evidence is in
`/private/tmp/windmill-android-task15`, with focused XML archives, per-class counts and tool logs.

The frozen native APK has SHA-256
`4ffb82f251ecd58b1f032dbe134e5048baf1860742b5c3dfe539f02516df568c`, built from `2d57ca53` plus
reviewed task 15 source. `final-captures4` contains all six canonical 04.2/04.3/04.4 Dark/Daylight
PNG, raw XML and notification-dump sets, a completed manifest and a runtime scan with no ANR or
fatal exception. These captures use the same APK as the accepted `shade-pilot` action, clock and
migration evidence; the later base integration is covered by the focused compile/test gate.

The action acceptance intake contains exactly one successful notification `log_set`, one successful
`open`, and two logged-set events. Backend readback retains the two sets on different movements,
and the notification clock keeps the later set time when returning to the first movement. The
pilot records one transient `hello` transport result as `unreachable`; the canonical capture run
records two. Their cause is unproven. Subsequent sync succeeds, and the pilot's backend readback
confirms both sets. These bounded transport metrics are neither domain refusals nor Sentry Issues.
The native runtime scans contain no ANR or fatal exception. This evidence verifies first-party
intake and boundary behavior, not hosted analytics receipt.

Notification recipes build a host-owned shell hierarchy helper because the stock UI dumper waits
for an idle period that a ticking chronometer does not provide. The helper has a bounded root wait;
comparison ignores only the exact SystemUI Chronometer's text and description while preserving raw
XML. Body text, unrelated numbers and bounds must settle. A chip requires visual inspection because
the active Home accessibility root does not expose it. Unlock steps wait for the actual lock/PIN
and Home states. All owned emulator, backend and fixture database processes clean up normally.
Failed capture attempts remain beside the accepted packet and are not counted as acceptance.

The profile reader waits for nonempty complete bytes to remain unchanged across two reads, with a
bounded failure for empty or partial output. The retained task 01 trace is 396,857 bytes and spans
10,287.783 ms, with 405.205 ms main-thread CPU in its parsed summary at
`/private/tmp/windmill-android-batch/task01-native`. This hardens artifact collection without changing
the recorded cold-ready measurements. Task 15 makes no new performance claim.

## Task 04 — shared native controls

Reusable FABs, error buttons, menus, a trailing delete swipe and controlled number entry compose
native Material behavior with the approved 00.4 anatomy. Number entry keeps text, rules and writes
with the consumer; explicit changed/unchanged/refused results govern feedback and IME completion.
Signed load input requests signed and decimal Android flags. Existing screen consumers and their
bidirectional swipe behavior remain in their numbered migration tasks. The approved O addendum
measures signed Display text at the actual font scale, puts the unit below on overflow and uses
the full control width when the 32sp floor needs it. The editor stays in the same composition slot
as the field and button positions change; focused expansion preserves selection and contracts only
on blur. Full gym Debug passes 1,196 checks with 17 opt-in live-wire skips (1,213 total); all
33 focused Release and 32 capture-tool checks pass. Native-font tests cover 372/280dp controls,
100/200% text, focused selection preservation and unchanged raw invalid input at the 32sp floor.

The API 37 packet `/private/tmp/windmill-android-native-parts-overflow` retains 22 planned
Dark/Daylight PNG/XML pairs, 12 caret-end captures, six pressed/menu/swipe captures and two native
keyboard/Done captures. APK SHA-256 is
`d4cc305f024a14e5cd43efaf17a4578c2d57f512d16a749262dffc2ed48885e3`. The whole `-12.5`,
`-102.5` and `-499.99` remains visible at rest and either caret end; editing `24` to `-499.99`
expands at phone/320dp widths and 200% text. The signed decimal input connection is `0x3002`;
actual Gboard Done hides the keyboard and blurs the field. Raw hardware Enter does not exercise
that IME action. Size/density/text-scale overrides restore before the runner exits successfully.

Native paragraph metrics grow the fitting `24` field to 146.67dp despite the requested 88/92sp
style. Side-field heights are 184.38dp for `-12.5`, 164.95dp for `-102.5`, and 156.19dp for
`-499.99`; narrow fields start at 156.19dp and the 200% full-width field is 185.14dp. These are
minimum-height fields, so native text remains unclipped. Exact bounds are retained in
`geometry.json`. No performance claim is made from this component run.

The intake contains allowlisted lifecycle/auth/screen labels and no typed values, units, names or
emails; component callbacks emit no product event. All 152 structured backend observations are
successful. Two bounded unreachable hello outcomes are non-fault sync events; no corresponding
Sentry Issue is expected. Five SDK session envelopes arrived during the capture interval with no
exception event. Both runtime scans contain no app ANR or fatal exception. This verifies the local
intake and SDK transport, not hosted receipt. Harness-only menu/IME corrections remain in the
private evidence packet and do not change product behavior.

The shared parts introduce no domain state or persistence. The extended FAB composes the native
FAB container with the approved 16 dp icon/label padding; Material 3's packaged extended overload
fixes its text-side padding at 20 dp. A native editable field and Material field container keep the
value/unit baseline and whole-width refusal independent of screen validation policy. The simplification
pass retains one editor subtree for all responsive layouts, groups native controls in one file and
removes duplicate pointer/prefix helpers already supplied by task 08.


## Task 16 — Workout Quick Settings tile

The native tile shares the notification snapshot and approved exercise glyph. An inactive tap
opens Routines; an active tap rechecks the current account and workout before opening it. The
standard TileService listening interval owns its snapshot collector and one-second subtitle clock.
Closing Quick Settings cancels that work; reopening and service recreation restore current facts.
No active-mode metadata, persistent background ticker or ineffective `requestListeningState` call
is used. API 34+ opens the explicit target through an immutable PendingIntent. The same target's
component setting and PackageManager resolution are checked before launch.

Routines navigation consumes each request once, clears read-only pushed screens, and retains open
routine, note and inline edit drafts. Default no-op draft-presence callbacks expose only whether a
pushed edit is open. Tile launches alone close the shell's You/sign-in presentation. Deterministic
checks cover Log/Coach/Settings return, cold launch, consumed requests through recreation, retained
routine and historical-set drafts, stale accounts, cancellation and unavailable targets.

The focused checks pass: 39 gym tests and 47 app tests per Debug/Release variant, with the final
13 tile-service cases repeated in both variants after target-resolution hardening. Integration onto
main `29193611` preserves task 04's specimen, viewport and immediate-capture hooks, task 27's mail
and auth hooks, and task 08's fixture/touch helpers. The integrated 16 tile/navigation tests pass,
both app variants compile, and the complete lightweight tools suite passes 36 tests. XML and logs
are retained under `/private/tmp/windmill-android-task16`.

The frozen native APK has SHA-256
`2fe9b0d47071482a3ffca68fb04ab49fe62d682738c23cddda4af96dbfb099dd`, built from task 15's accepted
`126bfeb7` tree plus task 16 source. `final3` retains all four inactive/active Dark/Daylight 04.1
captures, raw accessibility state descriptions and SystemUI dumps. Standard system tint and geometry
are accepted against the illustrative approved boards. The later task 04 integration is covered by
the compile/test gate; these unconsumed components do not change the tile's native presentation.

The native clock uses workout start before its first set, advances from the new set afterward,
and survives killing the app process while the tile is listening. The retained sequential recipe
writes the before-first-set capture before tapping Log set. PNG modification times are host clock
values; workout/set instants originate on the emulator. Those clocks were not offset-calibrated,
and the evidence makes no direct timing comparison between them. ActivityManager records the
service recreation from PID 9391 to 10061. The restored tile opens the workout; Finish returns it
to Off. Backend readback confirms all three explicit app workouts, each with one set and a finish.
A signed-out cold tile tap opens empty Routines and starts nothing. The canonical recipe produces
two successful Routines actions and four successful workout actions. Supplemental checks bring the
intake to four Routines successes, six workout successes and one intentional target failure.
The failure yields exactly one bounded `client_error` and one local Sentry `gym.tile` envelope;
its exception has no value, and user/request/message/breadcrumb fields are absent. The envelope and
sanitized privacy check are in `final3/1793031635823371000.envelope` and
`final3/sentry-privacy-check.json`. This verifies local collection, not hosted vendor receipt.

The host-only hierarchy helper now retains accessibility state descriptions, where SystemUI puts
the tile subtitle. Settlement ignores only the clock suffix of the identified Workout tile; title,
other tiles, geometry and raw XML stay intact. Taps require stable bounds for their visible control,
so a sheet's opening animation cannot redirect a tap. Quick Settings expansion checks actual panel
state and retries its system command at most three times. Two repeated signed-out expansions pass.
The supplemental signed-out check needed one selector retry from a partial shade; the preserved
summary records that limitation. Canonical captures completed without failure, and earlier failed
attempts remain separate. The native runtime scan contains no ANR or fatal exception. All owned
backend, emulator, database and private fixture files clean up normally. Task 16 makes no new
performance claim.

## Task 05 · resource-specific deletion

The implementation is based on main `266c78ab`. Routine, set and note actions use the application
store's job scope and release only their own engine receipts. A typed recoverable subset keeps
weight/workout/conversation recovery separate. Weight receipt projections follow engine offers;
ProcessLifecycleOwner distinguishes activity recreation from actual backgrounding. Admission guards
pin the connected replica and anonymous status inside transactions, including import correction.

The merged Debug gate passed 1,222 gym cases, with 17 opt-in LiveWire skips, all three application
cases and six telemetry cases. The final projection checks pass 84 cases, the band checks three,
and the focused Release checks 13. The gym gate includes ten durable-weight/cancellation/account
cases; the application gate uses actual activity recreation and process backgrounding. Rewrite
success/failure, expiry/release ordering, restart, account/adoption isolation and disposed-row
cancellation are deterministic tests. XML is in `/private/tmp/android-task05-test-archives`.

Ten Dark/Daylight images verify the routine menu, editor and detail-set swipe grounds, settled
routine deletion and weight Undo. Eight unchanged surface images use candidate APK `fb35d03f`;
the two final band images and final lifecycle/write/failure checks use `7f3b8c4e`. Exact hashes and
per-image provenance are in `/private/tmp/windmill-android-task05/final-band`. The band uses the
approved 16 dp horizontal margin, native 14/20 message/action type and 12/16 monospace note line.
Its one-line weight Undo form differs intentionally from the general two-line specimen. Later
03/17 chrome/FAB, 18 editor geometry and 23 Session copy are outside this bounded comparison.

Native checks confirm two held/Undo pairs, one immediate set delete and one immediate note delete.
Background/resume takes 4.63 seconds from the request, before its nine-second expiry: no Undo or
held engine receipt remains and backend readback has five weights. Readback also retains all three
routines after the controlled failure, one note and no sets in the newly finished session. Intake
records exactly one set success, one note success, one routine failure, three weight holds, two Undo
successes and one weight closure. The earlier routine-swipe recipes record two routine successes.
The local storage trigger is removed after verification. Its single failed commit yields one failed
product event and two correlated existing boundary receipts: `gym.dropRoutine` / `CommitFailure`
and `sync_storage` / `store-failure`, 16 ms apart. Both Sentry envelopes omit content and exception
values. This verifies local intake/collection, not hosted vendor delivery.

The final automated runtime scan is clean. Supplemental manual logging retains one attributed
uiautomator shell collision (PID 7340, 21:33:15) with no application stack or ANR. Failed selector
attempts and the attempted native recreation check are not acceptance evidence. The acceptance
pause was extended only while the runner slept; this task makes no performance claim. All owned
emulator/backend/mail/model processes and the disposable database clean up normally.

Structural observation: keeping receipt ownership in the application store prevents row disposal from
cancelling durable user actions. Exact receipt release also avoids settling an unrelated weight hold.
Shared engine/application reporting can issue two correlated technical receipts for one storage
failure; deduplicating those existing boundaries is a separate follow-up.

## Task 03 — room chrome

Root, pushed and workout screens share M3 `TopAppBar`; `GymChrome` groups their approved typography
with the navigation label style. The account target is present on all roots, including signed-in
Coach. The visible middle destination is *The log*, while its event label stays `log`. The logger
has no settings action; its trailing target is reserved for task 45. Coach action content and its
existing History/More paths are unchanged.

All 35 focused chrome/account/navigation checks and 62 related screen checks pass in Debug,
with zero skips. The account regression verifies the complete existing screen-event sequence
through each root and no technical failure. Twelve installed API 37 captures verify the six chrome roles in Dark and Daylight. Task 03 ships
with task 17's routine FAB so the creation route remains available. All 11 OnboardingFlowTests pass
with the accessible FAB selector in the combined 03/17 gate, as do the tile/draft/recreation checks.
The shared bar adds no state or write boundary.


Task 03 native evidence is in `/private/tmp/windmill-android-room-chrome-native`, with APK SHA-256
`d4c542a3dcb0433d831e5f3ade271ebdecdc049588dd87b9a261b0bf4f92b8af`. Each root's account target
measures 126 × 126 pixels at density 420 (48 dp). Root account routes return correctly, the editor's
unchanged Save remains disabled, and both workout runs retain one 30 kg × 8 set. All routine
revisions remain 1. Intake records exactly two starts, two logged sets and two finishes, no routine
save, and only allowlisted metadata. All 117 structured write observations succeed. Runtime scans
contain no app ANR or fatal exception; the local collector receives SDK session envelopes and no
exception event in the capture window. This verifies local delivery, not hosted vendor receipt.

The five stable chrome recipes use ordinary hierarchy settlement. The archived private runner
captures the ticking logger only after its controls appear, skipping exact whole-tree settlement
for that screenshot. It stops intentionally at a pre-profile barrier; no new performance claim is
made. Existing body layout, task 45's Hide control and the paired task 17 FAB remain outside this
chrome proof. The simplification pass removes the custom-row bar branch, its switch and the
logger settings callback while grouping shared type styles beside the bar.

## Task 17 · Routines FAB and empty state

The Routines screen uses the shared 56 dp native FAB with a fixed New routine accessibility label,
16 dp margins and 88 dp list clearance. Content has a 16 dp horizontal inset; routine rows use
12 dp leading / 0 trailing padding, 8 dp icon and 2 dp copy gaps, and Nunito 16/22 plus 13/18 type.
Rows retain their 68 dp minimum and grow with content. The empty title follows the approved
Nunito ExtraBold 24/32 scale and 8 dp content inset. The signed-out suggestion and unused account/sign-in arguments
are removed. The current proposal card, secondary chip and Review route remain unchanged by user
instruction; the illustrated waiting-row replacement is deferred. Immediate deletion stays on 05's
application-owned receipt path. The simplification pass removes the one-caller swipe wrapper.

The paired source is based on main `653d523f` and the held 03 chrome commit. The combined Debug
gate passes 1,225 gym cases with 17 opt-in LiveWire skips and all 48 application cases, including
11 onboarding cases. Tests exercise fixed FAB geometry and activation at text scales 1, 1.3, 2 and
3, the last routine menu above it at 320 dp/200% text, unchanged proposal review identity, and tile
navigation/draft restoration. Twelve focused checks pass after simplification, and all 19 final
row/swipe checks pass after the approved spacing/type corrections. All 36 Android tool tests pass.
XML archives are in `/private/tmp/windmill-android-task17/tests`.

Eight installed API 37 captures verify full/empty Dark and Daylight at standard size and 320 dp/200%
text. Every hierarchy exposes a 56 dp FAB and 48 dp account target; every recipe opens the editor
through the FAB. Native creation persists a fourth routine at revision 1 and emits one
`gym_routine_saved(action=create)`. The existing proposal Review opens its current sheet and stays
pending; all three original routine revisions remain 1. The account seat opens You and returns.
The shell has no separate You-open event; task 46 owns that explicit acceptance gap.

Final evidence is `/private/tmp/windmill-android-task17/native2`, APK SHA-256
`4419120c0d431303d6ccde76d64626833c7e4a3c9175f7ced5738f6cd05a1d7e`. Its manifest pins
all 34 Android source/recipe paths changed by 03/17. The local intake records nine editor views,
one proposal view and the single save, with bounded properties only. All 125 structured backend
write observations succeed. Automated and supplemental runtime scans contain no app ANR or fatal
exception; the local Sentry collector receives seven SDK session envelopes and no exception event.
This checks local delivery, not hosted vendor delivery. The incidental cold/profile sample is not
a performance claim; failed selector attempts are excluded from acceptance. The eight automated
captures are supplemented by `02.7-empty-dark-inset-repeat.png` for standard Dark anatomy: its
settled account bounds match Light/full. The original Dark capture is 58 px higher; its cause is
unproven because the original system-window state was not recorded. The large-text navigation
label clipping remains tracked by `android-gym-large-text-tab-label`. All owned capture processes
exit normally, their ports close, and the disposable database is removed.

The recipe keeps New routine as a content-description target; the shared locator already accepts
either text or content description. Deletion/tile recipes use the visible The log labels from 03.
No new capture API is needed. Keeping the fixed FAB outside the scroll content makes its reach
independent of the preserved proposal card's height; the list tail exposes the final row menu.
