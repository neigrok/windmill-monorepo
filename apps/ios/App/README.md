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

Debug simulator launches support `-model-server` for the full engine model transport. It answers inside the app,
so the engine counts it online whatever the simulator's network path reports. It supplies email code `482913` and a fake Apple identity; these authentication shortcuts are absent in Release.
An unbound fake Apple identity returns a memory-only ticket before any account or session exists.
`-apple-fixture linking` uses a relay address; `offline` loses connectivity after Apple authorization;
`expired` advances that ticket past its 15-minute lifetime; `taken` binds Apple to an account with
data; `empty` binds it to an empty account whose door can move. Boards `23-start`, `23a`–`23d` and
`24a`–`24d` seed the existing email account through the real engine. `23-start` opens Keep for full
interaction; `23c` holds the linked receipt for screenshot inspection. `-adoption-workouts N` and
`-adoption-pages N` set what the phone holds before `23d`'s sign-in (one page by default; workouts give
the account training too), so it asks the sign-in question of 23d–23j. Board `16e` leaves three
changes the server never confirms, with You open on Sign out. Board `02-returning` seeds an account of 142 journal
pages and 38 workouts, the gym last written to, which Apple opens from Where to start?; `02-returning-held` serves small pull
pages, answers four signed-in pulls a second apart and holds the rest, so *Bringing it back* climbs, then stands part-way. A new address plus a valid
code exercises `no-account`; wrong digits exercise the collapsed code refusal. `hello-failure` fails
the first authenticated engine hello after an Apple ticket and freezes the authentication backoff
clock, so Try again exercises manual recovery without racing automatic recovery or reusing the
consumed ticket. `-restore-board` retains the board database and skips reseeding for
relaunch content checks. The model also
supports subject/email matches, spent/unknown tickets, code reuse and a concurrent subject-binding
race in `AppleLinkingTests`. All writes and reads use the existing auth diagnostics with bounded
labels; no fixture secret enters telemetry.
`-board <PNG stem>` isolates a fixed-date fixture using the real journal actions and engine.
`-scenario <name>` isolates a launch's storage under that name.
`-scenario <name> -report <absolute JSON path>` exercises anonymous writing, Keep, email sign-in,
backup, session revocation, same-account reauthentication, sign-out Keep, and a second sign-in. A local
server run supplies `-code-file <absolute path>` with development codes in its isolated database.
Gym end-to-end tests use `-scenario gym-e2e` (signed in) or `gym-e2e-anonymous`; for Gym, `-code-file` names a JSON native session (`account`, `token`, `email`). The verify skill's iOS gym fixtures mint it with the accounts `GymIntegrationFlowTests` reads; against a backend, `TEST_RUNNER_WM_GYM_E2E_SENTRY` names the Sentry DSN those runs report to. These simulator-only fixtures use the real engine and native UI.
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
local until adoption. Occupied accounts ask one question naming both rooms' work by kind
(`AdoptionQuestion`); one Add/Discard answers every room, persists against the exact counted work and
completes together. Changed work asks again about the room that changed.
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
two-line row, the set row and fact tiles, the load field and reps wheel and the Fix set editor, the rename sheet with its
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
client handle for shares and Connected log; Coach speaks the turn wire through `coachTurns`, and engine-backed training writes use domain actions.
Gym includes routine planning and movement creation, the live set rack and finish receipt, session history/sharing and strength/bodyweight charts, and Coach, account-only proposal review, Notes and Connected log.
Tapping a routine opens a native summary sheet with Edit and Start. Movements are reached through a
routine or its editor. Coach has a direct History button, listing the engine's conversations beside this phone's drafts;
Notes and Connected log live in You’s Settings.
On a resolved empty anonymous replica, or a signed-in account whose first Gym pull has completed with no personal data, the room
opens Coach. Existing drafts/conversations, account adoption, workout and navigation state take
precedence. Coach greets the user locally in two bubbles — who it is, then what it can do, each line led by its anchor
word (signed in: Build, Goals, Notes, Changes; signed out: Build, Goals, Account) — with Add screenshot and Build my own
under them. A signed-in gym that already holds routines opens on an empty conversation. The greeting persists through typing, photo selection/cancellation, navigation,
relaunch and failed sends until the first accepted message, and steps aside while a message is on its
way. Goals and constraints use plain dialogue.
Routines, empty or not, has one bottom-trailing glass plus, *New routine*, opening the routine builder.
The builder stages exercise name, equipment and targets in one movement form. Done/Add changes the
routine draft; outer Save commits the routine and changed exercise metadata atomically through
`SaveRoutinePlan`. Outer Cancel discards those staged edits; editor Cancel restores the entry draft.
Exercise metadata applies across the account, while targets belong to that routine entry. The form
keeps optional and per-set targets, Ramp/Match and one/two-dumbbell units without a separate Targets
destination. Stale metadata or a changed owner refuses the whole save. Received Other movements
retain their category and signed targets through name-only and target edits. Other uses kg without
an equipment glyph; its rack and Fix set loads take negative, zero and positive values through the ± key. The six
existing equipment picker choices remain. Name/Equipment explanatory footers are absent, and the
Other target section has no equipment help.

The Log groups workouts, every weigh-in and optional records by local date. Timed entries share a
chronological sequence; a backdated or legacy weight with day-only precision follows timed entries
on that day. Workouts use filled cards, weights use separated rows and records use inset markers.
Weights remain factual rows regardless of highlight limits. Workout and weight rows open their
respective detail/correction; derived records open progress and have no independent Delete. A weight’s
context menu opens the Bodyweight chart. Weigh in floats directly above the canvas.

The content-sized weigh-in sheet preserves the typed weight while a native graphical `DatePicker`
stages another day; Back cancels the date change and checkmark accepts it without saving the weight.
The calendar dismisses the keyboard and expands within the same sheet. Correction keeps its day fixed.

A conversation's messages are engine records (`thread`, `message`; Coach §9.1) that sync for an account and
stay on the phone signed out. Each turn runs on this phone (`Coach/Turn/`): admitted locally (a connection, no
workout open, the replica's first pull, 8,000 bytes, one picture), recorded in one engine gesture as the lifter
message and the running Coach message, opened over `POST /v1/gym/coach/turns` with the four context reads, the
newest completed turns and the pictures' model copies, its batches of ability calls run on the replica through
`GymDomain.AbilityExecutor` and answered on `…/results`, its text streamed onto the Coach message in
coalesced commits, and ended with its state and the receipt its calls derive. A dropped stream resumes from the
server's `snapshot` after 1, 2, 4 and 8 beats; a turn the process died under ends interrupted at engine start;
only the replica named on the message writes it, and another phone shows the turn as answering elsewhere.
Draft text and photos, the drafts a signed-out start left, the signed-out onboarding answers earlier
versions kept and the acceptance marks live in an account- or replica-scoped Coach archive, out of
backups. Deliberately entering the Coach tab opens a fresh canvas; History lists every conversation
and draft. A fresh draft shows Answer in progress and View chat while a turn runs on another
conversation. The archive applies adoption or deletion to all conversations for the captured owner.
Coach keeps the full tab bar while scrolling; the composer has no backing panel.
Signed in or out, `create_routine` lands on the replica under the turn and is drawn as one receipt per
routine created. The drafts card (*3 NEW ROUTINES*, each routine a heading that opens in place to its
movements as added blocks, then **Apply** and **Reject**) stands only under an archived signed-out
onboarding answer of an earlier version: Apply commits its routines and the replay receipt in one domain
action (`ImportCoachRoutines`), and Reject drops them on this phone with *Rejected · 3 routines*, which stays
through a new chat, an opened or deleted conversation and adoption. A movement the phone does not know
yet reads *New movement*. After sign-in and *Add* the adopted conversation stays on screen, and the next
question goes to the account's seat, which can answer it with a change to a routine the conversation
created. Existing routine changes are decided on their proposal card.

Allowance refusals keep the draft, with no balance indicator: a refusal before the stream withdraws the
turn's records so the refused question stays in the field, and the refusal is drawn once, centred in
the conversation — the sentence for its code, *You have used all of your AI allowance.* — with *Sign in
to continue.* and Sign in only signed out, where the phone's own AI access is used up or belongs to an
account; shared free-pool, concurrency and rate refusals offer nothing to do. A turn the allowance
refuses mid-way ends failed with its partial text and the same sentence. The reset line of an
archived signed-out answer stands where its allowance named a reset. Signed in there is no upgrade
while paid plans are closed (01.12 is not built). `coach-rate-limited` reads *You can ask again later.*,
since the turn wire names no moment, with *Use your own AI agent*. A capped or refused question is never
sent again on its own: it stays in the field, and only Send asks again, with what the field then holds.

Signed out, Coach is the same turn against the `anon` replica (Coach §8): the server issues a separate
installation credential in device-only Keychain storage and applies installation, IP and shared
budgets; an unreadable or rejected credential never creates a replacement. The abilities that need the
account (`save_note`, the shares) are refused `seat-required` on the phone, and the newest answer that
met one offers Sign in under it. A picture leaves the phone only as its model copy inside the open
request, on every seat. Open and Start work before sign-in
once a routine is created. Keep uses existing account adoption; usage binds before the account's seat is
used, independently of Add/Discard. A binding outage leaves authentication and manual Gym available.
Local drafts and archived answers transfer to the account archive on Add or empty-account adoption and
are removed on explicit Discard; the conversation records move with the replica. Work from a previous
account/replica cannot publish into the active seat.

The live workout uses a compact ledger with up to three 44-point rows at default text size;
accessibility sizes expand it. Movement paging dots and clocks remain, without the duplicate set
statistics strip. Assembly and Add movement share one sheet destination. Selecting a movement returns
to its live logger with existing sets and draft intact; cancellation leaves the workout unchanged.

The finished-workout receipt places 👑 Share with Coach and the primary Done action in two full-width rows.
A native top-trailing options menu offers Discard workout and its actual-set-count confirmation.
The bottom actions use 52-point minimum heights and 12-point separation, growing with text; the menu
and actions are disabled during account transitions. The menu uses UIKit `UIButton` / `UIMenu`, with
open events from `.menuActionTriggered`. The approved gold crown is the original-color
`gym/coach-crown` image asset. Keep and review retry remain in the scrollable receipt content. Signed
out, the phone's first receipt suggests Keep once (03.15): *Only on this phone · Keep it* under the
tiles. The phone keeps that workout's id in its preferences, so the same receipt drawn again still
suggests it and no later receipt does, signed out or in.

`GymRoom` keeps `WorkoutScreen` as its full-screen cover through finish and receipt and, on
dismissal, consumes the workout's handoff once: a finished workout's detail opens in The log, the
receipt's Keep it opens it there with Keep over it, Share with Coach sends *Check my last workout.* in a new conversation (a
handoff belongs to the account it was asked under, so the sign-in it waited for keeps it), and
the movement picker's written-program door opens You signed out or paused, Coach otherwise.
`gym.startWorkout(routineId:)` never joins an open workout (`joinOpenSession: false`); with one
open, the start is refused and the open workout returns. The device row `rack:<session-id>` holds
the workout's movement order, selected movement and hidden status. Lifting above the plan only
logs the set; a routine's targets change in the routine editor or through Coach's proposals. A set logged before the clock passes the latest set completes 1 ms
after it, so every surface draws sets in logged order. Before the engine changes the replica,
`GymBinding` saves the rack's pending value, ends the Live Activity and snapshots each signed-out workout for recovery; a failed
snapshot aborts the account change. `WorkoutActivityController` keeps the Live Activity's
pre-minted offer and its dismissal in the device row `rack:liveactivity`; the widget's
`WorkoutLogSetIntent` runs in the app and logs through the same runner as the rack only while the
offer still matches this phone's open workout, its owner and a resolved identity, and otherwise
opens the workout. The App Shortcuts *Log set* and *Start workout* (`WorkoutActivityShared/WorkoutIntents.swift`) run
in the app too: *Log set* without an offer logs the rack's and answers with it, and *Start workout* opens Routines at its
root, or the logger while a workout is open. The workout control (Control Center, the Lock Screen, the Action button)
draws only what `WorkoutActivityController` last wrote to the App Group `group.works.windmill.app`: *Log set* with
the rack's numbers, *Open workout*, or *Start workout*. The Home Screen's quick actions (`Sources/QuickActions.swift`)
are *Write tonight*, which opens tonight's page with the keyboard up, and *Start ‹routine›* for the routine last trained
(else the first in Routines; none without a routine), which starts its workout, or *Open workout* while one runs. The
items follow the gym as it changes; one that launches Windmill waits for the first screen and opens past the
introduction. Parity with Android is tracked in `PARITY.md`.

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

`GymAnonymousCoachFlowTests` runs one flow in the standard Coach UI through the deterministic installation and turn
fixture and the real local engine: signed out, one question creates three routines on the phone, Keep your routines
signs in, and the same conversation goes on. Set `TEST_RUNNER_WM_ANONYMOUS_COACH_SERVER` for its signed-out half
against an isolated backend and `TEST_RUNNER_WM_ANONYMOUS_COACH_SHOTS` for PNG captures. `CoachTurnTests` replays every
exchange of `packages/api-contract/gym/turns/` against a scripted server as the phone. Neither standard suite skips tests.

Debug simulator Coach launches add `-coach-fixture`: a signed-in account with a routine, a workout and notes, and a
scripted Coach server over the turn wire whose batch of ability calls the phone's executor runs for real — the default
conversation reads that workout and proposes a change to Push A. Startup prepares the account and fixture before
publishing the app model. Scenarios prefixed `gym-e2e-anonymous` remain anonymous until the test signs in through the
account flow; view-time preparation can seed an existing account but cannot sign in. Add `-coach-setup-fixture` for an
empty signed-in account, and `-coach-archived-answer` beside it for one holding an archived signed-out answer with routine
drafts. `-coach-removal` makes the
conversation one that proposes the routine's removal from your totals, `-coach-created` one that creates the routine
and saves a note, `-coach-out-of-date` has a newer proposal replace the turn's once the answer settles,
`-coach-decision-stall` leaves a card's Apply unanswered past its 15-second wait, `-coach-decision-unreachable` leaves every push
four seconds in flight, then unanswered, `-coach-markdown` answers in Markdown, `-coach-streaming` holds Coach mid-answer,
`-coach-thinking` holds it before its first word, `-coach-board <name>` (`CoachBoard.all`) seeds the routines of a board and
answers its questions with the proposals, routines and note the board names, `-coach-draft-photo` puts a program screenshot
in the composer, `-coach-daily-cap` refuses every question after the first `coach-rate-limited`, `-coach-board needs-account`
answers a signed-out question with a note the phone refuses `seat-required`, `-coach-allowance-spent` answers the first
question and refuses the next `subject_exhausted`, `-coach-history` seeds four conversations in History, `-coach-one-draft`
makes the setup fixture's drafts one routine, `-coach-kept-draft` keeps a signed-out start's draft on the phone beside the
account's own, `-coach-board after-sign-in` creates three full-body days signed out and answers a signed-in *Swap chin-ups
for pulldowns* with a change to *Full body B*, `-coach-offline` takes Coach and its REST reads offline and
`-coach-unavailable` answers as a deployment without Coach. The local Coach's boards are `-coach-board` cases too: `steps`
holds a turn after its batch with the step line under it, `resume` drops that stream and answers the resume with a
snapshot, `movement` makes a movement, `truncated`, `declined`, `failed`, `stopped` and `interrupted` end a turn each way,
`no-connection`, `log-arriving` and `too-long` refuse the send after the first answer on this phone,
`invalid-installation`, `device-bound`, `free-month` and `update-required` refuse it from the server, `signed-out-reads`
seeds two workouts on the anonymous replica, `another-device` seeds a turn another phone is answering, and
`account-changing` begins an account change under a draft.

Debug simulator offline launches seed an isolated `-scenario` with `-offline-fixture seed-signed-in`
or `seed-signed-out`, then reopen it with `-restore-board -server https://offline.invalid` and
`-offline-fixture no-network`, `unreachable` or `stalled` (`OfflineFixture.Mode`). Each mode's HTTP loader
injects a missing network, a refused connection or a request that never answers; only `no-network` also
removes the path. `-offline-fixture black-hole` with `https://192.0.2.1` uses the ordinary HTTP transport and
path monitor, with no loader or connectivity substitution. These fixtures use the fixed `BoardClock` across
seeding, cold launch and resume. `StartupRecoveryTests` runs every mode, signed in and out, through
`OfflineFixture.runtime`: journal writing, a routine and its workout, room switching, resume and a cold launch
stay on the phone, and You keeps or lacks the account. `OfflineFlowTests` drives the black-hole launch signed
in and a resume during a stalled hello signed out through the native UI. No host networking changes or real
credentials are used.

Run the `WindmillTests` scheme tests for deterministic domain and lineage flows, and
`WindmillUITests` for the native sheet/keyboard round trip. All product persistence is in the engine's
protected Application Support directory. `JournalDomain` owns writing and first-run state.
The journal geometry and echo flows use `-journal-layout-test` on Debug simulators to read selection, focus and text,
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
introduction on Where to start?. Its quiet Sign in opens the account sheet as *Pick up where you left off* (02b). After that
sign-in, *Bringing it back* (02c) counts each room's visible records as they land against the totals the account's
hello tallies by the same rule (`SignInRestore`), and opens the room the person last wrote to once its own records are
in; the other keeps arriving behind it. A lost connection or session opens that room at once, and so do ten seconds
in which nothing lands (a hung pull, a server backing off).
Hand-drawn Caveat ink notes appear automatically only on a true first Journal open. Previous Journal
visits, retained history, drafts and unreadable state suppress automatic presentation; restored sign-in
stays quiet. Writing or a tap lifts them while the editor keeps the tap. The room menu contains only the room switcher;
ink notes belong to the first Journal open.
`journal-empty-later` and `journal-history` board fixtures seed past pages through
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
Delete account, from You signed in, confirms with the account's email, flushes and holds every
room and door as sign-out does, sends `DELETE /v1/me` naming the signed-in user id, then
discards this phone's copy and the account's Coach drafts; 27d waits for that discard, and Done returns
to You signed out. From the server's close, or a 401 after the confirm (which lands on You signed out),
the phone owes the discard: preferences keep `accountDiscardOwed`, the rooms stay held, and Try again or
the next launch, before any room opens, settles it. The `-delete-fixture held` and `offline` launch
arguments hold or refuse that request on the model server. Confirmed Keep and Discard sign-out revoke the captured bearer session. If offline, a separate
Keychain queue retains every revocation and retries on the next launch with network, when connectivity
returns, and at most once per 30 seconds while open. Cancel leaves the server session active.

Offline boundary observations:

| Boundary | UI behavior and limit |
|---|---|
| Startup hello and pending-session recovery | Local reads and ordinary launch controls do not wait for hello. The engine bounds hello at `REQUEST_TIMEOUT_MS`, skips a known missing path, and ignores late cancellation results. Pending account recovery can be deferred with Done. |
| Local journal, routines, sets, preferences and movement rename | Read and commit against the local replica. First-pull status describes incomplete history and backup confidence. Workout logging and restoration remain local during pending sign-in, including before Cancel sign-in. Adoption recounts any new work before completion. |
| Auth and Gym REST | No wait for connectivity; 8-second idle and 15-second total deadlines. Back, Close and Done cancel active auth work. Late responses cannot navigate or change the active account after cancellation. |
| Workout Finish | Online, a set the log accepted but has not yet confirmed gets up to 3 seconds for its confirming pull, with Finish, Log set and Hide locked; offline there is no wait. Finish then attempts the durable local action, releases controls and confirms in the background. Cancelling the wait still ends in that decision. Unconfirmed sets on an already-synced workout remain editable, and the refusal above the rack names the connection requirement; at accessibility text sizes it wraps in a bounded band while Log set and Hide remain reachable. |
| Coach turns | Stream parsing runs off the main actor. Server heartbeats count as transport activity; the request idle timeout is 60 seconds and the total stream limit is one hour. A dropped stream, or one closed with `coach-stream-replaced`, resumes after 1, 2, 4 and 8 beats, keeps the partial text and clears Reconnecting on the first frame; a fifth loss ends the turn interrupted. A batch the server timed out refuses its late results `coach-turn-order`, and the turn ends interrupted. A batch's results post again after a lost answer, since the same body answers 204. Stop asks the server and its stream ends the turn; with no connection the turn stops on this phone. A turn keeps running under a background task while the system lends time. |
| Revocation and telemetry | Run independently of launch, room refresh and local sign-out. Offline events stay queued; repeated connection failures coalesce into one content-free state. |

The network-dependent native features are Coach, journal echoes, account authentication, sharing and
connected-log management. None blocks the local rooms: echoes show nothing extra offline, and the others
state their connection requirement.

Journal echoes live in `Sources/Journal/Echoes`. `JournalEchoView.swift` owns their presentation, as
Figma's phone echo boards draw it: a lamp count in a 22 pt capsule at the end of a day's date line, whose
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

The `journal-echoes` board fixture uses real journal actions with a deterministic echoes service;
`journal-echoes-first` carries the first-echo flag. `journal-echoes-AX3-RM` covers larger type and the
source-scroll Reduce Motion path, including Back to tonight. The source quote sits after 14 paragraphs;
the echo flows use the Debug simulator's UIKit quote rectangle to check that the exact passage reaches the
visible canvas centre and remains read-only. `JournalEchoFlowTests` walks the light flow; the larger-type,
Reduce Motion and canvas-end checks run in the opt-in `NightlyFlowTests`.
Journal's principles are in `docs/design/brand-foundations.md`; Figma's phone echo
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
`Sources/Theme/`, which the Live Activity extension compiles too; the colour values follow
[the iOS colour roles](../../../docs/design/ios/ios-redesign.md), which `Tools/tests/test_theme_assets.py`
checks against the asset catalogue. The onboarding glimpses keep
their illustration colours under `onboarding/` in `Resources/Assets.xcassets`.
The [six-flow Gym handoff](../../../docs/engineering/ios-gym-ui-flows.md) records approved designs,
accepted runtime captures, scoped verification results and remaining performance/coverage limits.
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
container to expand it. To check its minimal layout too, `WM_ACTIVITY_RENDER_MEDIA` can point to a local
audio page whose Play QA tone button changes to QA tone is playing after playback starts. Audio must
continue while Safari is backgrounded. The test finishes the workout and verifies that the Activity
disappears after logging from the Island.

`NightlyFlowTests` holds the slow end-to-end checks a daily run is enough for: the workout control in Control
Center, the Home Screen's quick actions from the background and from a cold start, the journal's Write seat
geometry (Reduce Motion and the largest text included), echoes at accessible text, and the introduction at the
accessibility sizes. `GymNightlyFlowTests` holds the gym's layout checks at the screen's edges: the log's end clear
of the tab bar and the accessory, and the conversation's end clear of the composer, after a pushed screen pops or a bounce brings the bar back. XCTest
skips both classes unless the test runner sees `WM_NIGHTLY_UI=1` (`TEST_RUNNER_WM_NIGHTLY_UI=1` when invoking
xcodebuild); [iOS nightly](../../../.github/workflows/ios-nightly.yml) runs them once a day.

## Design captures

The design capture suite in `UITests/DesignCapture/` screenshots screens and sheets for design review, each in Dark
and Daylight. `DesignCapture.swift` holds the shared base: launch, capture, the gym's tab and sheet navigation, and
the opt-in skip. XCTest skips every capture unless the test runner sees `WM_DESIGN_CAPTURE=1`; Xcode forwards
`TEST_RUNNER_`-prefixed variables to the runner without the prefix. Each area keeps its captures in its own file and
class, a subclass of `DesignCapture`: `ShellCaptures`, `JournalCaptures`, `ChromeCaptures`, `CoachCaptures`,
`NotesCaptures`, `RoutinesCaptures`, `WorkoutCaptures`, `LogCaptures` and `RecoveryCaptures`. The CI shards leave
the suite out and check that its guard remains.

A capture's name is its screen, then `-375` on a 375 pt phone, `-ax3` at the largest text, and its appearance:
`gym-log-end-375-ax3-dark`. A screen drawn on a Figma board starts with the board's number: `02.1-routines-dark`
and `02.1-routines-daylight` sit beside board 02.1. Every test takes its captures in both appearances, and
`captureBoard` takes one board's pair in one call:

```swift
func testRoutines() {
  captureBoard("02.1-routines", settle: 1.5) { look in
    let app = launchSignedInCoach(look)
    open(.routines, app)
    XCTAssertTrue(app.buttons["routine-proposal"].waitForExistence(timeout: 10))
    return app
  }
}
```

An empty gym opens on Coach (`openGymFromJournal(app, opensOn: .coach)`) and a gym holding routines or workouts
opens on Routines. `launchSignedInCoach` launches with `-coach-fixture`, which signs in and seeds a routine, notes, a
workout and a waiting proposal once Coach opens; `-gym-log-fixture` seeds a routine, 35 workouts and
weigh-ins once The log opens. The boards outside the app (04.x, `WorkoutCaptures`) set the simulator's appearance for each look, leave a
workout running with its Live Activity, and add the workout control to Control Center when the simulator lacks it.
A launch from the Home Screen carries no arguments, so a UI test that needs one launches first with `-keep-for-relaunch`:
every later launch without arguments takes that launch's arguments with its board restored, until a launch with other
arguments drops them (`RelaunchArguments`, simulator debug builds only).

Run one capture test, or a whole area by its class, then export it. From this directory, with your own simulator
and a fresh result path:

```sh
python3 Tools/generate_project.py
TEST_RUNNER_WM_DESIGN_CAPTURE=1 xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination "platform=iOS Simulator,name=$SIMULATOR" -parallel-testing-enabled NO \
  -resultBundlePath "$RESULT" -only-testing:WindmillUITests/RoutinesCaptures/testRoutines
python3 Tools/export_design_captures.py --result "$RESULT" --output "$CAPTURES"
```

Repeat `-only-testing:` for more tests, or name `WindmillUITests/RoutinesCaptures` for an area. The exporter writes
one PNG per capture named by the capture, `$CAPTURES/02.1-routines-dark.png`, replacing that capture's PNG from an
earlier export, and a `capture-manifest.json` linking each PNG to its test and result bundle. Two captures with one
name in a result fail the export.

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
confirm Apple's acceptance of the upload. The read-only status step then checks that archive's exact
version and build through App Store Connect for up to ten minutes. `testflight-status-RUN_NUMBER`
records `processingState`, `internalBuildState` and `externalBuildState`; a pending state remains
pending, and beta readiness does not prove a particular tester can install. No tester groups change.
If the status step fails after upload, do not rerun the release workflow: the upload already exists.
Record the verified version, build, source SHA, run URL,
upload result and any processing or symbol limitations in `WORK_LOG.md`.
