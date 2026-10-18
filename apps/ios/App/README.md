# Windmill · Journal and Gym

The product app uses `works.windmill.app`, the previous TestFlight bundle identifier. iOS 18 is the
minimum. Generate the project with `python3 Tools/generate_project.py`, then open `Windmill.xcodeproj`.

The default build connects to `https://windmill.works` and saves on the phone without an account.
Configure `WM_SERVER_BASE_URL` with a local server origin, such as `http://127.0.0.1:8089`, or launch
with `-server` followed by that URL. The engine appends `/v1/sync`; native authentication uses
`/v1/auth`. See [the full local server recipe](../../../backend/RUNNING.md). Sessions come from the response body
and are kept in Keychain; native authentication does not retain cookies.

Apple sign-in is off by default and the built app declares no Sign in with Apple entitlement.
Set `WM_APPLE_SIGN_IN_ENABLED=YES` only for a server configured for native Apple verification; the
release workflow reads it from the repository variable `IOS_APPLE_SIGN_IN_ENABLED` (default NO). Device
Release builds use automatic development signing with your team; App Store export signs for distribution. Enable Sign in with Apple for this bundle ID.
An actual Apple ID on a device is required for the production Apple flow.

Debug simulator launches support `-model-server` for the full engine model transport. It supplies
email code `482913` and a fake Apple identity; these authentication shortcuts are absent in Release.
An unbound fake Apple identity returns a memory-only ticket before any account or session exists.
`-apple-fixture linking` uses a relay address; `offline` loses connectivity after Apple authorization;
`expired` advances that ticket past its 15-minute lifetime; `taken` binds Apple to an account with
data; `empty` binds it to an empty account whose door can move. Boards `23-start`, `23a`–`23d` and
`24a`–`24d` seed the existing email account through the real engine. `23-start` opens Keep for full
interaction; `23c` holds the linked receipt for screenshot inspection. A new address plus a valid
code exercises `no-account`; wrong digits exercise the collapsed code refusal. `hello-failure` fails
the first authenticated engine hello after an Apple ticket and freezes the authentication backoff
clock, so Try again exercises manual recovery without racing automatic recovery or reusing the
consumed ticket. `-restore-board` retains the board database and skips reseeding for
relaunch content checks. The model also
supports subject/email matches, spent/unknown tickets, code reuse and a concurrent subject-binding
race in `AppleLinkingTests`. All writes and reads use the existing auth diagnostics with bounded
labels; no fixture secret enters telemetry.
`-board <PNG stem>` isolates a fixed-date fixture using the real journal actions and engine.
`-scenario <name> -report <absolute JSON path>` exercises anonymous writing, Keep, email sign-in,
backup, session revocation, same-account reauthentication, sign-out Keep, and a second sign-in. A local
server run supplies `-code-file <absolute path>` with development codes in its isolated database.
Gym end-to-end tests use `-scenario gym-e2e` (signed in) or `gym-e2e-anonymous`; for Gym, `-code-file` names a JSON native session (`account`, `token`, `email`). The verify skill's iOS gym fixtures mint it with the accounts `GymIntegrationFlowTests` reads. These simulator-only fixtures use the real engine and native UI.
Without `WM_GYM_E2E_SERVER`, conflicting-workout adoption uses `-scenario gym-e2e-conflict`.
A separate client seeds the model server through real Gym actions; atomic snapshots
preserve server rows and email sessions across explicit app relaunches. A simulator-only accessibility
value exposes confirmed rows to the same assertions used by REST verification. Missing, corrupt or
unwritable snapshots fail the fixture. With a backend configured, the test uses REST verification.
The report pauses at `revoke-session` and `signed-out`; a local verifier performs the server step and
writes that checkpoint name to `<report>.ready`. The signed-out checkpoint includes the credential
for local replay verification; the final report contains no credential.

`AppModel` coordinates one account, runtime, runner and active replica for both rooms. The engine
subscribes both product scopes from its iOS registry. Gym and Journal writes made anonymously stay
local until adoption. Occupied accounts ask Journal then Gym with counts by kind; Add/Discard
answers persist against the exact counted work and complete together. Changed work asks again.
Sign-out flushes both rooms, releases held deletes, and keeps dormant work only for its account.

Routine-removal reviews commit their proposal snapshot beside the Apply command in the replica's
`rack:removalReceipts` device row. `AppRuntime.commandResultWrites` composes Journal's claim binding
and Gym's durable removal outcomes; test stores which host these reviews install that same binding.
Retries reuse the pending decision. Pending and settled receipts survive engine/store relaunch and
account switches. Routines exposes unseen settled receipts; an active, visible review acknowledges
its receipt after showing the outcome, while the current model keeps the successful review available.

The Gym UI contract is `Sources/Gym/GymModel.swift` plus `GymRoom.swift`. `GymRoom(gym:app:)` owns a
native TabView (Routines · The log · Coach), independent NavigationStacks and full-screen
`WorkoutScreen` while logging, finishing or showing its receipt. A hidden workout comes back from the tab bar's accessory
on iOS 26 and from the Hidden row at the head of The log on iOS 18, both through `GymModel.openHiddenWorkout(from:)`. Each UI track owns its folder and root view:
`Routines/RoutinesTab.swift`, `Log/LogTab.swift`, `Coach/CoachTab.swift`, and
`Workout/WorkoutScreen.swift`; `Recovery/` holds the signed-out workouts the account has not taken — the log's
**On this phone** row and the list it opens, Inspect and Fix workout — with their model. Each root takes `gym: GymModel`; the room
supplies account/navigation callbacks and Coach handoffs. A model extension lives in the folder of the one track that
reads it; a rule several tracks read, such as what is unsent, is `GymModel.swift`'s own. What more than one track
draws lives once in `Components/`: the page chrome (page modifier, an editing sheet's commit from its bar, keyboard
bar, More menu), the transient band, the
two-line row, the set row and fact tiles, the weight instrument, keypad and Fix set editor, the rename sheet with its
model extension, the one count formatter, the one date formatter (`GymDate`) and the Instant–Date bridge.

`GymModel(runner:runtime:telemetry:)` exposes engine-backed log/catalogue/routines/notes/bodyweight/
preferences/proposals, sessions/sets/openSession, account/isAnonymous/authPaused, notices,
refusal/error/readFailed, and the one unsent rule: signed out nothing is unsent; signed in,
`unsentSets(_:)` and `sessionIsUnsent(_:)` mark what the log has not confirmed while no connection, a paused session
or a refused push holds it back. Use `run(_:)` for GymDomain actions, `save(_:)` for drafts,
`dismissNotice(_:)`, and `refresh()`; `start()`/`stop()` observe engine changes. The app constructs its
ActionRunner with immediate removals. Whole-workout and conversation deletes ask for confirmation;
there is no Undo band or deletion delay. `flush()` keeps pending work before account transitions.
An inactive scene persists Journal drafts while Gym live sync and REST work continue.
Gym's `accountTransition` pauses training only while sign-out is open (`accountChanging`, set by the
app) and while the engine changes the replica (`replicaChanging`, set by `GymBinding`). Pending
sign-in, hello and adoption questions leave training available. `rest` is the authenticated
client handle for Coach, shares and Connected log; engine-backed training writes use domain actions.
Gym includes routine planning and movement creation, the live set rack and finish receipt, session history/sharing and strength/bodyweight charts, and account-only Coach, proposal review, Notes and Connected log.
Tapping a routine opens a native summary sheet with Edit and Start. Movements are reached through a
routine or its editor. Coach has a direct History button; Notes and Connected log live in You’s Settings.
On a resolved signed-in account whose first Gym pull has completed with no personal data, the room
opens Coach’s routine setup once. Existing drafts/conversations, account adoption, workout and navigation
state take precedence. Screenshot, program and goal starters prepare the existing composer; Send remains
explicit. Manual logging or building retires the automatic entry, and empty Routines retains Set up routines.
Setup choices, purpose, editable drafts, photos, typed clarification selections and frozen request identities
live in the existing account-scoped Coach draft store. Clarification choices fill the draft without sending;
editing that text clears the selected-chip markers. Each confirmed routine creation has its own receipt
and opens the existing routine sheet and Start action. A receipt whose routine has not reached the replica
checks the existing routine endpoint; a confirmed removal shows the normal unavailable routine state,
while an unreachable log keeps a refresh action.
USD allowance refusals preserve drafts and partial creation receipts, and never automatically retry on
relaunch. An unchanged deliberate Send reuses the original request identity. Existing routine changes
continue through Review and Apply. Anonymous Coach remains unavailable.
The finished-workout receipt offers Discard, 👑 Share with Coach and the primary Done action.

`GymRoom` keeps `WorkoutScreen` as its full-screen cover through finish and receipt and, on
dismissal, consumes the workout's handoff once: a finished workout's detail opens in The log, Keep
opens the account flow, Share with Coach sends *Check my last workout.* in a new conversation, and
the movement picker's written-program door opens You signed out or paused, Coach otherwise.
`gym.startWorkout(routineId:)` never joins an open workout (`joinOpenSession: false`); with one
open, the start is refused and the open workout returns. The device row `rack:<session-id>` holds
the workout's movement order, selected movement, hidden status and deviation offer — the offered
entry and the routine's revision, which Save guards; an offer the routine has moved past is rebuilt
against the current routine. A set logged before the clock passes the latest set completes 1 ms
after it, so every surface draws sets in logged order. Before the engine changes the replica,
`GymBinding` ends the Live Activity and snapshots each signed-out workout for recovery; a failed
snapshot aborts the account change. `WorkoutActivityController` keeps the Live Activity's
pre-minted offer and its dismissal in the device row `rack:liveactivity`; the widget's
`WorkoutLogSetIntent` runs in the app and logs through the same runner as the rack only while the
offer still matches this phone's open workout, its owner and a resolved identity, and otherwise
opens the workout. The App Shortcuts *Log set* and *Start workout* (`WorkoutActivityShared/WorkoutIntents.swift`) run
in the app too: *Log set* without an offer logs the rack's and answers with it, and *Start workout* opens Routines at its
root, or the logger while a workout is open. The workout control (Control Center, the Lock Screen, the Action button)
draws only what `WorkoutActivityController` last wrote to the App Group `group.works.windmill.app`: *Log set* with
the rack's numbers, *Open workout*, or *Start workout*. Parity with Android is tracked in `PARITY.md`.

Both rooms and the shell follow Appearance in You's Settings (Light · Dark · System, System by default): Gym
answers with Instrument or Daylight, Journal with Night or Day. The choice is the hosting window's interface style,
so the status bar, keyboards and sheets follow it too. The window also carries the front room's accent as its tint —
the shell's brand while You, Keep, sign-in or Where to start? is in front — so selection and the share sheet never
fall back to system blue. The keyboard takes no tint, so the gym's fields keep the plain return key rather than a blue
*Done*; a searchable field's *Search* key stays the system's. You is one inset-grouped list: the identity with its Apple and
email doors (disabled offline, with *Sign-in needs a connection.* as their footer), **On this phone** (signed out, while
a room holds something) or **How you sign in**, **Settings** (Appearance, About Windmill), and *Sign out* last, which
raises its one alert over You. A sign-in link is offered only on the code step.

When the server needs a newer app — the engine's `status.upgradeRequired`, or a 426 at sign-in — one *Update
required* alert speaks when the flag flips, and once more per cold launch while it holds; a sign-in refused for it
asks again as that attempt's answer, and keeps the sign-in pending for the update. You's identity reads *Syncing
paused · update Windmill* with a *Get the update* row; both open TestFlight, and a destination that cannot open
leaves the shell's transient *Couldn't open the update. Try again.* The rooms keep working on the phone. The
`update-required` board signs in against a model server that answers 426 (and keeps answering it across
`-restore-board`); `update-sign-in` answers 426 only to the sign-in; `keep-gym` opens the gym's Keep sheet.

Debug simulator Coach launches add `-coach-fixture`: a signed-in account with a routine, a workout and a
proposal, and a scripted Coach service over the real REST boundary whose answer reads that workout and proposes
the change. `-coach-removal` makes the proposal a removal and the conversation one that asks for it from your totals,
`-coach-created` makes it a conversation that creates the routine, saves a note and reads nothing from the log,
`-coach-out-of-date` has a newer proposal replace it,
`-coach-removal-stall` leaves its Apply unanswered past the review's 15-second wait,
`-coach-offline` takes Coach and its REST reads offline and `-coach-unavailable` answers as a deployment without Coach.

Debug simulator `OfflineFlowTests` seed an isolated `-scenario` with `-offline-fixture seed-signed-in`
or `seed-signed-out`, then reopen it with `-restore-board -server https://offline.invalid` and
`-offline-fixture no-network`, `unreachable` or `stalled`. The HTTP loader injects a missing network,
a refused connection or a request that never answers; only `no-network` also removes the path.
The `black-hole` cases use `https://192.0.2.1` through the ordinary HTTP transport and path monitor,
with no loader or connectivity substitution.
Tests exercise cold launch, Home/resume, local journal persistence, workout controls, Coach, settings
and leaving an unanswered sign-in request. No host networking changes or real credentials are used.

Run the `WindmillTests` scheme tests for deterministic domain and lineage flows, and
`WindmillUITests` for the native sheet/keyboard round trip. All product persistence is in the engine's
protected Application Support directory. `JournalDomain` owns writing and first-run state.
The writing tests use `-journal-layout-test` on Debug simulators to read selection, focus and text,
ink visibility, and UIKit's caret and last-line rectangles in window coordinates, through the editor's accessibility value.

A journal day exists only while its body contains writing. Whitespace and ratings alone do not count;
clearing the body removes the day from journal reads and exports. Synchronization retains empty
version markers to keep older offline writing from returning.
Native editing writes today's page only; past days are read-only. Tapping today's page from its date
through the space above the mood rows opens the keyboard with the caret at the end. The body reserves
at least three lines at the current text size. An empty, unfocused page shows a still lamp caret.
The 44 pt Write seat at bottom-right returns from history to today and opens writing; the same seat
becomes Done writing above the keyboard. It hides during read-only transitions and account sheets.
The room seat is a native Journal · Gym menu with the current room checked; the separate account
button opens You. The last room persists across launches. A fresh phone gets both doors after the
introduction on Where to start?.
Hand-drawn Caveat ink notes appear automatically only on a true first Journal open. Previous Journal
visits, retained history, drafts and unreadable state suppress automatic presentation; restored sign-in
stays quiet. Writing or a tap lifts them while the editor keeps the tap. The room menu contains only the room switcher;
ink notes belong to the first Journal open.
`journal-empty-later`, `journal-one-line` and `journal-history` board fixtures seed past pages through
the journal actions. A `-RM` suffix exercises the journal's Reduce Motion scroll and glyph swap.
Focus and dismissal emit the bounded `first_run_choice` actions `write` and `done_writing` on the
`journal` screen, without page content. When the local day changes at
midnight or after a timezone change, the whole open draft, including its saved prefix, carries into
today and is combined with today's existing page. Yesterday's saved page stays intact. The draft is
persisted on each edit in the active replica before autosave, and is restored across backgrounding,
termination and relaunch. An over-limit combined page stays as a durable draft until shortened.

Startup reads the local replica and leaves room controls available while hello, sync and retained
session revocations run. First-pull status controls backup labels and first-run invitations, not
local editing. Account requests can be dismissed with Back, Close or Done; cancellation suppresses
late navigation, and a pending sign-in or adoption can be deferred while the phone remains usable. Adoption and
sign-out flush dirty writing and recount before completion. A paused session plainly shows that backup
is paused and offers email or Apple sign-in to the same account; reauthentication retains its replica.
Confirmed Keep and Discard sign-out revoke the captured bearer session. If offline, a separate
Keychain queue retains every revocation and retries on the next launch with network, when connectivity
returns, and at most once per 30 seconds while open. Cancel leaves the server session active.

Offline boundary observations:

| Boundary | UI behavior and limit |
|---|---|
| Startup hello and pending-session recovery | Local reads and ordinary launch controls do not wait for hello. The engine bounds hello at `REQUEST_TIMEOUT_MS`, skips a known missing path, and ignores late cancellation results. Pending account recovery can be deferred with Done. |
| Local journal, routines, sets, preferences and movement rename | Read and commit against the local replica. First-pull status describes incomplete history and backup confidence. Workout logging and restoration remain local during pending sign-in, including before Not now. Adoption recounts any new work before completion. |
| Auth and Gym REST | No wait for connectivity; 8-second idle and 15-second total deadlines. Back, Close and Done cancel active auth work. Late responses cannot navigate or change the active account after cancellation. |
| Workout Finish | Online, a set the log accepted but has not yet confirmed gets up to 3 seconds for its confirming pull, with Finish, Log set and Hide locked; offline there is no wait. Finish then attempts the durable local action, releases controls and confirms in the background. Cancelling the wait still ends in that decision. Unconfirmed sets on an already-synced workout remain editable, and the refusal above the rack names the connection requirement; at accessibility text sizes it wraps in a bounded band while Log set and Hide remain reachable. |
| Coach streaming | Parsing runs off the main actor; 8-second idle and 120-second total deadlines. Stop releases the composer immediately. Its late reply preserves newer draft text and photos on the phone. |
| Revocation and telemetry | Run independently of launch, room refresh and local sign-out. Offline events stay queued; repeated connection failures coalesce into one content-free state. |

The network-dependent native features are Coach, journal echoes, account authentication, sharing and
connected-log management. None blocks the local rooms: echoes show nothing extra offline, and the others
state their connection requirement.

Journal echoes live in `Sources/Journal/Echoes`. `JournalEchoView.swift` owns their presentation, as
the iOS contract's §8 draws it: a lamp count in a 22 pt capsule at the end of a day's date line, whose
44 pt target opens that day's ink below its body — up to two older passages beside their mono date
stamps, *Useful · Not useful*, and *N more* when the reader holds the rest. Useful marks the passages
the ink shows; Not useful retires the page's echo. One day's ink is open at a time; the count again, a
tap outside the ink, or the keyboard closes it, and today's count does not draw while writing. The
reader is a sheet of every passage for the day, grouped by year. A passage, in the ink or the reader,
flies the canvas to its source with highlighting and a trail back to tonight. The first echo an install
receives heads its ink with a card, once.
The model re-locates every full quotation in the phone's current pages before showing its count.
Shared journal vectors pin NFC-equivalent matching and UTF-16 anchors into the unchanged source;
equivalent edits retain an echo, while edits that remove its quotation retract it. The model
follows the server's 20-page floor and waiver, provenance and Useful state. The first-echo
card requires an explicit server flag; the current list route does not supply it.
Reads poll every 15 seconds only while the room is active. All reads and verdicts use the existing
REST echoes routes; writing continues through the sync engine. Offline, empty and failed reads
show no echo surface. Requests are cancelled and old replies discarded across account or lifecycle
changes. Verdict failures roll back without a retry queue; opened signals never delay source
navigation. HTTP caching is disabled.

`journal-echoes`, `journal-echoes-offline` and `journal-echoes-empty` board fixtures use real
journal actions with a deterministic echoes service; `journal-echoes-first` carries the first-echo flag.
`journal-echoes-AX3-RM` covers larger type and the source-scroll Reduce Motion path, including Back to
tonight. `journal-echoes-unicode` and `journal-echoes-unicode-decomposed` apply real source edits:
reading the first source changes only its normalization; Useful, reaching the second passage, removes
the first quotation. The source quote sits after 14 paragraphs; navigation tests use the Debug simulator's
UIKit quote rectangle to check that the exact passage reaches the visible canvas centre and
remains read-only. `JournalEchoFlowTests`
belongs to CI's routines-journal shard; its screenshots are XCTest attachments, or PNGs when
`WM_IOS_ECHO_SHOTS` is supplied.
The canon is `docs/design/journal/journal.md` §§3–6 and `onboarding.md` §7; Figma's phone echo
boards are `31:211`/`33:327`, the trail `58:530`/`59:550`, in file `pC6ciOUnfLmI42oMihd7l3`.

Fonts are bundled from official OFL sources, with licences alongside each family:

- [Inter](https://github.com/google/fonts/tree/main/ofl/inter), regular and semibold.
- [Nunito](https://github.com/google/fonts/tree/main/ofl/nunito), extra bold.
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/tree/master/fonts/ttf), regular.
- [Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2), bold introduction wordmark.
- [Caveat](https://github.com/google/fonts/tree/main/ofl/caveat), regular ink notes.

Inter and Nunito are static instances of the official variable fonts. The room colour roles (one
asset catalogue, one palette enum per room), the named type roles, the spacing scale and the room-neutral controls
(the reach band and its primary, the transient, the bar's tint, the soft edge, the door chevron) live in
`Sources/Theme/`, which the Live Activity extension compiles too; their values follow
[the iOS redesign contract](../../../docs/design/ios/ios-redesign.md). The onboarding glimpses keep
their illustration colours under `onboarding/` in `Resources/Assets.xcassets`.
`python3 Tools/check_theme_literals.py` rejects, outside `Sources/Theme/` in the app, widget and
Activity shared sources, numeric and hex colour construction, system named colours, the asset accent
colour, UIKit semantic and label colours, the system's label hierarchy (`.primary` to `.quinary`,
`.placeholder`, `.separator`), asset colour lookups by string and appearance branches between colours.
A fade is a role, so everywhere but `Sources/Theme/Palettes.swift`, `Sources/Theme/` included, it also
rejects `opacity` or `withAlphaComponent` on a palette role, an `OnboardingSpecimen`, a `Color(…)` or a
local colour alias, `.mix(with:by:)`, a hierarchical level, bare or after `.tint`, `.foreground`, a role or
an alias, and a view `opacity` with a constant other than 0 or 1. Its allowlist names each remaining exception
and why, the check prints every allowed line with its reason, and an entry that no longer matches fails
the check. Project generation and both target builds run the check;
`python3 -m unittest discover -s Tools/tests -v` includes its rejection cases.

Telemetry uses Sentry Cocoa for failures and first-party `/v1/events` for product events. Debug
telemetry is off unless `WM_DEBUG_TELEMETRY=YES` is supplied; simulator verification can use
`-telemetry -sentry-dsn http://ios@127.0.0.1:8091/42`. Release builds require `IOS_SENTRY_DSN`.
See [iOS observability](../../../docs/IOS_OBSERVABILITY.md) for the complete event allowlist,
privacy rules, queue behavior and release verification. CI uses `python3 Tools/generate_project.py`
with a nonproduction DSN. [TestFlight releases](#testflight-releases) use the manual GitHub Actions pipeline.

The UI test bundle presses Home and activates SpringBoard, waiting for its event loop and animations
to become idle. It requires the foreground Home screen and a hittable Safari icon before any test
begins. A failed preflight stops the bundle before an app launch. Launches with `-model-server`, a board or a scenario
run without UIKit animations: an open iOS 26 menu never lets them settle, so XCTest would wait out its idle timeout
after every menu tap.

The Live Activity UI test waits for published Island content and presses SpringBoard's Activity
container to expand it. To capture its
minimal layout, `WM_ACTIVITY_RENDER_MEDIA` can point to a local audio page whose Play QA tone button
changes to QA tone is playing after playback starts. Audio must continue while Safari is backgrounded.
The test finishes the workout and verifies that the Activity disappears after logging from the Island.

`DesignCaptureTests` is an opt-in design review suite. It captures onboarding, both rooms, account
flows, pushed screens and sheets in light and dark. XCTest skips it unless the test runner sees `WM_DESIGN_CAPTURE=1`; Xcode forwards
`TEST_RUNNER_`-prefixed variables to the runner without the prefix. The CI shards leave the class out
and check that its guard remains. From this directory, with one simulator and a fresh result path:

```sh
python3 Tools/generate_project.py
TEST_RUNNER_WM_DESIGN_CAPTURE=1 xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination "platform=iOS Simulator,id=$SIMULATOR" -parallel-testing-enabled NO \
  -resultBundlePath "$RESULT" -only-testing:WindmillUITests/DesignCaptureTests
python3 Tools/export_design_captures.py --result "$RESULT" --output "$CAPTURES"
```

Each PNG names its screen, state and appearance. The exporter suffixes a name that already exists in
the output folder and writes a `capture-manifest.json` linking each PNG to its test and result bundle.

## TestFlight releases

TestFlight releases run through [`.github/workflows/ios-release.yml`](../../../.github/workflows/ios-release.yml).
The workflow uses the repository's signing credentials, builds with Xcode 26.3 and uploads to
App Store Connect. Normal uploads do not require an interactive App Store Connect login. Separate
Apple processing or distribution troubleshooting may require App Store Connect access.

Check recent release runs for an existing upload and verify the intended commit is on remote `main`
before dispatching. The workflow is manual and does not run on push:

```sh
gh run list --workflow ios-release.yml --limit 5
gh api repos/neigrok/windmill-monorepo/git/ref/heads/main --jq '.object.sha'
gh workflow run ios-release.yml --ref main
```

Find the newly created run explicitly:

```sh
gh run list --workflow ios-release.yml --branch main --event workflow_dispatch --limit 5 \
  --json databaseId,headSha,number,url,status
```

Record its `url` and use its `databaseId` as `RUN_ID` in
`gh api repos/neigrok/windmill-monorepo/actions/runs/RUN_ID` to inspect `head_sha` and `run_number`.
The marketing version comes from `project.yml`; `Tools/generate_project.py --release`
sets both app and widget build numbers to `GITHUB_RUN_NUMBER`. Verify the selected SHA matches the
intended release and avoid dispatching a duplicate run while it is queued or building.

Monitor the run with `gh run watch RUN_ID --exit-status`, then inspect its job steps and upload log.
Archive, stored-certificate verification, release-symbol retention, and export/upload must pass.
The workflow retains `ios-dsyms-RUN_NUMBER` for 30 days. *Upload succeeded* and *EXPORT SUCCEEDED*
confirm Apple's acceptance of the upload; *Uploaded package is processing* does not confirm that
processing is complete or that testers can install it. This pipeline does not check tester
availability or change tester groups. Record the verified version, build, source SHA, run URL,
upload result and any processing or symbol limitations in `WORK_LOG.md`.
