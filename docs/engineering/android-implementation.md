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
Sets carry no kind (registry v12/minimum 11): no read, write or command argument names one.
Debug and Release real-wire suites each pass 17 cases with zero skips. A further
Debug run passes all 17 against the backend auth-receipt/schema prerequisite on main.

Native acceptance logs eight 60 kg × 8 sets across two routine movements. The receipt and backend
readback count all eight sets and 3,840 kg. Local recovery compatibility is covered by the unit and
wire suites.

The simplified rack has one acceptance path for every logged set. Recovery retains source documents
for retry. Wire summary fields retain their existing names;
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
The combined Name/Equipment/Targets form and retained picker return are recorded under task 18.

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
measures signed Display text at the actual font scale: the numeral first fits beside its unit from 88sp
down to 64sp and keeps the 88sp line height, then puts the unit below and uses the full control
width when the 32sp floor needs it. The editor stays in the same composition slot
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

## Task 07 — native number entry

The rack and Fix set use the shared native number field with separate raw and committed values.
One pure reader owns signed/comma parsing, refusal order, finite-number checks and
half-away hundredth rounding; performed reps remain 1–99. Planned-target rules stay separate.
Explicit Log set and Save fix validate the active buffer before a write. Leaving a field commits a
valid typed value as Done does; an invalid one keeps the committed value and its refusal. Cancel
restores the committed value. A new focus places the caret at the end, and later selection survives
layout expansion. Field accessibility actions share the same Increase/Decrease callback and
48 dp hit targets as the buttons. Only accepted step/IME changes flash and tick; Log set stays silent.

The simplification pass removes the custom keypad and its duplicate readouts, moves raw-buffer
lifecycle into one saveable draft, and shares accepted feedback between the native buttons and
ladder. Valid raw values determine both displayed ladder increments and applied steps; invalid
buffers refuse without mutation. Reps availability follows the raw reading, including edits away
from 1 or 99. A focused numeric editor owns horizontal drag; outside focus the movement pager
retains its existing behavior. Focus effects are cancelled on disposal, so restoration retains an
unfinished draft and an old owner's editor cannot rewrite new controls.

The integrated Debug gate passes 1,222 cases with 17 opt-in wire skips; 79 affected Release cases
pass. The later restoration, Finish, runtime and logger gate passes all 50 cases, including delayed
same-owner reads, account isolation and a failed/recovered controls file. After integrating 03/17,
those 50 cases pass again. All 38 tool checks and 11 NumberStepper cases pass, including bounded
paint and settled pixels across shorter/signed overflow transitions and reduced motion.
XML and build logs are retained under `/private/tmp/android07-number-entry-foundation`.

The logger's saveable state belongs to its account and workout in the room's existing state holder.
A temporary empty read during activity recreation hides the sheet without discarding its draft;
a successful Finish removes that workout's saved state. A failed numeric write retains the existing
recovery sentence after focus leaves. Automatic editor cleanup refuses an already-failed controls
file without creating another Issue. The numeral animation moves the existing editor layer inside
its clipped box; it has no duplicate text layer with a different width. The 150 ms slide/fade ends
before the 300 ms accent flash. Transient recipes record a bounded 180 ms frame delay; ordinary
screen readiness still uses semantic settlement.

API 37 native evidence is `/private/tmp/windmill-android-task07/final3`, source `e5ed4eb5` plus
this task, APK SHA-256 `94814fc17a9a88d25947c50a88a39547d736c8a6632fa35ad5873bf9c2e2721a`.
Six Dark/Daylight captures show pressed, changed and native-keyboard states. Native accessibility
Increase/Decrease actions adjust both fields and expose their units; spoken TalkBack is unverified.
Fix retains its invalid raw load, refusal and note across recreation, including 320 × 640 dp at
200% text. The value, supporting error and Save fix remain reachable above the keyboard by
scrolling. The correction persists once. Unchanged detailed native minus/decimal, reps-bound,
Cancel and rack large-text evidence remains in `pilot3` with its own APK provenance.

Two deliberate temporary-file write failures each deliver one sanitized `gym.editRack` Issue and
one `client_error`, with no automatic `gym.editWorkout` duplicate. Saved control bytes stay intact;
the visible instruction survives focus loss. A checkpointed recovery restores 85 kg, accepts
87.5 kg, logs the set and finishes. The final readback has five sets, one correction and four ended
sessions, with exactly five `gym_set_logged`, four start and four finish events. Two transient
hello/unreachable results recover; their cause is unproven. An earlier rapid recovery tap sequence
did not add a set and lacks intermediate state evidence; the bounded repeat establishes recovery.
No app ANR/fatal appears in the retained runtime log. A transient hierarchy command failed during
display changes, then succeeded; system Play/GMS warnings remain in the log. No performance or
hosted-vendor-delivery claim is made. The runner exits normally, owned ports close, and its
disposable database and private credential file are removed.

The shared NumberStepper accepts one decimal separator and rejects malformed insertions or pastes
as a whole. Replacing a selected separator keeps the new caret and composition; rejection keeps
the complete prior editor state. Sign, leading-separator and exponent buffers remain editable,
and deletion can repair a restored malformed buffer. Selection-only edits emit no draft callback
or haptic. The routine editor reuses the same edit grammar for uniform and per-set numeric fields,
retaining native selection and composition.

The independent main integration covers 1,298 gym Debug cases: 1,281 pass, 17 explicit live-wire
cases skip, and none fail or error. The debug app assembles. Native rack verification proves duplicate
dot/comma rejection, selected-separator replacement, caret preservation through the next digit and
the actual keyboard minus key. Its NumberStepper source is byte-identical to the integrated source;
the bounded proof is `/private/tmp/windmill-android-coach/native-supplement/proof.json`.
Malformed saved-buffer deletion is covered by deterministic editor tests rather than a native
saved-state injection. The input filter shares the existing commit parser and introduces no layout,
sign control or validation message.


## Task 26 · Notes and its editor

Notes uses the single approved honesty line, 20 dp gutter and shared card/swipe anatomy. The row
has 12 dp padding, 15/22 title and 13/18 preview type; its 68 dp minimum grows with content. Exact
24 dp drag/chevron assets come from the approved flow, with the handle's 48 dp interaction area.
The existing Add button remains. The editor uses 4 dp outlined Title/Note fields with 56/240 dp
minima, the pushed Note bar and the shared error text Delete button. Clean Save is disabled.
Signed-out Notes and Connected log remain task 51.

The simplification pass keeps gesture ownership in one local loop: the handle consumes Initial-pass
movement before the parent swipe can claim it. A pre-consumed cancellation never settles an order;
only a normal release calls the existing save, and finally always clears the optimistic projection.
No gesture abstraction or additional persistence layer is introduced. List failures restore the row
and show the existing refusal sentence inline; the editor stays open on deletion failure. The
application-owned settled delete, receipt release and technical reporting remain task 05's paths.

A typed note-delete origin selects notes or note_editor for the existing single result event. The
single store-owned save boundary emits gym_action with screen=note_editor, action=save and one of
ok/refused/failed. The telemetry policy permits only those finite combinations. Full assertions
cover success, refusal, failed commit and retry without content or identities. The final Debug gate
passes 51 gym cases and six telemetry cases, with zero failures/errors/skips. All 38 Android tool
tests pass. XML and logs are under /private/tmp/windmill-android-task26/tests.

Installed API 37 verification uses main a384dd25 plus task 26. Four canonical captures cover the
list swipe and outlined editor in Dark and Daylight. Native handle reorder emits one gym_note_moved
and readback confirms the new order. At 320×640 dp/200% text, Save remains visible above the real
keyboard and Delete is fully reachable by scrolling. The earlier source-verified visual APK is
2d4fbb2dde5a8251514593e45460b8f1e6eb90dcbcc32b0efdfc016d7f7f1d40. The final telemetry-only APK is
adb658008d084ed8f0c717615eda9eb46c7baf23ad72aac7fb94b5e84bd9b72f; only four boundary/test hashes
differ and every visual source hash is identical. One save with that final APK persists the exact
synthetic fields and emits one note_editor/save/ok. The editor-delete and list-delete checks emit
one result each with their correct origins; final server readback holds exactly one surviving note.
All 127 structured local backend observations succeed. Six local Sentry session envelopes arrive
with no exception event, and the app runtime scan contains no app ANR or fatal exception.

Evidence is /private/tmp/windmill-android-task26/native1. Failed manual input selectors are excluded:
the first helper truncated spaces, and a later fixed-length replacement retained a prefix; actual
readback confirms the displayed values were saved. A private app_process SQLite helper did not
produce a controlled storage refusal, so that native failure attempt is excluded. Deterministic
list/editor/save fault tests verify unchanged records, visible recovery, one boundary report and
one bounded result per attempt. Native failure delivery, spoken TalkBack, hosted vendor delivery
and performance are not claimed by this phase. The standard Dark captures retain the existing
58 px window-inset variation seen in task 17; no cause or product layout fix is claimed. Relative
Notes row/field geometry, colors and static assets are reviewed against canon. The owned runner
exits normally; emulator/backend/model ports close, the disposable database is removed and private
credentials are deleted.

## Native CI diagnostics

The workout recreation fixture controls both initial and reconnect reads explicitly. It asserts the
temporary empty state before releasing reads on the test-owned dispatcher; the exact case passes
in Debug and Release after Notes integration. Six telemetry policy cases also pass. Production
dispatchers and timeouts remain unchanged.

The iOS Domain job retains a bounded test-log tail and up to three fresh Domain crash stacks only
when its original test command fails. The collector excludes unrelated, stale, oversized and
symlink reports, and exports an allowlist of stack and symbolication fields. All 46 App Tools
checks pass with Xcode 27.1, including three collector privacy/bounds fixtures; workflow YAML and
whitespace checks pass. CI uses Xcode 26.3. Its signal-10 failure has no established cause or local
reproduction; the diagnostic upload does not change test execution or assert a repair.

The web persisted-restart fixture explicitly checks the composed source schema/minimum. Its
verification receipt covers61 cases with zero failures/skips. The Domain diagnostic artifact from CI 40659886037 contains
the bounded test log and no crash report; the signal-10 cause remains unresolved. The outstanding
iOS nightly bounce case passes locally on iPhone 17/iOS 26.5 with Xcode 27.1, one case with zero
skips/runtime warnings. Full nightly 40661042534 checks the CI toolchain separately.

Backend CI's probe, production and optional Coach readiness requests advertise a version high
enough for the registry minimum. Explicit older-client refusal checks remain intact. The three
deployment-workflow checks and YAML parsing pass; the admission regression compares all four
probe headers with the current registries. CI 40659885808 passes the five Postgres targets and
479 deployment-conformance cases before the obsolete readiness header refuses, so the workflow
repair changes neither server validation nor the held production cutoff.

Android's generated-schema composition check explicitly expects minimum 9. Its seven-case class
passes with zero failures/errors/skips. CI 40659886043 passed 1,599 of 1,600 sync-testing cases and
failed only this obsolete minimum-4 assertion; the long property run completed rather than timing
out. Deliberate older-client and probe fixtures retain their original versions.

## Task 09 — compact rack

The movement name wraps at 22 sp with the existing equipment glyph and opens the current management
sheet. The spoken position remains exact; decorative markers show at most seven positions and use
smaller endpoints when more positions continue. A single movement has no markers. Previous/Next
remain accessibility actions, without visible arrow buttons or a text pager.

The headerless ledger combines each load with its equipment unit and reps. It grows from one current
row to a maximum 144 dp viewport, preserves the current row as sets arrive, and scrolls older sets.
The main Add movement row is removed; the existing management sheet remains its route. The native
number buffers, signed keyboard, ladder bands, 48 dp controls and silent Log action stay intact.
Only the part of a snackbar that overlaps the ledger reserves scrolling space.

The simplification pass replaces separate landed/current/planned composables and three-column
measurement with one row renderer over pure presentation values. A movement request belongs to its
account/workout and its Compose effect. Programmatic page alignment never requests a new movement;
a delivered gesture-stop is consumed once after settlement. A delayed read from another account
cannot clear or report a later account's request.

Affected Debug and Release gates each pass 75 cases with zero skips/failures/errors; six platform
telemetry cases pass. Coverage includes completed/cancelled gestures, account switches during a held
read, exact event labels, transient overlap, native draft/Fix restoration, and a single long movement
at 320 × 640 dp with 200% text. The 39 capture-tool checks pass. The restoration fixture explicitly
queues both its initial reconnect and recreation reads, asserts unavailable state before release,
and keeps the exact restored note/refusal and single-save assertions on the owned test scheduler.
Nine additional large-text geometry cases pass after aligning their assertions with the full
inline load/unit/reps readout and the movement-name management route. Logs and XML are retained
under `/private/tmp/windmill-android-task09`. The six live equipment frames were verified Ready for dev.
API 37 evidence is `/private/tmp/windmill-android-workout-batch/candidate6`, APK SHA-256
`38bce9df52641dcb6532a3bdbfe065c8ae20f6e0f0af92af2a2f702d2965650f`. Twelve Dark/Daylight PNG/XML
pairs cover the three equipment modes, signed keyboard, ten-movement/long-name and single-movement
states. The focused field, unit and Log set remain reachable above the IME; the ledger can scroll
out of that compact viewport. Each appearance delivers four starts, four logged sets, four finishes,
two management opens and two completed movement switches. Canonical phase event windows contain no
client errors; the combined run’s later deliberate fault is reported under task 10. Setup/selector
failures remain in their manifests. The runtime scan has no ANR/fatal exception; no timing comparison
is claimed. Long default histories finish after their final generated set while valid short
histories retain forty minutes.

## Task 10 — Fix set fields and settled results

Fix set uses the same equipment-aware Display load and regular reps fields as the rack. The
equipment subtitle, 28 sp heading, filled exposed Effort menu, fixed Set note label and placeholder
follow the approved 03.3 boards. The note is a real native editor inside the M3 filled container;
it retains raw bytes and the existing spoken caption. Delete uses the shared M3 error action at
48 dp minimum, and Save remains at least 64 dp. Existing numeric buffers and cancellation remain
with the sheet draft.

The correction runs in the store's existing settled-job scope. The engine adapter checks replica
and anonymous ownership inside its locked action load, delegates validation to CorrectSet, and
returns the normalized accepted plan snapshot with its original set number. A post-commit owner
switch cannot cause a reread from another replica or relabel the saved correction as failed.
The result event is emitted once before guarded presentation refresh. A failed controls publication
reports gym.fixSet once and retains the existing recovery sentence; a fresh store recovers the
persisted correction. Expected validation, missing-row and owner refusals remain event-only.

The simplification pass keeps one result mapping across live and imported fixes, uses the existing
settled-job mechanism, and leaves pure validation in the domain action. The note composition stays
local to its one consumer; shared error-button sizing gains only an optional minimum height.
Affected Debug and Release gates each pass 101 cases with no failures/errors/skips. Tests include
actual Compose sheet replacement after the write, exact note restoration, native buffer refusal,
large-text/short-height reachability, equipment units and both error colors. The final ownership
adapter gate passes 36 cases in each variant and covers a pre-lock account switch, same-replica anonymous adoption and a
post-commit switch, including normalized returned values and exactly one event. Evidence is retained
under `/private/tmp/windmill-android-task10`. Six real SDK/intake telemetry checks pass. The final eight-case Debug and Release fault gate
adds a live observer, repeated delivery-shaped refresh, server sync and an unrelated note update;
only the original controls failure reports, the note refreshes, and a fresh store restores the fix.

Six API 37 Dark/Daylight captures are retained in the shared `candidate6` packet. A native signed
load is saved with the IME still open after scrolling to Save; the exact note and RPE are preserved,
with one successful event. Blur/cancellation preserve the prior set and emit no fix event. The
final packet is `/private/tmp/windmill-android-workout-batch/final1`, APK SHA-256
`33e1dca8cc80e5c13c514310287f8d96f3bce70a752f92455c0b351d3a5b0c8e`. It contains the controls guards
and exact task 11 glyph; the candidate’s Fix/rack presentation sources are unchanged. A temporary
directory blocks only the controls file’s atomic temp path: the corrected set persists, one
`workout/fix/ok` and one `gym.fixSet/FileNotFoundException` arrive, and the existing restart sentence
remains visible. No repeated refresh or sync-push errors occur during the six-second fault window.
One `hello/unreachable` metric has an unproven cause; the window is not network-clean. Removing the
fault and restarting restores the correction; a separate subsequent edit succeeds. The envelope
has no raw exception value, user, request, message or fixture note. The candidate’s earlier cascade
and all selector/setup failures remain separate evidence, not successful-action claims.

## Task 11 — This workout and preserved movement drafts

The management sheet uses the approved title, stock M3 ListItems, equipment-aware metadata and
20 dp handle artwork inside 48 dp touch targets. The shared end-to-start delete row owns the
Remove movement accessibility action; each row retains Move up/down. A refused removal restores
the row and shows its supporting sentence. The list reserves room for Add movement at short
heights and 200% text. Hide workout and Notification off remain task 45.

Handle gestures consume their pointer before the parent swipe. Reordering previews a local order
with a fixed viewport anchor; release saves once, while cancellation or ancestor consumption
restores the exact original order without a callback or event. Picker Cancel/Back returns to the
management sheet, and an accepted choice returns to the same workout. Edited movement racks use
the existing local controls file: only edited snapshots are saved, only matching movement/set-count
snapshots restore, and a new set clears its movement's snapshot. Owner/workout reset and old-file
empty-map decoding keep those values isolated. Raw numeric buffers remain in their existing UI keys.

The simplification pass removes the custom swipe ground, reuses the existing shared unit and
native row controls, and keeps preview state in the sheet with one release callback. The local
workout state owns the small edited-rack map; there is no new persistence or sync layer.
Affected Debug and Release gates each pass 107 cases with no failures/errors/skips. The final
nine-case gesture/accessibility/large-text geometry gate passes after the bounded-height change.
Tests cover actual movement switching, picker Cancel and recreation, disk relaunch, new-set
invalidation, owner/session isolation and legacy decoding. Six real SDK/intake telemetry checks
and all 42 lightweight Android tool tests pass after composing main’s optional-history support
with default-history duration and observed-row touch handling. Explicit history validation and
40-minute custom workouts remain intact. Evidence is under `/private/tmp/windmill-android-task11`.

The final API 37 APK (`33e1dca8cc80e5c13c514310287f8d96f3bce70a752f92455c0b351d3a5b0c8e`)
provides six accepted 03.4 captures: canonical, removal ground and 320 × 640 dp at 200% text,
each in Dark and Daylight. The exact approved handle path occupies 13.333 × 5 dp inside its
20 dp artwork slot; the routine builder’s separate asset is unchanged. Native picker Cancel,
switch-away/back and process relaunch retain edited loads for two movements. A released removal
and completed handle drag match stored controls and each produce one `ok` action receipt.
The held screenshot gesture is cancelled before the large-text capture; that image alone does
not claim a deletion. Deterministic tests cover cancelled/consumed handle gestures with no save
or event. Accessibility semantics and native hierarchy are verified, not spoken TalkBack.

`/private/tmp/windmill-android-workout-batch/final1/acceptance-summary.json` retains capture hashes,
phase event windows, readbacks and the original cleanup-selector failures. The successful native
actions are independently verified; those failed selectors are excluded from success claims.
The final runtime scan reports no ANR/fatal, and normal cleanup removes the disposable database,
private fixture file and owned emulator/listeners. There is no performance comparison claim.

## Task 37 · Coach archive, History and sources

The existing atomic Coach document retains owner-scoped local chat identities, selected chat,
text/photo drafts, turns, request identities, confirmations and scroll position. The application
scope owns requests and confirmed deletion. Fresh entry creates a new identity; History and
recreation restore the selected identity. Signed-out History reads only the stable anonymous
owner, with no server History call or silent archive adoption. Activity saved state carries no
Coach message tail.

Each admitted request has one runtime identity. Snapshot publication, Stop, pending retirement
and final cleanup check that attempt, including retries with the same request id. Its critical
section contains synchronous local mutations and retirement only. Cancelled uploads atomically
retain a Retry draft and retire automatic resume. Photo bytes and their draft reference publish
under the existing LocalCoach lock; deletion versions prevent late imports recreating a chat.
Cleanup keeps every photo referenced by a retained draft, request or exchange.

History combines cached server summaries and local chats, keeps the canonical first-question
headline and uses bounded raw answer previews after existing outcome wording. Older pages merge
by nonempty request, position or generation identity; distinct legacy turns remain distinct.
The oldest loaded cursor survives refresh and restart. Read-only facts use the approved sources
sheet. Typed writes, proposals, routine drafts/results and unknown tools retain their existing
receipt/control presentation and wording, including legacy proposal headers.

The combined schema-9 gym gate runs 1,320 cases: 1,303 pass and 17 opt-in LiveWire cases skip,
with zero failures or errors. Platform runs 134 cases and App runs 48, all passing. The final
History/Thread accessibility change passes 14 focused cases and assembles Debug; the capture
tools pass 46 cases. Controlled regressions cover queued account switches, origin-bound responses,
request restart, pagination replay/overlap/recreation, immutable headlines, Stop during a next
request and same-id Retry, queued snapshot/clear IO, cancelled upload restart, late photo
preparation/storage and two imported attachments before main publication. Storage faults retain
recoverable state and one reporting owner. The backend preview projection and its separate live
verification are recorded in [Coach history preview](coach-history-preview.md).

The History, sources, deletion, Copy and Jump recipes use `coach-history.json` with
`coach-history-fixture.json`: one
Push A workout, one set and 400 kg volume. The optional `setsPerMovement` history value
is an integer from 1 to 20; each explicit 40-minute workout has at most 20 total sets. Omitted
counts retain three sets per movement. Capture tooling
keeps the existing date, routine-index, finite-load and rep guards. The deletion recipe uses the
shared row-bounds touch target supplied by task 11.

Native API 37 acceptance covers paired History, sources and deletion layouts, local/server History
merge, exact text/photo restoration through navigation and restart, account archive isolation,
confirmed server-conversation deletion, and replies returning to their original chat after a new
chat is selected or the process restarts. The pending-state View chat action opens its origin.
An actual mixed get_session/list_notes/save_note answer retains the existing workout facts,
expanded receipt and Saved a note wording. Signed-out native acceptance verifies the current
access boundary hides account History and composer; anonymous admission remains task 38.

The local first-party intake receives the navigation and ask steps. A controlled native draft-write
fault retains the in-memory edit and previous durable draft, then recovers on the next edit and
restart. It produces exactly one content-free gym.saveDraft Issue at the local collector and one
matching client_error event. Hosted vendor delivery and release acceptance are not claimed.


## Coach batch integration observations

Tasks 37 and 28 are on main as `ba0360c0` and `fac7e530`. Root compared all 75 frozen source paths;
the sole composed difference is the additional verified NumberStepper paragraph already on main.
The integration gate passes 1,320 gym cases (1,303 pass and 17 opt-in LiveWire skip), 134 platform,
48 App and 46 tool cases, with zero failures/errors; Debug assembles. The tool gate uses disposable
loopback fixtures. Scoped Figma production prefixes preserve explicit exclusions for postponed
proposal/action visuals.

The acceptance packet attributes Sentry envelopes by Android SDK/release as well as time; a shared
collector can receive another backend's probes during native verification. Exact owned resources
are cleaned while evidence remains available. These checks add no production storage or telemetry
framework. Both coordinated distributions and their compatibility cutoff remain pending.

## Task 14 · Finish receipt and confirmed workout discard

The receipt derives duration, count, equipment-aware volume and performed rows from the committed
session snapshot. The three facts share one surface, and the receipt height includes its navigation
inset. Optional review supplies only its personal record. The independent scroll body
leaves the approved crowned Share and Done actions reachable, while native overflow opens the
shared Material workout confirmation. The first signed-out receipt carries its phone-local Keep
line; an empty workout uses the approved terminal over a title-only backdrop and Done returns to Routines.

Keep opens ordinary sign-in. Explicit Share retains one request identity in Activity saved state,
uses the product-neutral bounded sign-in attempt/result seam, waits for the account-data decision
and connected account, then opens its owner-scoped chat using the saved attempt identity. The exit
phase resumes after recreation. Replaying an older queued snapshot reopens that chat without a new
entry event or another submission of an admitted request. A completed sign-in result
retains its local user ID; both the final account and store seat must match it. Cancellation and superseding
sign-in attempts retire that queued intent. Local admission failure leaves the seeded draft and the
existing failure sentence; it does not schedule a send on a later unrelated sign-in. Another chat's
running request continues independently.

A restored receipt reads the current owner and replica locally before reconciling saved facts.
A released local tombstone or retained import’s discarded journal marker proves absence offline;
an account replica missing its first pull does not. Engine read revisions retry that lookup when local knowledge changes. Proven absence drops
both receipt and pushed detail and opens the root Log. Cached detail is never evidence that a
deleted workout still exists.

Confirmed discard runs in the application scope. A prompt-identity guard prevents a stale second
confirmation from starting another delete; an in-flight store job is shared for the same owner, opening replica, anonymous stance and
workout. A same-user replica replacement invalidates the old confirmation. Accepted deletion remains accepted if later local publication fails. The receipt/dialog
then closes onto The log. Expected refusal and unexpected failure retain separate outcomes and the
static `gym.discard` boundary. An actual local durable-write failure dismisses the
overlays onto the retained workout detail and its existing failure presentation. Discard requires
no network response; the guarded removal gateway releases its exact local receipt for later sync.
The existing engine keeps unpublished bound-workout intents in their causal order; deletion remains
absent after restart and delivery. A deleted anonymous workout is absent from account adoption. The network-error proposal is
withdrawn and is not a design prerequisite.

The readiness fixture observes engine revisions before connecting, matching application composition.
Its initial CI timeout cause remains unproven; the unchanged CI rerun and the complete root gym Debug
run are green. Focused source checks cover receipt geometry, the empty terminal, phone-marker
failure, cancellation and confirmed discard, the stable Share return through recreation, and the
separate Keep action. Additional lifecycle checks freeze old saved state through an Android Parcel,
restore a fresh engine/store after discard, cancel a Share exit before sign-in, replay completed and
pending admissions, recover a failed draft write and reject replacement owners. Focused source
verification passes 156 gym and 10 platform cases with zero failures, errors or skips; app Debug
compilation passes. Installed acceptance on source `be458a86` produces 14 paired captures with no
capture failures. Normal facts share one surface; enlarged text keeps actions pinned beneath a
scrollable body. Two saved Share exits survive recreation before sign-in and each admits one
matching chat/question after authentication and the account-data decision.

With the isolated backend paused, a published workout deletes locally, stays absent through a cold
restart and disappears from the server after delivery resumes. An unpublished create/finish/delete
also stays absent after restart. Its five ready intents drain in causal order and the final server
projection is absent; create/delete elision is not established.

The isolated intake receives 294 bounded events. Later isolated discard blocks each contain a
shown/accepted pair. Whole-run totals include an earlier obstruction/helper interval and do not
establish one opening per terminal result; exact-once discard remains covered by deterministic
prompt/job identity tests. Two paused-backend transport timeouts match local Android Sentry receipts
by SDK, release, fixed operation/route, failure kind and exact bounded duration. Privacy checks and
app-scoped runtime checks pass, with no product fatal error or ANR.

Native pre-acceptance SQLite failure remains unverified because the external helper never acquired
a lock. Deterministic tests cover retained detail/error and static reporting. Post-acceptance
publication failure is also tested at the gateway/store boundary only; a deduplicated no-op write
does not establish that fault. No native discard storage-failure Issue delivery is claimed. The
owned rig is stopped, its retired AVD removed and all acceptance evidence retained.

Regular numeric entry retains its 20 sp value and 16 sp unit bases at the chosen text scale.
The human-approved [02.25 unit-below layout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1661-33960)
is marked In production on the canonical Android page. It keeps a realistic signed load visible at narrow
width and enlarged text. Task 18 implements and verifies that exact focused Load scope; the older
full-width/buttons-below fallback remains unapproved.

## Shared load and Finish integration observations

The Android batch on main contains tasks 18, 22, 23, 24, 45, 51 and 52, with one commit per task.
The combined six-task gate uses evidence tree `004fc4c3373eaa16a93cbc9944d724d6edd48df4`;
Connected log has its separate 47-case and native gate below. Both Debug and Release gym
suites pass 1,412 cases with 17 opt-in LiveWire skips each; platform passes 140 cases and App
passes 48, with no failures/errors. Debug assembles. The native task packets name their exact
source, APK, backend and retained evidence; no native failure injection is inferred from unit tests.

The rebuilt backend includes main `9266c9e7` and finite loads. Nine targets pass against fresh
isolated databases: domain 2,316/2,344 with 28 deliberate skips, MCP 341/341, sync 765/765 and
adapters 1,365/1,365, with zero stopped cases or assertions. The epoch crash test needs a barrier
for the killed client's PostgreSQL session to disappear: a separate MVCC read can see the old row
while that backend still holds the transaction lock. The test-only barrier preserves the production
five-second timeout, one retry and exact rollback/one-update assertions; all nine epoch cases pass
on another fresh database. Both gates remove their databases. The rebuilt server's mounted-route
matrix also passes all four checks with vendor/onboarding switches enabled and all four disabled,
including the four turn routes, then removes its database.

Finite load formatting distinguishes the complete maximum exponent, unavailable volume and true
zero. Exact scores select the strongest estimate; record admission compares the final stated tenth,
so two estimates displayed as 116.7 do not create another estimate record. Independently earned
heaviest records remain valid. Five shared vectors cover ties, genuine improvement and the exact
prior best. Focused verification covers the Kotlin corpus and four Android review cases, Swift's
three training-read tests including 170 vector cases, and 761 web corpus cases plus strict types.

The iOS composition preserves bounded phone-result admission, counted/truncated reads, seat-change
stop, refusal reporting and ordering. Its volume fixture uses `RecordedRead.ids` with exact nullable
and zero assertions. Local Xcode 27.1 passes 23 focused Domain functions including 170 training-read,
54 Coach ability and 16 shape cases, plus 27 App Coach-turn runs and the individual unavailable-volume
source case. The explicit result-bound fixture compiles on supported Swift 6.2 without changing its
three-by-sixty input or assertions. The coalescer fixture feeds five deltas synchronously through
the existing MainActor driver, awaits its actual flush and checks exact final text/stopped state;
production's 250 ms interval is unchanged.

Supported Xcode 26.3 run `40789910187` passes all five jobs: packages/builds including Release,
App unit tests and all three UI shards with selected-test accounting. The normalization source
guard pins the exact existing `nfc` and `nfd` implementation with matching positive/negative fixtures
and current documentation; production normalization is unchanged. All 73 source fixtures and the
real-tree source check also pass locally. The local Swift 6.4 whole-world manifest-name findings
remain a qualification of that unsupported toolchain; the supported gate passes without a waiver.
Task 51 changes only Android and its documentation, leaving the supported run's iOS tree unchanged.

Task 14 is on main as `ee70d13c`, with ten canonical frames marked in production. Its separate
fixture repair uses the immediate Main dispatcher and pumps Main at controlled read/transport-entry
barriers, retaining ten-second bounds and exact one-close/two-question/distinct-chat assertions.
All 27 cases pass in each variant and remain green in the combined gate. The existing discard
sentence says `1 set`. The Target-summary overlap fix is human-postponed; proposal `1675:10931`
remains unapproved, and the known 320 dp / 200% overlap is outside this release's scope.

UI accounting requires each selected method to start and finish exactly once. Only the named
finite-load fixture probe may skip with its exact missing-fixture reason; requesting the fixture
forbids that skip. Native fault evidence remains limited to the boundary actually exercised.
No production injection hook or extra telemetry framework is added for acceptance.

Web promotion checks the live sync interval before mkdir or rsync and retains a complete pinned
source/schema/file-hash artifact first. The helper passes 33 script checks plus the final seven-case
web class, including rejection of symlinks before hashing. An actual local anonymous hello at
schema 10/minimum 10 admitted the matching client and held both mismatch directions, which
proves the local decision and the modeled workflow boundary. Current source is registry 12 /
minimum 11; production's hello advertised schema 11 / minimum 11 when last verified, on 2026-10-30.

The simplification pass keeps decimal normalization, exact estimate ordering, checked aggregates
and sender readiness at shared boundaries. Native receipt integration reuses text wrapping and
unavailable slots. Deployment admission and crash-fixture lifetime checks remain at their existing
boundaries, with no common framework introduced.

## Task 23 · Workout detail and complete comparison efforts

The detail body uses the approved compact head, equipment glyphs, movement spacing and grouped
Share/Discard actions. Discard uses the native error-text button and the room's single confirmation;
the existing application-owned deletion, retained-detail failure and immediate local acceptance
remain its boundary. Set swipe behavior and ground remain shared with task 05. Empty review output
adds no blank list item before the actions; a missing review still shows its existing failure line.

The Android read path is `EngineTraining.review` → the shared `SessionReview` over the replica,
which chooses the record, the previous routine workout and the top sets. The projection's grouped
effort counts every set of each side and carries minimum/maximum reps plus minimum load; the shared
top load and its reps remain the comparison predicate. The formatter draws both endpoints directly,
including negative assistance and mixed zero/load ranges, without subtracting extreme signed loads.
Only an all-zero effort omits its load. Bounds serialize with the existing review/receipt state;
legacy scalar JSON defaults to its single rep/load values. No shared wire or sync field changes.

The affected source gate passes 87 gym cases with zero failures, errors or skips and app Debug
compilation. Table-driven vectors cover mixed loads/reps, zero and assistance, previous work and
saved review/receipt round trips. Stored Cable/Kettlebell and Other equipment retain their load
semantics. Existing glyph assets are reused at the approved 20 dp header slot; both source PNGs
are nonempty 96 × 96 assets. The capture recipe targets the approved five-set, 2,455 kg example.
Paired Dark/Daylight detail, bottom actions and the five-set confirmation are accepted on frozen source `8d844b43`. The displayed total is 2,455 kg across five sets and three movements; all rows and actions are complete. The preserved first-party intake contains session views and discard shown/cancelled/ok steps. The recipe commits the 80 kg load through IME Done before changing reps, matching the number-entry contract that plain blur cancels an uncommitted edit.

The shared read still has a separate top-set representation: Kotlin
`gym/domain/…/sync/TrainingHistory.kt`'s local `best`, Swift
`apps/ios/Domain/Sources/GymDomain/TrainingHistory.swift`'s `best`, and backend
`backend/products/gym/domain/Review.cpp`'s `topSetOf` count sets at the top load.
`apps/ios/App/Sources/Gym/Workout/WorkoutReceipt.swift`'s `Effort.reading` renders the scalar tuple.
The shared `packages/api-contract/gym/domain/training-reads.json` corpus preserves that shape.
Those verified paths require a separately coordinated all-set/range contract update; this Android
detail change does not claim to correct them.

## Task 52 · Current rack in the onboarding gym picture

The gym example retains the Shell card, reading band, caption, pager and surrounding copy. Its
three headerless rows carry the set number, inline load basis and reps, with logged checks and an
accent current row. The existing workout/since-set glyphs supply the clock context. The load uses
the rack's Nunito treatment; reps and the full-width Log action keep the existing Shell positions.
The animation retains the press and lands its check in row 3. Reduced motion draws the completed
row immediately, including at zero platform animator scale. There is no separate saved line,
old set counter, column header, last-time line or single-movement position marker.

The implementation reuses the clock drawables and existing check painter. The four-picture Canvas
keeps the other three draw routines unchanged. Its pixel test helper is shared by the Journal
caret checks and the new gym checks, covering both gym skins, the wide action and the landing.
Twelve gym and eleven app onboarding checks pass with zero failures/errors/skips; the existing
first-launch, page-view and exit paths stay intact. Thirty-one capture-tool checks pass.

The A4 recipe uses an opt-in boolean launcher choice, isolated to one empty-account scenario in its
batch. Other fixture-account scenarios remain composable. It invokes
the real MAIN/LAUNCHER intent because the ordinary VIEW launch intentionally bypasses first-run
onboarding. The default rig launch stays VIEW, and no product flag or debug application hook is
added. The recipe follows the three Next actions and Get started. Paired A4 normal and reduced-motion/configuration-restored frames are accepted on `8d844b43`; page 4 and the enabled Get started action survive recreation. The four frame/XML pairs and their hashes are retained with the original APK. A named native `onboarding_page_viewed` receipt was not preserved after the failed recipe run dropped its fixture database. Generic intake 202 lines do not establish that event. The eleven app onboarding/event tests cover the unchanged pipeline; this picture adds no step or failure boundary. Ledger 9f records the obsolete table header still present in the Shell drawing.


## Task 45 · Hidden logger and independent notification visibility

The existing phone controls hold `loggerHidden` under their owner and session. The flag stays outside the engine-mirrored rack snapshot. Notification off keeps
its serialized `hidden` key and its existing invalidation semantics. Hiding the logger changes no
rack value, set offer, movement or synced training record. The visible logger determines Back,
rail ownership and keep-screen-on; the workout's existence still determines its lifecycle.

Hide and Back leave the originating tab selected. A single clickable WorkoutBar uses the existing
fitness glyph, clock formatter and typography above the rail only at tab roots. The same saveable
logger provider preserves the rack and raw field state across hidden disposal and restoration.
The management sheet groups Hide and Notification off · Show under Add movement. Show failures
return to the existing rack failure presentation and retain `gym.showWorkout` reporting.
Logger storage failures use static `gym.logger_visibility`. Both visibility doors validate the
current owner, session, replica authority and writable controls before touching the document.

A notification opening request retains its originating key and is consumed once after accepted
navigation. Restoring a room cannot reuse a consumed request to show a logger the lifter hid again;
a changed owner/workout cannot redirect the old request to a different workout. The scoped source
gate covers navigation, saved-state restoration, incomplete signed buffers, notification independence,
legacy-state decode, durable storage failures and stale authority. Paired normal management and hidden-workout frames are accepted; at 320 dp/200% text the movement list scrolls and Hide/Notification off/Show remain complete and reachable. On `8d844b43`, both appearances preserve four accepted sets, the originating Log/Coach tab, hidden configuration/cold restoration and a lone-minus buffer across Hide/Open while the stored rack stays 47.5 kg × 6. Actual SystemUI swipes turn off only the notification; Show reposts it, notification Open preserves owner/workout/replica and a consumed opening request does not replay after recreation.


The owner/session controls and runtime group passes 37 cases; the focused boundary repeat passes eight overlapping cases, including the visible unavailable Hide, with zero failures/errors/skips. Thirty-one capture parser checks pass. The durable-visibility regression confirms an engine fault is reported as `gym.workout_controls` during cold restoration while the accepted hidden flag remains true. Logger visibility is owned by Held, independently of the mirrored rack; the WorkoutState/sync schema is unchanged.

The bounded native packet separates visual/lifecycle source `8d844b43062a09b178a167fd6502d12df3bd005f` (APK `6d3ad11aade6c423f9ec7005a6e9c056072a45c2312112449a34a78fcf2d52c5`) from the policy-only proof on composed source `6e365786d006af224da8378f4b22c763d3c8b3c5` (APK `4bd6d92ea7cd2caabc21187e55b12b38242f4d00c7b0db310483e7752e54e6e0`). The update retains the debug signing certificate, owner and replica. The new-source zero-set mini-workout supplies exactly one Hide, workout-bar Open and notification Show receipt with only the eight common/step properties; the four-set lifecycle proof belongs to the original APK. Its new policy case passes six accepted and thirteen rejected label/content combinations; app Debug compilation and assembly pass.

The preserved intake has 290 events: 274 on the visual source and 16 on the policy source. Thirty metadata-only actions belong to the old policy; none belong to the new source. These are bounded totals including driver setup, correction and navigation, not one-to-one whole-run action accounting. The three new labels each arrive exactly once in their separate source/window proof. First-party storage does not prove vendor forwarding.

Retained post-reset runtime and app exit history contain no product fatal/ANR; the pre-reset boot log was not separately exported. Fifteen envelopes are attributed by Android SDK plus exact release, with no Issues; native `gym.logger_visibility` or `gym.showWorkout` failure arrival is not claimed. The API 37 notification shade initially suppresses all rows with `maxDisplayedNotifications=0`, including unrelated system notifications; its preserved precondition clears after a bounded OS cold restart, and its cause remains unproven. No product change is attributed to that reset. All owned emulator/services and retired AVDs are cleaned; collector 8100 remains untouched. Failed automatic recipe attempts are excluded from the accepted evidence; the native packet retains their qualifications separately.

The real Coach fixture follows Open routine → Start workout → Hide and retains Coach as the
selected tab. All five Room cases pass after removing the routine-start path’s forced Routines
selection. Routines-origin starts remain on their existing tab; no Coach card appearance changes.

## Task 18 · combined movement staging and one routine Save

The routine movement form edits Name, the plain three-category Equipment control and uniform or
per-set Targets in one route. Add/Done stages the complete value without a catalogue write; the
outer Save submits one `SaveRoutinePlan` with stable identities, opening/current routine and
metadata, rest and legacy raw counts. Store admission owns the save lifetime. Caller publication
pins owner, identity revision, replica and exact attempt, releasing only that attempt's busy state.
The same numeric edit grammar handles per-set selection/composition and duplicate separators.

The composed Android gate runs 1,429 gym cases in each of Debug and Release: 1,412 pass and 17
explicit opt-in LiveWire cases skip per variant, with zero failures/errors. Platform Debug passes
140 and App Debug 48; Debug assembles. The Android input tree is
`004fc4c3373eaa16a93cbc9944d724d6edd48df4`. Source composition retains the current Log, Bodyweight,
Finish, onboarding, hidden-workout and cap admission behavior. The shared engine/domain stress
suite is not a new claim of this task's allocated gate.

Native evidence uses the original 45-path freeze
`e734f850ea1d1b554157d0145a214ae0930cdda30a0b3d196eaa335725e5d794`, APK
`5f3a797dbcf37be65421b952a21dbd9c114be395cc1d39d005802c114020c972` and local schema-10 backend
`eee2ff237b8a8ab6056cd5337a7505fcf2d46a7b1b246ae7eed72f1a85b8d514`. Accepted partial Dark/Daylight
captures cover normal, per-set, keyboard and unsaved states. At 320dp/200%, focused `−12.5` and
valid `0` remain readable with identical bounds, the unit below, native minus and pinned Done.
Whole-buffer comma-decimal replacement and duplicate rejection are established; native partial
selection is not. The broader Target-summary layout remains unchanged and postponed.

A staged custom movement followed by outer Cancel retains the full SQL baseline. The remaining
Save-only proof retains all post-Save artifacts before assertions: all six SQL tables match the
baseline before Save, then one sync result commits two 501kg/8-rep targets, three explicit
0kg/10-rep targets, rest 90, metadata and the former-name alias. SQL and authenticated GET agree;
raw Dumbbells count is `NULL` and GET resolves 2. The untouched movement compares exactly.
Twenty-two bounded intake events include five form/Save steps and one `gym_routine_saved`.

Native success, Cancel and appearance/input receipts are separate parts of the same frozen cohort;
setup, hierarchy and observer failures remain qualified. No native technical save failure or Issue
arrival is claimed. Deterministic tests cover transaction failures, stale data, delayed admission,
caller disposal and identity replacement. Every owned native process, database and retired AVD is
cleaned while retaining non-AVD evidence; collector 8100 is unchanged. The composed Debug APK is
source-build evidence, not an installed replay or public release.


## Task 51 · Connected log and signed-out Notes

Connected log separates the connected root, empty root and pushed disclosure. Connected tools and
keys open the existing browser settings door. The permission rows and Apply caption sit at the
empty root or behind How when opened from a connected root. The five disclosure paragraphs stay
on their own page; Back returns to the same root. The copy names ChatGPT or Claude and includes
saving notes at the Write level. Tool rows retain their credential kind, scope and since date.
The existing signed-out Notes implementation has the approved single head and sign-in door; only
its account sentence adopts the existing Nunito 16 sp/24 sp role. Signed-in production is unchanged.

The read adapter publishes both credential lists together. Owner, active replica and request
generation reject responses from an earlier connection context, including an owner round trip or
identity-revision change. Both readers observe cache invalidation independently of the loading
flag, so a same-owner reconnect that settles within one turn restarts the complete pair. Unknown
and failed reads do not claim no connections. Known offline
reads use the approved internet sentence; missing authenticated transport remains unread. Static
failure boundaries stay `gym.refreshConnectedLog` and `gym.openConnections`. Existing Room
`gym_screen_viewed` events retain `screen=connections|notes`; the task adds no event name.

All eight linked frames are marked In production on the canonical Android page. Supporting text uses the
Nunito 14 sp/20 sp roles, the connected heading is bold and the empty heading regular. Row title/support
lines have no extra gap; the caption uses 8 dp above and 16 dp below. The forward icon is the
existing 20 dp asset. The How chevron reuses the existing note chevron at 20 dp: its normalized
path matches the approved SVG within 0.000034 dp export precision. The shared Chevron remains
unchanged. Paired native rendered comparison passes with the physical status-bar inset accounted for.

The capture recipe composes two ordinary empty-account states with the fixture-account connected
and disclosure pages. An explicit boolean fixture option seeds a disposable scoped Claude Desktop
grant and static key, then verifies both read endpoints. The default fixture is unchanged. All 33
capture-tool tests pass. The composed focused Kotlin gate passes 47 cases with zero failures,
errors or skips: domain 6, read 3, account routes 8, paired large-text layout 2, screen 10, Notes 15
and connection settings 3. App Debug compiles. The real fixture retains one scoped grant and one
account-wide key, verified through both list endpoints before and after the browser doors.

Paired layout receipts use source `b2893f3e`; the nonvisual read-restart correction and remaining
functional receipts use `bc0b9c8b`, APK `58692f9356f0ef8313ae544826bad7230a33621093cf40540838882344bba5dc`.
The same-signer update retains the encrypted account file byte for byte. How survives two density
changes and Back restores both rows automatically, without a user refresh. Both signed-out doors
open Email and return without submission. Body, disclosure and the complete How door are reachable
at 320 dp/200% in both appearances; the root action remains pinned. Stable anonymous replacements
share the authenticated frames' 50.29 dp physical status-bar/camera-cutout inset. The product keeps
that safe inset; the approved generic drawing uses 24 dp.

The two tool rows deliver native browser settings intents and return with Back. Connect delivers
its exact setup intent; Chrome's first-run window is left unaccepted and ordinary VIEW activation
returns to the retained connection state. Private transition-postcondition failures are retained
separately from the completed proof. No browser setup completion is claimed.

First-party intake retains 87 `b289` events and 136 `bc0b` events, with no unexpected properties.
Current-source screen counts are 17 connections and 9 notes; setup, configuration and private
browser corrections are included, so these are bounded totals rather than whole-flow accounting.
Fifteen Android SDK/release-attributed envelopes contain no Issues. Retained runtime/exit history
has no product fatal/ANR marker. No native technical failure was injected, no read/browser Issue
arrival is claimed and local intake does not establish vendor forwarding. Owned rig cleanup keeps
all non-AVD evidence and leaves the shared collector unchanged. The source is on main and its canonical task states are marked In production.

## Main batch verification and canon status

Main `b40dd5e0` contains tasks 18, 22, 23, 24, 45, 51 and 52 as separate task commits.
33 of the 42 active tasks are on main; tasks 19, 25 and 50 followed this batch. The canonical shipped frames and complete
Weigh-in/Connected-log flows are marked In production; mixed Routines/Workout parents and
unfinished creation, History and Coach states retain their own statuses. Shell A4 reuses the
approved headerless rack without changing its surrounding composition. The Target-summary
proposal and postponed Coach actions remain outside the release scope.

The web workflow retains the complete pinned `b40dd5e0` artifact, then holds before rsync because
the live backend does not admit the new client interval. No compatibility cutoff is activated.
The Lift CLI fixture includes its valid 900 kg set; all 66 tests pass with accurate finite-weight
summary/docs. Hidden-workout tests use LocalActivity: lintDebug has zero errors/fatals and all
five affected tests pass. Python HTTP probes use the configured API-contract directory, including
backend-only layouts; seven affected tests pass through the actual configured CTest target.
These support fixes change test/build admission and stale copy, not app behavior. Their main CI
reruns remain required; the complete supported iOS run `40789910187` is green.
