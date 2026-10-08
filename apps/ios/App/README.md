# Windmill · Journal and Gym

The product app uses `works.windmill.app`, the previous TestFlight bundle identifier. iOS 18 is the
minimum. Generate the project with `xcodegen generate`, then open `Windmill.xcodeproj`.

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
`WorkoutScreen` while logging, finishing or showing its receipt. Hidden workouts restore from Gym settings. Each UI track owns its folder and root view:
`Routines/RoutinesTab.swift`, `Log/LogTab.swift`, `Coach/CoachTab.swift`, and
`Workout/WorkoutScreen.swift`. Each root takes `gym: GymModel`; the room supplies account/navigation callbacks and Coach handoffs. Add model extensions
only in the owning track's folder, never in `GymModel.swift`.

`GymModel(runner:runtime:telemetry:)` exposes engine-backed log/catalogue/routines/notes/bodyweight/
preferences/proposals, sessions/sets/openSession, account/isAnonymous/authPaused, notices,
refusal/error/readFailed and undoOffers. Use `run(_:)` for GymDomain actions, `save(_:)` for drafts,
`undo(_:)` for held gestures, `dismissNotice(_:)`, and `refresh()`; `start()`/`stop()` observe engine
changes. `flush()` releases holds before account transitions; real backgrounding ends Undo windows.
An inactive scene persists Journal drafts while Gym live sync, REST work and pending Undo windows continue.
Gym's `accountTransition` pauses training only while sign-out is open (`accountChanging`, set by the
app) and while the engine changes the replica (`replicaChanging`, set by `GymBinding`). Pending
sign-in, hello and adoption questions leave training available. `rest` is the authenticated
client handle for Coach, shares and Connected log; engine-backed training writes use domain actions.
Gym includes routine planning and movement creation, the live set rack and finish receipt, session history/sharing and strength/bodyweight charts, and account-only Coach, proposal review, Notes and Connected log. Gym follows system light/dark appearance; Journal keeps its night canvas.

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

Native editing writes today's page only; past days are read-only. Tapping today's page from its date
through the space above the mood rows opens the keyboard with the caret at the end. The body reserves
at least three lines at the current text size. An empty, unfocused page shows a still lamp caret.
The 44 pt Write seat at bottom-right returns from history to today and opens writing; the same seat
becomes Done writing above the keyboard. It hides during read-only transitions and account sheets.
The room seat is a native Journal · Gym menu with the current room checked; the separate account
button opens You. The last room persists across launches. A fresh phone gets both doors after the
introduction on Where to start?.
Hand-drawn Caveat ink notes appear only on a true first Journal open. Previous Journal visits, retained history, drafts and unreadable state suppress them; restored sign-in stays quiet. Writing or a tap lifts them while the editor keeps the tap; there is no replay control.
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
| Workout Finish | Attempts the durable local action before network confirmation and releases controls. Unconfirmed sets on an already-synced workout remain editable and explain the connection requirement. The latest message leads the notice, so at accessibility text sizes the connection requirement shows unscrolled above the rack; the rest wraps and scrolls while Log set and Hide remain reachable. |
| Coach streaming | Parsing runs off the main actor; 8-second idle and 120-second total deadlines. Stop releases the composer immediately. Its late reply preserves newer draft text and photos on the phone. |
| Revocation and telemetry | Run independently of launch, room refresh and local sign-out. Offline events stay queued; repeated connection failures coalesce into one content-free state. |

The network-dependent native features are Coach, journal echoes, account authentication, sharing and
connected-log management. None blocks the local rooms: echoes show nothing extra offline, and the others
state their connection requirement.

Journal echoes live in `Sources/Journal/Echoes`. `JournalEchoView.swift` owns their presentation:
a 44 pt count beside a day, a native quotation sheet, source highlighting and a trail back to
tonight. The sheet follows system light/dark appearance independently of the existing night canvas.
The model re-locates every full quotation in the phone's current pages before showing its count.
Shared journal vectors pin NFC-equivalent matching and UTF-16 anchors into the unchanged source;
equivalent edits retain an echo, while edits that remove its quotation retract it. The model
follows the server's 20-page floor and waiver, provenance and Useful state. A first-echo
introduction requires an explicit server flag; the current list route does not supply it.
Reads poll every 15 seconds only while the room is active. All reads and verdicts use the existing
REST echoes routes; writing continues through the sync engine. Offline, empty and failed reads
show no echo surface. Requests are cancelled and old replies discarded across account or lifecycle
changes. Verdict failures roll back without a retry queue; opened signals never delay source
navigation. HTTP caching is disabled.

`journal-echoes`, `journal-echoes-offline` and `journal-echoes-empty` board fixtures use real
journal actions with a deterministic echoes service. `journal-echoes-AX3-RM` covers larger type
and the source-scroll Reduce Motion path, including Back to tonight. `journal-echoes-unicode`
and `journal-echoes-unicode-decomposed` apply real source edits while the sheet is open: Useful
on the first quotation changes only its normalization; Useful on the second removes the first
quotation. The source quote sits after 14 paragraphs; navigation tests use the Debug simulator's
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

Inter and Nunito are static instances of the official variable fonts. Colour and type tokens
follow the supplied Figma `TOKENS.json`.

Telemetry uses Sentry Cocoa for failures and first-party `/v1/events` for product events. Debug
telemetry is off unless `WM_DEBUG_TELEMETRY=YES` is supplied; simulator verification can use
`-telemetry -sentry-dsn http://ios@127.0.0.1:8091/42`. Release builds require `IOS_SENTRY_DSN`.
See [iOS observability](../../../docs/IOS_OBSERVABILITY.md) for the complete event allowlist,
privacy rules, queue behavior and release verification. CI uses `python3 Tools/generate_project.py`
with a nonproduction DSN. The manual release workflow uses `--release` with the signing secrets,
builds with Xcode 26.3 and uploads to TestFlight; it does not run on push.

The UI test bundle presses Home and activates SpringBoard, waiting for its event loop and animations
to become idle. It requires the foreground Home screen and a hittable Safari icon before any test
begins. A failed preflight stops the bundle before an app launch.

The Live Activity UI test waits for published Island content and presses SpringBoard's Activity
container to expand it. To capture its
minimal layout, `WM_ACTIVITY_RENDER_MEDIA` can point to a local audio page whose Play QA tone button
changes to QA tone is playing after playback starts. Audio must continue while Safari is backgrounded.
The test finishes the workout and verifies that the Activity disappears after logging from the Island.

Coordinator-owned documentation outside this worktree's territory still describes the earlier app:
`CLAUDE.md:12`, `docs/design/guidelines/onboarding.md:138`/`:141` and `docs/design/consistency.md`
entry 5m need the two-room availability update.
Consistency's iOS auth/adoption entries 8a and 8h predate the current Apple ticket flow,
`AppModel` and per-room Add/Discard counts; `docs/design/guidelines/account-linking.md:90` needs a
two-room adoption example.
`docs/foundation/domain-kit.md:970` needs “two writing operations”: read guards may accompany one
write to a record. Figma `_Room capsule` variant `117:52` retains a stale You-row description;
set `226:4315` and boards 21a/21b match Journal · Gym only.
