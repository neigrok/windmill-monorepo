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
On the `workout-inflight` boards, `-log-set-on-signal` logs a Pull-up set each time a UI test posts the Darwin notification
`works.windmill.fixture.log-set`, as a set logged outside the app lands under a sheet open over the workout.
`-scenario <name>` isolates a launch's storage under that name.
`-scenario <name> -report <absolute JSON path>` exercises anonymous writing, Keep, email sign-in,
backup, session revocation, same-account reauthentication, sign-out Keep, and a second sign-in. A local
server run supplies `-code-file <absolute path>` with development codes in its isolated database.
Gym end-to-end tests use `-scenario gym-e2e` (signed in) or `gym-e2e-anonymous`; for Gym, `-code-file` names a JSON native session (`account`, `token`, `email`). The verify skill's iOS gym fixtures mint it with the accounts `GymIntegrationFlowTests` reads; against a backend, `TEST_RUNNER_WM_GYM_E2E_SENTRY` names the Sentry DSN those runs report to. These simulator-only fixtures use the real engine and native UI. `JournalIntegrationFlowTests` writes, waits offline and backs up against the same isolated backend when `WM_JOURNAL_E2E_SERVER` and `WM_JOURNAL_E2E_SESSION` name it and a signed-in session; without them it skips.
Without `WM_GYM_E2E_SERVER`, conflicting-workout adoption uses `-scenario gym-e2e-conflict`.
A separate client seeds the model server through real Gym actions; atomic snapshots
preserve server rows and email sessions across explicit app relaunches. A simulator-only accessibility
value exposes confirmed rows to the same assertions used by REST verification. Missing, corrupt or
unwritable snapshots fail the fixture. With a backend configured, the test uses REST verification.
The report pauses at `revoke-session` and `signed-out`; a local verifier performs the server step and
writes that checkpoint name to `<report>.ready`. The signed-out checkpoint includes the credential
for local replay verification; the final report contains no credential.

`AppModel` coordinates one account, runtime and active replica for the rooms. The engine subscribes
gym's and journal's scopes from its iOS registry, and roadmap's where the build carries the Roadmap room
(`AppSettings.engineConfig`). Gym and Journal run their actions on the runtime's `runner`, which removes at once; roadmap's
take `roadmapRunner`, which holds a removal for the engine's nine seconds. Writes made anonymously stay
local until adoption. Occupied accounts ask one question naming every room's work by kind
(`AdoptionQuestion`): workouts, routines, weigh-ins, movements, notes, journal pages, roadmaps and Coach's
conversations, each room's other records as its changes, and what the account already holds of each room. The roadmaps
and conversations named are those made signed out that still stand (`AppModel.roadmapsMadeSignedOut`,
`conversationsMadeSignedOut`); with no roadmap standing, roadmap's work joins the account unasked, its conversations with
it, as the journal's does with no page written. One Add/Discard answers every room, persists against the exact counted work and
completes together. Changed work asks again about the room that changed. Sign-in from signed out, sign-out and account
deletion flush the rooms and then, past every check of the app's that could still refuse, the Roadmap room
(`AppModel.beforeAccountChange()`): its open note is saved and its band leaves with its Undo, since the engine releases
every held delete. The sign-out question counts every room's unconfirmed changes, each act once however many scopes it
wrote (`AppModel.signOutChanges`, so a roadmap made is one change), and keeps dormant work only for its account. A
finished sign-out also forgets which roadmap the room had open and each roadmap's view.

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
two-line row, the set row and fact tiles, the load field and reps wheel and the Fix set editor, a typed name read through its own domain rule
(`NameField.swift`: a movement's through `exercise.name`, a routine's through `routine.name`), a movement's equipment
field read through GymDomain's `Equipment` (`MovementEquipment.swift`), the rename sheet with its model extension, the one count formatter, the one date formatter (`GymDate`) and the Instant–Date bridge.

The Roadmap room ([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md), boards on the Roadmap file's iOS page) exists
where the build setting `WM_ROADMAP_ROOM_ENABLED` is `YES`: `project.yml` sets it in Debug and leaves it `NO` in Release, and
`AppSettings.roadmapRoom` reads it from the Info.plist. Without it the app has no `RoadmapModel`, no Roadmap row in the room
menu, no Roadmap door, and an engine that subscribes no roadmap scope. `Sources/Roadmap/RoadmapModel.swift` observes the
engine's views of every record of the person's roadmaps (`RoadmapModel.Records`, one view a type in each roadmap's tree scope
and in their overlay of it, the marks, the pointers and the workspace's subtasks, links and notes) and reads them through
`RoadmapDomain`: the list from `RoadmapAccount.list()`, each roadmap as
`RoadmapTree(id:listed:tree:overlay:read:)`, and the open one as `RoadmapModel.OpenRoadmap`, which holds its `BoardRead`,
every step's row by the step's id (`OpenRoadmap.step(_:)`; `Row`: the step, its card, the kind that owns its hue, and whether
the room offers Complete, Reset and Delete on it) and the person's workspace of each step (`OpenRoadmap.workspaces`, read by
`StepWorkspace.read(_:)` from the open roadmap's overlay). That one row is what a Board group, the step's own page and a row of
another step's page show. `OpenRoadmap.page(of:)` composes a step's page from it (`OpenStep`: the row, the rows of the steps
the step requires and of the steps it opens, how many of those Reset would lock again, and the step's workspace). A roadmap's
place in the list follows every record of its overlay, so a workspace changed on another device moves it up as a mark
does, as the web's list reads it. The model opens the roadmap last
open, else the most recent, and makes no request. `open(_:from:)` makes another roadmap the open one and remembers it
(`RoadmapModel.lastOpen`), and a roadmap the room made, or brought back by Undo, is opened once the list holds it
(`arriving`). The model keeps which groups stand folded, Done at rest and open by itself once every step is done, another
roadmap opening with its Board at rest, and the screens on the room's stack (`path`, each a `Visit`: All Roadmaps, a
roadmap's Activity, a step's page with what opened it, a step's note over its page, a step's History, the list a roadmap
is attached from, or a roadmap gone into, after which the screens are that roadmap's room's), which empties once a step
whose page, note, History or attach list is open goes, deleted here or by another device, once the roadmap whose Activity
is open is the open one no longer, once no step leads into a roadmap gone into (`Visit.stands(in:)`), or once the last
roadmap goes. It also holds the draft the step form stands
open on (`draft`), which it lets go once the draft's roadmap is not the open one or the step it edits is gone, and the
draft the note's screen stands open on (`note`, a `StepNoteDraft`), made as that screen is pushed and saved as it
leaves the stack, the app leaves the front or the account changes (`flush()`), and the Guide sheet (`guide`, a
`GuideSheet`), which closes once its roadmap is not the open one. And it holds the view the switch row chose of
each roadmap (`lens`, set by `show(_:)` and kept on the phone under `RoadmapModel.lastLens`, the Board until it is
switched, as the web's `ViewPrefs` keeps it), the step selected on the Graph (`selected`, set by `select(_:)`, which goes
once its step does or another roadmap opens), and the open roadmap's Graph (`graph`, a `RoadmapGraph`), which it has
follow the roadmap as the phone's copy reads it while the Graph is the view. `pick(_:)` selects a step chosen from the
Graph's *Next*, while it stands, and has the Graph bring it into view, and `fit()` and `unfit()` start and end the
Graph's Fit. `openInGraph(_:from:)`, from a Board row's long-press menu or a step page's … menu, shows the Graph with the
step selected and has the Graph bring it into view once its picture is laid out. Beside the model, and held by it, stand
what the Board asks of the open roadmap (`reading`, a `BoardReading`: the order of Up next and Locked, the kinds shown, a
branch and Find's words, which last the visit as the web's room keeps its query, so another roadmap opening or a launch
starts it over; the model tells it each read of the open roadmap and the view it shows, so Find ends once the Graph is
shown or another roadmap opens, telling words not yet told as it closes, and stays up while a step's page is pushed from
the Board and popped), the steps chosen while the Board selects several (`selection`, a `BoardSelection`, which
`startSelecting(_:from:)` makes and `endSelecting(via:)` lets go, and which goes once another roadmap opens), and what the
Board measures of itself (`boardFrames`, a `BoardFrames`). `viewBranch(of:)` returns to the Board staying in a step's
branch. The model also holds whether the Kinds sheet stands open and from where (`kindsDoor`). The open roadmap reads its
legend once (`OpenRoadmap.legend`, a `RoadmapLegend`), which the step form's Kind list, the Kinds sheet, the Board's filter
and Recolor all show.

The model's write door is `write(_:as:)`: one act of `RoadmapDomain` run on `AppRuntime.roadmapRunner`, several as one
gesture (`ActionRunner.runComposed`), each reading what the ones before it wrote, or a draft's one save
(`ActionRunner.save`, whose receipt the door answers as an act's). It answers what the write came to
(`RoadmapModel.Written`: committed with its receipt, unchanged, the domain's refusal, or failed), and tells it in one place
whoever asked (`told(as:_:)`): a refusal as an event, and in the band where it is a limit, and a failed commit as a report.
`complete(_:by:)` and `reset(_:)` run `MarkStep`; a delete is asked first
(`askDelete(_:by:)`, the question the model holds with what the delete costs and where it was asked) and, answered *Delete
Step*, `delete(_:by:)` runs `DeleteStep` and leaves the room on the Board, the form that asked closed. New Roadmap's draft
(`newRoadmap`, a `NewRoadmapDraft`) runs `CreateRoadmap`, then, for a plan, `MarkStep.complete` of the steps it brings done
as one act, and `rename(to:)` runs `WriteRoadmap`; the engine keeps no Undo of any of them. Paste Steps' sheet
(`pasting`, a `PastedSteps`) runs the plan's `ImportSteps`, with the marks it brings done, and a `CreateKind` for each kind
it adds as one act, with its Undo in the band. A roadmap's delete is asked first too
(`askDelete(_:from:)`, with what else goes) and, answered *Delete Roadmap*, `delete(_:from:taking:)` runs `DeleteRoadmap`:
the room then opens the most recent other roadmap, or holds none. `newStep(from:named:)` reads first how many steps the
roadmap holds against the registry's cap, through the kit's `Capacity`, and at the cap refuses where the gesture is
made, in the band, with no form. Each receipt is the room's one band
(`RoadmapModel.Band`), which a newer one replaces. Its Undo cancels a removal while the engine holds it
(`ActionRunner.cancelHeld`, for the engine's nine seconds) and takes any other act back by the kit's Undo of it
(`ActionRunner.undo`, for six seconds); a step's delete keeps the kit's Undo past its hold (`Band.Undo.Act.outlivesHold`),
so the band's Undo brings the step back after the hold has ended too, where a roadmap's delete and a removal from a
workspace keep none past it. When the band leaves, the engine keeps no Undo of the act (`ActionRunner.release`). An
Undo of Reset marks the step done anew, so it leads Done, and an Undo of a roadmap's delete opens the roadmap again where
the room had it open. An Undo that brings nothing back, a roadmap's delete or a workspace removal past its hold, an act
the engine keeps no Undo of, one whose every restore a write made elsewhere stood in the way of, such as another phone's
delete of the same step, or a kind's removal whose hue another kind has come to wear, which the domain refuses before
anything is written (the check `DeleteKind`'s plan names, read by `ActionRunner.undo(_:)` from the act's `UndoHandle`,
which the band keeps), puts in the receipt's place what could not come back (`Band.Says.unrestored`, boards 02.10d and
06.5c): *Couldn’t bring back* a step, a roadmap, a kind, a subtask or a link by its name, or several steps by their
count, and *Couldn’t undo* any other act. It has no Undo, stands six seconds, and the room plays a warning haptic and
VoiceOver announces it; its event keeps outcome unavailable. The band says a refusal only where it is a limit the boards
word, and any other refusal shows nothing. Facts the model reads or settles itself, as the web's room does. From the
domain's `EffectsRead` (`OpenRoadmap.effects(of:)`, which the web's room reads through `readEffects`), what a delete, a
Reset, a paste or a new link would do: the one starting step a roadmap keeps, which offers no Delete; that steps holding every step the
roadmap starts from cannot be deleted; the steps outside them that follow one of them, which a step's page lists under
*Opens* and the delete question counts; and what Reset would return to Locked (`OpenStep.relocks`), the steps a Done
step opened that stand Up next; where a paste lands (`under`); the steps a Done mark set aside while its step opens a
roadmap holds Locked, which the step's Roadmap footer counts (`OpenRoadmap.setAside(of:)`); and the steps a new link
of a step would close a loop with (`loops`), which the step form dims. From the domain's read of
every roadmap: what else a roadmap's delete takes (`openers(of:)`, the web's `OpenedTrees.openersOf` and `deleteCost`),
the steps of the person's other roadmaps whose pointer opens it, which the server deletes with it. And of a name: it is
written without the blanks around it (`name(typed:)`, the web's `NewTreeBirth.plant` and `ReplicaSession.renameTree`), and a
blank roadmap starts with one step, named as the roadmap, in the first kind's colour: the empty plan, named
(`NewRoadmapDraft.planting`, the web's `NewTreeBirth.plant`). Of a roadmap's kinds (`RoadmapLegend`), from the
domain's `LegendRead`, which the web's `model/Legend.js` reads too: its legend is each kind that owns its hue in the
roadmap's order, then each hue steps wear that no kind claims, called by the hue, each with how many steps wear it
(`steps`); the six kinds a step may wear, the named ones first (`choices`); the kinds the Board's filter offers, the
ones steps wear, none where steps wear one hue alone (`filters`); the hue Add Kind takes, the first no entry has
(`free`); and only a kind no step wears may be removed (`removable`, which `onRemoveKind` reads). And from the domain's
`BoardRead.revealing`, which reads no Board: a step the form made that the query hides is shown by clearing
each part that alone hides it (`BoardReading.reveal`, the domain's `revealing`, which the web's `BoardQuery.revealing`
reads too), once the phone's copy holds the step, whether the Board then shows a list or nothing left.

`Coach/` is Roadmap Coach in the room (roadmap-ios.md §8), which exists only where `-roadmap-coach on` launches a
simulator's Debug build (`AppSettings.roadmapCoach`, `WM_ROADMAP_COACH_ENABLED`, never in Release): `RoadmapCoach` is the
room's Coach, its composer's words and what they are about (`About`: the roadmap of the room the composer stands in, a
roadmap gone into among them, or what a conversation's record says, and whether Coach writes there), a turn sent, stopped,
recovered by its mark and a turn nobody ends ended stale, holding a question in the field while a turn is read back or the
seat changes, each direct write offered in the room's band with its Undo, which records the receipt's fate, each turn's
tool host kept while a write of it can still be undone, and the conversation, History and its delete, held with the room's
band, read from the phone's copy; `RoadmapTurnHost` is the Coach engine's tool host over
the room's runner and `RoadmapToolHost`, writing the turn's records as roadmap's acts under the turn's lease, the text at
most once a second, and at the end the facts of its calls and receipts; `CoachProfile` reads the words the bundle carries
from `packages/api-contract/roadmap/coach/` and the catalog; `CoachReceiptLine` words a receipt, as `receipts.json` holds
it; `CoachComposer` is the composer, its suggestions, the turn's step line with Stop, and the notice above it;
`CoachSheet` is the conversation sheet with History and What Coach Read; and `PlayedAiService`, Debug alone, is the AI
service a launch plays with `-coach-play` (and `-coach-allowance spent` or `capacity`), which the flows
(`RoadmapCoachFlowTests`) and captures (`RoadmapCoachCaptures`) run their turns on. A board launched with Coach runs the
phone's clock, and the model server's with it, on from the board's moment (`RunningBoardClock`), so turns asked one after
another are said in that order; `-board roadmap-signed-out` is a phone never signed in that holds *Learn to sail* with
three steps done, and `-board roadmap-coach-history` an account whose other phone had five conversations, today, yesterday
and days before, about *Learn to sail*, its *Read the wind*, every roadmap, *Spanish B1* and *Become a day skipper*.
`RoadmapCoachIntegrationFlowTests` runs against `tools/coach-e2e/room_stack.py`.

`RoadmapRoom.swift` is the room's one `NavigationStack` over the model's `path`: the room capsule and the account in the bar,
the roadmap's name and progress, the switch row pinned under the bar, whose *Board | Graph* chooses the roadmap's view,
whose Find is the Board's and whose one tool is the Board's *Sort and filter* or the Graph's *Fit*, and at the foot the
band over New step, which raises the step form. New step leaves the foot while Find is up and while several steps are
selected. While Fit stands the bar, the switch row and the foot are away and the status bar stays. It announces
and plays the band's haptic once, whichever screen stands over it. The foot's + is a button whose tap is New step and whose
context menu, on a long press, offers *New Step* and *Paste Steps* (02.16). Before the phone's copy is first read the room is its
bar alone, the room capsule and the account, and a large spinner shows once the read has run half a second
(`RoadmapRoom.FirstRead`, 01.5b), which is told, and how the wait ended: read, failed, or the room put away first; a read that fails says *Couldn’t load this roadmap* and *The copy on this iPhone
couldn’t be read.* with *Try Again*, which asks the engine for every view anew (01.5c). The title's progress is joined by
*Offline* while the engine's status says the phone has no connection (10.1). The title's menu (`RoadmapTitle`,
`.toolbarTitleMenu`) fits the screen of every iPhone (01.3): it leads with *N Set Aside* while a change is set aside
(10.5a), then lists the three most recent roadmaps by name, the open one checked, with *All Roadmaps…* and *New
Roadmap*; then two rows of tiles (`ControlGroup`), the roadmap's views *Guide*, *Kinds* and *Activity*
(`RoadmapViewTiles`, whose *Guide* reads *Guides* while guides from above apply and says how many to VoiceOver), and
*Share*, *Export* and *Rename*; and *Delete Roadmap* last. *Rename* is the system's (`RenameButton` over a
title that is a binding, before iOS 26 beside the principal title; a title menu gives `@Environment(\.rename)` no action): the bar becomes one field, and its return key
commits. A name the domain refuses leaves the old one; the field itself commits no
empty name, so the old one stays there too; and a name of blanks alone is written empty, so the roadmap reads *Untitled
roadmap*. *Delete Roadmap* asks once under the title, naming the steps of other roadmaps that open this one, and then
the band holds *Undo* for the hold's nine seconds. *Share* and *Export* are `Sharing/`'s. While several steps are
selected the title counts them, with no progress and no menu. Before iOS 26 the name and the progress stand in the bar's
principal slot (`roomTitle`) with the same menu attached; no iOS 18 runtime has drawn that menu's tiles or tried its
rename.

`Roadmaps/RoadmapsList.swift` is All Roadmaps, pushed on the stack: every roadmap in the domain's order, the open one
checked. That order is by when a server last received each, or, for a roadmap no server has received, by the newest
stamp the phone holds of it, the most recent first, so on a phone never signed in the roadmap made last comes first. A row
opens its roadmap on its Board and slides left for *Delete*, which asks on the row, never
commits by a full swipe, and leaves the list on screen under the band; past eight roadmaps the bar's drawer finds them
by name; and + names a new one. Under the roadmaps, away while a search is typed, *Planted in Public* pushes the public
gallery (`Sharing/PublicGallery.swift`). `Roadmaps/NewRoadmap.swift` is the
sheet the title menu, All Roadmaps and *No roadmaps yet* all open, over its draft (`Roadmaps/NewRoadmapDraft.swift`): a
name, held to the length the domain takes, *Cancel* and *Create*, and *Start from* (01.6) with *A Copied Plan*, the
system's `PasteButton`, and *A File*, the system's `.fileImporter` for Markdown, by the identifier the Info.plist imports
(`net.daringfireball.markdown`), and plain text. A file is read off the main actor as the web reads one, its bytes as
UTF-8 with a leading byte order mark dropped, up to 2,000,000 bytes; one that cannot be opened is named in *Start
from*'s footer (01.8c), reports, and reads nothing, as does an importer that hands back none, and one past the bound is
named there as too large to read. A plan from either is read by `RoadmapPlan` over the genesis kinds, off the main
actor, and read back before anything is written
(01.8): its counts (`Components/PlanReadBack.swift`, `PlanCounts`) and its first six steps in the states they will land
in (`PlannedStepRow`, the domain's `Planting.landing`), with *Clear*, which returns to *Start from*. An empty name field
takes the plan's name, which plants the plan under its own as the web does, a file's title with its padding; a name
typed names the roadmap and the step that stands for the plan's name, and Create plants
it, opens it and says what it planted in the band with no Undo (01.8b); a name alone plants a blank roadmap with its one
starting step and opens it. A simulator launch that names `-roadmap-file` hands *A File* the boards' plan, or a file that
cannot be read, in place of the system's importer (`RoadmapFixture.chosenFile()`, which the app hands the room's model as
`handedFile`). All of it works on the phone's copy,
signed in or out.

`Board/RoadmapBoard.swift` is the Board's list, its groups under headers that fold them, as the Board's reading keeps
them. A row opens its step's page; a step that opens a roadmap carries its pill, the roadmap's name and count with a bar
or the short words of an odd end. An Up next row that opens no roadmap slides right for *Complete*, and a row that opens
one it can go into for *Open*; every row but the kept one slides left for *Delete*, which asks once on the row with what it costs; a long press lists *Complete*, *Edit*,
which raises the step's form, *Open in Graph*, *Select* and *Delete Step*. A full swipe commits neither. The long-press
menu's other items wait for their screens and are left out: *Ask Coach*, and *Copy Link* on a public roadmap. Find, the
switch row's magnifying glass, gives the list the system's search while it is up, its field at the foot above the
keyboard with the bar and the switch row kept: the steps whose name or description holds the words stay in their groups,
each header counting its own, Done open while it holds one, and a Board left with nothing says *No steps match “…”* with
*New Step “…”*, which opens the form named so. The Board's tool (`BoardTool`) is one menu: the order (*Roadmap Order*,
*Newest First*, *Oldest First*), *Filter by Kind* with a toggle for each kind steps wear, and *Select Steps*; its symbol
fills while another order or a kind filter stands. A kind filter, and a branch from a step page's *View Branch*, say so in
the list's first row with *Clear*, and a filter left with nothing says *No steps match* with *Clear Filters*. The subtitle
counts the whole roadmap whatever the Board shows. Select and Select Steps put the list in the system's edit mode
(`BoardSelectionBar`): *Select All* or *Deselect All* and the checkmark in the bar, the switch waiting, and the bottom
toolbar's *Recolor*, a menu of the six kinds, and *Delete N Steps*, which asks once on itself with what it costs and is
dimmed while the steps chosen hold every starting step, which the band then says, at once where the selection starts on
them. *Select All* takes every step the Board's query keeps, a folded group's too, as 02.12 draws it taking the starting
step from a folded Done; the delete's question counts what it takes, which is the person's check. Recolor is one gesture
with six seconds of *Undo*, and the delete one gesture held nine seconds with *Undo*; either ends the selection, and a
step the Board stops showing is chosen no longer. `Board/BoardReading.swift` and `Board/BoardSelection.swift` are the Board's query
and its selection, each the domain's read and acts. `Board/BoardFrames.swift` measures the time from the switch to the
Board's first frame and the frames each scroll is given, on a launch that names a file for them, and reports nothing.
`Board/PasteSteps.swift` is Paste Steps, from the foot's + held (02.16 to 02.18): the room asks the clipboard whether it
holds text, which raises no prompt, and says *No text to paste* in the band where it holds none (02.16b); reads the text,
which the system may ask the person to allow, and says *Paste not allowed* with *Settings*, which opens Windmill's page
in Settings, where they did not (02.16c); and otherwise reads it into the open roadmap by `RoadmapPlan` over the
roadmap's legend, the domain's legend shown (`LegendRead.shown`), grafted under its starting step, the first in authored
order of the steps that follow nothing (the domain's `EffectsRead.under`), the grammar run off the main actor. A text that lands no step says *No text to
paste* too. The read-back is a medium sheet of its counts and each step in the state it will land in
(`Graft.landing(in:)`); *Add* writes the steps with the marks the text brings done and the kinds it adds as one act, and
the band says *Added N steps* with *Undo* for six seconds over the steps washed in their groups; an *Add* the domain
refuses leaves the sheet open, *Add* off, and says why under its counts in the room's words (`pasteWords`); *Cancel*
writes nothing. The room reads the clipboard through a `Clipboard`, which Set Aside's *Copy* writes to, the system's in
the app and a test's own in a test; the system's text is read off the main actor, which the system's question would
otherwise hold until it is answered.

`Step/RoadmapStepPage.swift` is a step's page, pushed on the room's stack: one list under the step's name, which the bar
takes once it has scrolled away; the status row, with the state, the kind's name (the hue's where no kind names it) and why
the step stands there, or on a Done step what Reset would return to Locked beside *Reset*; the description and the step's
shared links, each opened where its address is `http`, `https` or `mailto`; and *Requires* and *Opens* with their counts,
each row opening its step. A step that opens a roadmap has its Roadmap section between the two, *Subtree* for one it owns
(`Nested/`). An Up next step that opens no roadmap has *Complete* at its foot: the page stays, and the band says what
opened; one that opens a roadmap has *Open Roadmap*, *Open Subtree* or, where it cannot be found, *Choose Roadmap*.
*Reset* asks nothing. *Edit* in the bar raises the step's form over the page. The … menu holds *Open in Graph*,
*View Branch* on a step that is not Locked, as the web offers it, which returns to the Board staying in the step's branch,
*Attach a Roadmap* on a step that opens none, and *Delete Step*, which asks on the … button and,
answered, returns to the Board with the step held; the roadmap's one starting step's menu has no *Delete Step*. After
*Opens* the page lists the person's workspace of the step, and its foot is away while *Add Subtask* has the keyboard; its
last row opens the step's *History*. Left out until their screens are built: the menu's *Copy Link* and the Coach circle
and composer.

`Nested/` is a step that opens a roadmap ([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md) §6, boards 04.6 and
07.1 to 07.12b). `OpenedRoadmap.swift` is what a row holds of the roadmap its step opens (`RoadmapModel.Opened`, from the
domain's `OpeningRead`): the roadmap, whether the step owns it as its subtree, the one of the web's faces it comes to
(open, complete, empty, loop, missing, unread; a pointer at a roadmap the phone holds no copy of, or one that is not the
person's, reads as missing), its name and count, and the words the Board's pill, the Graph's line, the page's Roadmap
row, its status row, its footer and its foot say of it. A step that opens a roadmap is complete as the roadmap is, so it
takes no *Complete* or *Reset*, and a Done mark made by hand is set aside while it opens one that is not complete, which
its footer says with the steps that lock again (`OpenRoadmap.setAside(of:)`, the domain's `EffectsRead.setAside`). `RoomStack.swift` is the room's one stack: going in (`goIn(_:by:)`) pushes a `Visit.roadmap`
on the room's path, and the room makes the roadmap a room of its own (`inside`, in the role `.inside`, one deeper than the
room it was gone into from, `outside`), which reads the phone's copy as that room last read it and holds its own Board,
Graph, step pages and sheets. A roadmap a room on the stack already shows is gone into no deeper (`goesIn(to:)`), so a
loop is gone round once. The root's stack is every room's path in turn (`stack`, each visit a `Stacked` by its depth),
and a screen keeps the room it last found while it slides away (`RoadmapScreen`). A room whose visit leaves the stack
goes, however many Back passes at once: each from the deepest first, its note saved and its Back told (`cameBack(from:)`),
and the app leaving the front or the account changing saves the note of every room on the stack (`flush()`). The band is
the stack's one, kept by the root's room, so going in or back leaves its Undo standing, and the sheets stand on the
stack, raised by the room on top (`deepest`). `NestedScreens.swift` is the pill (`OpeningPill`), the page's section
(`OpenedSection`), with the owner's … menu of *Change Roadmap* and *Detach Roadmap* over the row, the foot's control
(`OpenedPrimary`), and a roadmap gone into (`RoadmapInside`): Back, its name over its progress and a … menu of *Guide*,
*Kinds* and *Activity* as the title menu's tiles, over *Export*; one the phone has yet to read waits with a spinner, or with no connection says *Needs a
connection*. `AttachRoadmap.swift` is the list a roadmap is attached from, pushed from the page as `Visit.attach` and
from the step form's Roadmap row: the person's roadmaps found by name, the one the step stands in dimmed, the one it opens
checked under *None*; a choice on the page runs `PointStep` at once (`attach(_:to:)`, `detach(_:)`), each with *Undo* for
six seconds, a refused one saying why under the list, and in the form sets the draft, which its save writes. A pasted link
to one of the person's roadmaps or a subtree of one chooses it (`ownRoot(of:)`), and one to the roadmap the step stands in
is refused in its row's words; to someone else's, `PastedRoadmap` follows its tree scope through the engine while the list
stands and names it above theirs with *Fork Roadmap*, which needs a connection, its band says so otherwise, and a
session, signed out *Sign In to Fork* raising the shell's sign-in; to none they can read, the list says so under the
pasted row. A reader's cover shows the section with no door and no menu, the subtree counted as the owner's progress
tells it.

`Activity/RoadmapActivity.swift` is a roadmap's Activity and a step's History (boards 01.13, 01.13b, 01.15 and 03.12),
each pushed on the room's stack, from the title menu's *Activity* and from a step page's *History*. Both show the
domain's `ActivityRead` of the open roadmap as the phone's copy reads it: each step's creation and completion the copy
holds a time for, newest first, each at the time the person did it, the device's, and the server's receipt only where
the copy holds none ([the shared cases](../../../packages/api-contract/roadmap/domain/activity.json)), so
they make no request, read the same signed out and with no connection, and show a change made elsewhere once the copy
holds it; the model reads it once for each read of the copy (`RoadmapModel.activity(of:)`). `ActivityDays` lays the rows
out under Today, Yesterday and Earlier, by the engine's clock in the phone's zone (`RoadmapModel.moment`, which a midnight
passing lays out again), Today's and Yesterday's at their clock time and Earlier's at their date, the year only for
another year; on Activity more than three steps added within a minute of the first of them fold into one
`DisclosureGroup` row, *12 steps*, which a tap opens in place, told with its steps as a bucket, and which stays open as a
step lands within that minute. An Activity row is the step's symbol, a plus for a
creation and a check for a completion, in its kind's colour, its name and its time, and opens the step's page, which its
event tells with door activity; VoiceOver reads *Completed Rig the boat, 9:12*, and the fold *Added 12 steps, 8:02*. A
roadmap with no step says *No activity yet*. History is the same read narrowed to the step, *Completed* and *Added* with
their times under the step's name, and opens nothing. Opening either is told with what its read came to.

`Landing/` is what the room says of a change that met one made elsewhere and the one list of what could not land
([Roadmap on the sync engine](../../../docs/foundation/roadmap-on-the-engine.md) §6, boards 10.2 to 10.5c). The model
reads sync beside its records through `RoadmapModel.Sync`: the engine's status for *Offline*, roadmap's `NoticesView`,
which the person's own room holds so it stays live and observed, and a notice's dismissal; a reader's cover and a test
that tells nothing of them read `Sync.none`. The root's room keeps all of it in one `RoadmapModel.Landed` (`Landed.swift`),
which an account change empties. Each room reads the domain's `LandingRead` of the roadmap it shows, after every read,
into lines (`Landed.Line`): a step the person made or linked that now follows something else through a step deleted
elsewhere before their change landed, and a step their change brought back, the second once the server's revival has
brought its name, since a step the phone knew only by its spent id holds no more than the change wrote until then. A
line no board words, of a step that follows nothing past the deleted one or one whose removed step's name the note never
kept, stays in the note untold. One place offers the band the next line waiting of the roadmap on top of the stack
(`offerLanding`), whenever the band frees, a line is heard, the room comes before the person (`faces`: on screen, in the
foreground, under no sheet of the shell's) or the stack changes, and a landing band of a roadmap no longer on top leaves.
The line is told only once its band is drawn (`seen`, from the band's own view): a foot draws the band only where it can
be seen (`drawsBand`), not while it is away and, on the room's own screens, not under a sheet or a cover the room raised
(`raisesSheet`). Its *Show* pushes the step's page, whose footer under the status row says the step's lines while its
roadmap stands on the stack, and tells one the band has not yet. A line told is let go from the phone's note by the
domain's `ClearLanding`, out of the Undo stack, so a later launch is quiet, and the note of a roadmap that leaves the
person's list goes whole. `SetAside.swift` is the one list: roadmap's notices read through the domain's `CannotLand`, each
change with words of the person's under the roadmap its notice's scope names and its reason, named by what it wrote or
by the name the room last read since the account last changed (`Landed.remembered`), the phone keeping nothing of a
roadmap deleted elsewhere; a note goes by its step's name. Its sheet, from the title menu's first row, groups the changes
by roadmap with the reason as the footer; a row's … menu and its trailing swipe offer *Copy*, every word the person
wrote, and *Discard*, which asks nothing and dismisses the notice; *Discard All* asks once on its row; the sheet closes
once the list holds nothing. Each change that cannot land is told once on this phone, by the ids of the notices it has
told that the engine still holds (`RoadmapModel.toldNotices`), which signing out and deleting the account clear.

`Step/StepWorkspace.swift` is a step's private workspace as its page reads it, and its acts. `StepWorkspace.read(_:)`
composes every step's workspace from one overlay's records, as the web's room does (`HeldRoadmap.workspace`): the
subtasks and the links in the order of their overlay's lists, a link only where its address is one a page opens, and
the note the overlay draws. `LinkAddress` reads an address as the web's room does: a page opens http, https and mailto
(`SAFE_URL`), and an address a person types takes https where it names no scheme and is a link once it is a web address
with a host (`workspaceLink`); it is stored as Foundation spells it. The acts are the room's, each one act of the
domain through the write door under the write name `workspace`: `addSubtask(_:to:)` (`AddSubtask`, the words without
the blanks around them, nothing for blanks alone), `toggle(_:)` (`ChangeSubtask`), `remove(_:)` (`DeleteSubtask`,
`DeleteStepLink`) and `addLink(_:titled:to:)` (`AddStepLink`). The band offers *Undo* where the web's page does and
where the engine holds: a subtask checked says *… checked* with *Undo* for six seconds (the web's `checkedToast`),
which leaves once the subtask is unchecked, and a subtask or a link removed is held nine seconds with *Undo*; an add,
an uncheck and a note's save keep none, as the web's room keeps none (`ReplicaWorkspace`). Every record of the
workspace is the overlay's: nothing of it is written to the roadmap's tree scope.
`Step/StepWorkspaceSections.swift` is the workspace on the page: *Subtasks* with its count and *Only you*, each
subtask a `Toggle` drawn as a ring that VoiceOver hears as a switch, *Add Subtask* a field in the list whose return key
adds a subtask and keeps the field, and *All subtasks done* under the list once every one is checked, whatever group
the step stands in, which completes nothing; *Note*, a row of the note as the page reads it that opens the note's
screen, or *Add Note*; and *Your links*, each row opening its address, over *Add Link*. A subtask and a link slide left
for *Delete*; a full swipe commits neither. The file also holds the link row every list of links draws (`StepLinkRow`)
and New Link (`NewLink`), the two-field sheet both the page and the step form raise: *Add* waits for an address
`LinkAddress(typed:)` reads, and each field stops at the domain's limit.
`Step/StepNoteDraft.swift` is the note's draft, the kit's one `Draft<StepNote>` of the step's note, opened on what the
overlay draws or new, saved once through the door under the write name `note`, and opened again on what another device
wrote while it holds nothing unsaved; a draft that does keeps the person's words, which the engine merges at its save.
The file also holds `NoteText`, the dialect the web's page writes and reads (`renderMarkdown`, `formatNote`): a line
that starts with a dash is a list item, and within a line `**bold**`, `*italic*` and `[words](address)`, read a code
point at a time as the web's patterns read them. `Step/RoadmapNoteEditor.swift` is the note's screen, pushed over the
page with the keyboard up and *Done* in the bar. On iOS 26 its field is the system's formatted editor
(`TextEditor` over an `AttributedString`): a selection's *Format* menu sets words bold or italic, the field shows them
so, and each change is written back to the note's text between the web's marks; a link the phone opens shows as its
words, and every other mark stands as it is written. The field takes a font and a link alone, so the menu offers
*Bold*, *Italic* and *More…*, the system's panel of typeface, size and colour, and no Underline; the note's text keeps
bold and italic alone. What the dialect cannot hold is written plain: bold and italic at once is written bold, and bold
or italic words that hold an asterisk lose their marks. The system's menu offers no link and no list, so on the phone a
list item is a line typed with its dash and a new link is typed with its marks. Before iOS 26 the field edits the
note's text as it is written.
`Components/RoadmapStepRow.swift` is the row every list of steps draws and the words a step is said in;
`Components/RoadmapChrome.swift` is the foot every screen of the room stands on (`roadmapFoot`: the band over the screen's
own control), the band's words, the delete question a step's Board row, its page and its form ask, and the one both the
Board's title and a roadmap's row in All Roadmaps ask.

`Graph/` is the Graph, the room's one custom part (boards 04.1 to 04.5; [Roadmap on iOS](../../../docs/foundation/roadmap-ios.md)
§5). `GraphPicture.swift` is a roadmap's picture as `RoadmapLayout` draws it: the steps the domain reads, each with what
it follows through any step that is gone and whether it is done, their seats, tiers and bows, and each step's caption
wrapped under the canvas's 13 pt semibold. It is made off the main actor; the seats and tiers are the layout's and the
picture decides neither. A picture made after another borrows its seats and captions where only a step's being done
changed. `GraphCamera.swift` is the camera: the world point at the canvas's centre and the zoom, opened where the
layout's `fitFrame` puts it and held between the layout's zoom floor and the web's pinch ceiling of 2.5, with the
roadmap's box never out of what the bars leave. It keeps the place a move left it at, and over another canvas or other
bars holds a copy of that place, so a band or a keyboard that comes and goes leaves the picture where it was. `centred(on:)` is the camera brought to a seat, the seat at the centre
of what the bars leave and no farther out than the phone's working zoom, and `GraphCamera.Glide` the way there: 0.48,
0.6 or 0.72 s by how far the centre travels, under the web's easing, as a pinch about the one point of the canvas at
which both ends show the same place, or a pan between two ends at one zoom. `GraphDrawing.swift` draws one frame into a
`GraphicsContext`: the
connectors, 2 pt at the phone's working zoom and lit where they leave a done step; the discs in the kit's forms, each a
share of the body the layout gives a step, a crowned root 1.55 times wider; the selection ring; and each caption in the
box the layout gave it, once it is past its wait. It draws only what the camera holds: a connector whose curve's box
misses the canvas and a disc whose reach misses it are left out, connectors thinner than a fifth of a point are not
drawn, and each form is one path a colour. `GraphSurface.swift` is the view that draws it: the picture on one `Canvas`
under a camera, which draws again only when its drawing differs. It holds `GraphPinch`, the four ways the Graph can
keep its frames while a pinch, a finger's or a glide's, moves a crowd of more than 500 steps in view: `live` draws the
picture anew at every camera; `held` draws it only at the pinch's stops, the zooms half again apart counted from where
the pinch began, and scales that drawing to the camera between them, with no caption; `coarse` draws each disc as one
square of its colour; `layered` draws as `live` and composites the canvas through `drawingGroup` at every camera, so
the canvas stays one view as a pinch begins. Each draws what `live` draws once the pinch rests and at any camera that
holds no crowd. The room's own
is `GraphPinch.room`, which is `live`: no phone has measured the other three. `RoadmapGraph.swift` is the Graph's state,
which the model owns: it lays the
picture out off the main actor, one layout at a time and only the latest read next, keeps the camera where a person left
it when the picture, the canvas or its bars change, asks the layout's `CaptionPlacer` for the captions at each camera and again when the next
caption is due, answers which step a tap takes (the nearest whose disc, or whose 44 pt target where the disc is
smaller, holds the point), holds the pinch under way with the camera it began from and the point it zooms about, glides
the camera to a step (`bring(_:)`) and to the whole roadmap (`fit()`), at once under Reduce Motion, stops a glide where
it has got to (`halt()`) once Fit ends or a tap selects another step, and keeps the whole roadmap framed while Fit
stands. The room reads `framed`, whether there is a camera, and never the camera, which changes every frame. It measures the Graph against the budget: the first frame after the tap that showed
it, and the frames a display link sees while a gesture or a glide moves the camera (`GraphFrames`).
`RoadmapGraphCanvas.swift` is the
view: the surface under the room's bars, a `DragGesture` and a `MagnifyGesture` that move the camera, and a tap that
selects, or under Fit brings the bars back. Beside it are the two bars of the foot's band slot: `GraphNextBar`, *Next*
over the first Up next step with a menu of every Up next step in Roadmap Order, shown while no step is selected and
one is Up next, whose pick selects a step and brings it to the centre of the canvas; and `GraphStepBar`, the selected
step, which pushes the step's page. VoiceOver hears the
canvas as one element, *Graph*, with the roadmap's progress and the hint that the Board lists every step, or under Fit
that a tap brings the bars back. A step that opens a roadmap wears the stack mark before its caption and the
roadmap's line under it (`RoadmapGraph.marks`). Left out until their screens are built: Find on the Graph and a
proposal's changes.

`Sharing/` is a roadmap's link and a shared roadmap's cover, Share, Export and the public gallery ([Roadmap on
iOS](../../../docs/foundation/roadmap-ios.md) §3, §4, §7.3 and §7.4, boards 09.1a to 09.12b). The app claims the site's roadmap addresses in Debug builds alone: `project.yml` selects
`Tools/Windmill-Debug-NO.entitlements` or `-YES` for Debug, each its Release twin with `applinks:windmill.works` added,
and Release's carry no associated domain. A `RoadmapModel` is made in a role (`RoadmapModel.Role`): the owner's, with
the links the room follows (`RoadmapLinks`), or a reader's, with the read of one roadmap someone else shared
(`SharedRead`), whose acts all refuse at the model's write door. `WindmillApp` hands a browsing activity's address to
`AppModel.open(roadmapLink:)`, once the model is made where the address came first, which switches to the Roadmap room,
and `RoadmapLinks.follow(_:in:)` follows it (a `ClaimedLink` named by the domain's `RoadmapAddress`) once the room has
read the phone's copy and the person's list has arrived, or no connection can bring it: their own roadmap opens on its
Board, or with the page of the step it names pushed, and a subtree of theirs on the roadmap it stands in; an address
that names no roadmap opens All Roadmaps; any other raises a `RoadmapCover` over the room as a full-screen cover
(`RoadmapLinks.cover`), closing one that stands, which stays where it shows that same roadmap. A cover holds a room in
the reader's role, which its `SharedRead` reads: the roadmap's tree scope, and each one above it as their metas name
them, followed through the engine (`RoadmapCover.Sources`) and let go as the cover closes, with the owner's progress from
the backend (`RoadmapSharing.progress`, an `OwnersProgress`), or the steps' own seeds where that read fails, as the web's
room falls back. The cover follows no subtree its steps own: the account counts each as that answer's `subtrees` row tells
it (`RoadmapAccount(_:told:)`), so a step that owns one is Done once every step inside is, as on the web's cover. The
room's switch row (`SwitchRow`), Board, Graph, step page and History draw it, the `OpenRoadmap` offering no Complete,
Reset or Delete, and the Board and the page leaving out what the boards do not draw there: swipes, the long-press menu,
*Select Steps*, New Step, *Edit* and the workspace. Every screen on the cover's stack finds the cover in its environment,
for Fork at its foot and the page's *Copy Link*, the step's share address on the pasteboard. A cover lands on the Graph,
keeps no view on the phone, and opens the step its link names once. Its bar holds the close button, the roadmap's name
over *Shared roadmap* and its progress, and the share's address in the system's share sheet. Until the copy holds the
roadmap and the progress has answered it is its close button and a spinner; with no connection and no copy it says
*Needs a connection* with *Try Again*, and asks again by itself when the connection returns; a roadmap read and holding
nothing, or one the engine answers gone, says *This roadmap can’t be opened*, with *Sign In* signed out; and a copy that
could not be read says *Couldn’t load this roadmap* with *Try Again*. `ForkFoot` stands at the foot of every screen of a
cover but a subtree's, which the server does not fork, as the web offers no Fork there: Fork needs a connection, so with
none it is dimmed and the band slot says *Forking needs a connection.*; it needs a session the phone can send as now, so
signed out, while the session waits to be renewed, or when the server answers 401, the cover asks for the shell's
sign-in, a sheet of its own (`AppModel.signIn(for:)`, `Sheet.roomSignIn`) that leaves the journal's offer to keep its
pages as it was. A sign-in closed with no fresh session ends the fork; a fresh one follows the link again, so the
person's own roadmap opens in the room, and on someone else's the fork runs. Fork asks the backend
(`RoadmapSharing.fork`, one request id a cover, so a fork asked again answers the same copy) and shows *Forking…*,
taking no second tap. The room opens the copy once its list holds it, on its Board with the band *Forked · N steps
planted* and no Undo, and the cover closes then, or after fifteen seconds, leaving the room to open the copy when it
lands. A fork that comes to nothing says *Couldn’t fork this roadmap. Try again.* in the band slot. A fork is one
`RoadmapFork` for the roadmap it copies, which the cover, the attach list and each gallery row hold: what it needs, its
request and what it tells, its holder deciding what the copy does. `SharingRequests` makes the three requests over HTTP
with the account's token; a 503 is the server busy, and a request given up is no failure.

Share (`RoadmapShare.swift`, 09.1a to 09.2b) is a medium sheet the title menu's *Share* raises over a root
(`ShareSheet`, which the room holds as `share` and lets go once another roadmap is open); a roadmap gone into has none.
Its one switch, *Public link*, reads the roadmap's `visibility` from the phone's copy and writes it by the domain's
`SetVisibility` through the room's write door, `public` on and `private` off, with no Undo and nothing to confirm, and
shows the choice at once while the phone's copy is read again; the
server then writes the reach of the roadmap and of every subtree under it. The switch needs an account and a connection:
signed out it is dimmed, the footer says *Sign in to share a roadmap.* and *Sign In* at the sheet's foot opens the shell's
sign-in over the sheet (`AppModel.RoomSignIn.share`); offline it is dimmed and the footer says *Sharing needs a
connection.* Otherwise the footer is the one sentence true now, naming subtrees where a step owns one. While the roadmap
is public, with a connection or without, *Share Link* hands its share address (`/t/<id>` on the site,
`RoadmapCover.Sources.address(of:)`) to the system's share sheet and *Copy Link* puts it on the pasteboard. Export
(`RoadmapExport.swift`, 09.3, 07.11b), in the title menu and in a roadmap gone into's … menu, writes the open roadmap by
the domain's `PlanFile(_:in:)`, the plan grammar's file of the phone's copy as the room shows it, and hands it to the
system's `.fileExporter` as `RoadmapMarkdown`, named as the roadmap and typed `net.daringfireball.markdown`, the
identifier the Info.plist imports; New Roadmap's *A File* reads it back to the same steps. It asks nothing of a server. A
simulator launch that names `-roadmap-export` has Export write the file there in place of the system's exporter
(`RoadmapFixture.exportFile()`), which `-roadmap-file` of the same name then hands *A File*. Planted in Public
(`PublicGallery.swift`, 09.12a, 09.12b) is pushed from All Roadmaps as `Visit.gallery`, its `PublicGallery` held by its
screen alone, so nothing of it outlives the screen: the backend's gallery (`RoadmapSharing.gallery`, `GET /v1/gallery`,
an account's token where there is one, read again with none where the server no longer takes it), 24 rows a page in the
server's order, the next page read as the last row comes on screen. A later page whose cursor the server no longer knows
is never asked for again: the gallery is read from its start, the rows on screen kept in their order. What a page says
of the person is the session's it was read under, so a sign-in, a sign-out or another account reads the gallery again
and drops the copies its forks answered; a fork a sign-in was for goes ahead only then, once the person's list has
arrived, and a row that turns out to be theirs opens in the room. A row shows its roadmap's title over its step count
alone and opens its roadmap as its link does, the person's own in the room and anyone else's on a cover; at its trailing
edge it says *Listed by you* where the page says `mine`, offers *Open Your Copy* where the person's list holds a roadmap
forked from it (the first in the list's order, by its `meta.forkedFrom`) or a fork from the row has answered one, which
opens the copy on its Board, at once or once it has arrived, and otherwise *Fork*, the cover's fork in the gallery's
mode, whose band says when it forked nothing. A first page that came to nothing says *Can’t reach the gallery just now.*
with *Try Again*, a later one says it under the rows, and an empty gallery says *Nothing on the wall yet*.

`Step/StepDraft.swift` is the step form's draft, which `newStep(from:)` and `edit(_:)` make and the model holds while the
form is open: what a person sets of a step (its name, description and kind, the steps it requires, the steps it opens,
the links it shares and the roadmap it opens) beside what the step held as the form opened, so `isChanged` and `commits` say what *Create* or
*Save* would write. A new
step's id is minted as the form opens. `save()` is the draft's one write, through the model's door as one gesture:
`CreateStep` with what the step requires and the links it shares, then `ChangePrerequisites` on each step it opens, then
`PointStep` where it opens a roadmap; or, for a step, `ChangeStep` with the fields that differ, its shared links written
whole where one was added or removed, `ChangePrerequisites` for each link between steps taken or dropped, the ones dropped
first, so the domain reads every loop over those links as they will stand, and `PointStep` where the roadmap it opens
changed. A step that owns a subtree keeps it: the form names it and changes nothing of it. The draft lists every link the step shares, whatever its address, so a save
drops none, and offers no more at the domain's 32. Written, the form closes and the band holds *Undo* for six
seconds, which takes the whole gesture back; a new step's group opens on the Board, which scrolls to the step and washes
it while the band stands. Refused or failed, the form stays open. What a name, a description and a link may be, and every
refusal of the save, are the domain's. Seven facts the draft settles itself, as the web's editor does: a new draft starts
on Sky (`DEFAULT_DRAFT_COLOR`); a step needs a name, written without the blanks around it (`StepDraft.validate`,
`CreateStepRequest`, `SaveFieldRequest`); a field stops at the domain's limit, 200 characters of a name and 16,000 of a
description; the group the step would land in and the steps not done that keep it Locked (`StepDraft.placement`); the six
kinds, the roadmap's named ones first (`kindChoices`); a list's order, done, up next, then locked, each in the roadmap's
order, and its search by name (`PrerequisiteChoices`); and the steps that would close a loop (`blocked(_:)`, the
domain's `EffectsRead.loops` over the links the draft holds, which the web's `blockedPrerequisites` reads too), so a step
cannot require what comes after the steps it opens, nor open what comes before the steps it requires. The web's form has
no *Opens*.
The draft's two refusals of its own stand in a footer and are told as a refused write is: a name typed and then cleared,
and a tap on a step that would close a loop. A loop the domain refuses at the save is named by the first step chosen that
closes one.

`Step/RoadmapStepForm.swift` is the form: a large sheet with its own stack, which `RoadmapRoom` presents over the Board or
over a step's page while the model holds a draft. Name and Description, then *Kind*, *Requires*, *Opens* and *Roadmap*,
each a list pushed inside the sheet and bound to the draft, with no Apply (*Roadmap* is the attach list of `Nested/`): *Kind* returns with the kind chosen, and a tap in
*Requires* or *Opens* takes or drops a step in place, the steps chosen as the list opened heading it under *Selected*.
Under *Kind*'s six choices *Edit Kinds* raises the Kinds sheet over the form.
The steps that would close a loop stand dimmed in their own group, whose footer says why; they are drawn dimmed and not
disabled, so a tap on one can be refused and named. Under the links one footer says where the step will land, always
for a new step and for a step only where the change would move it to another group. *Cancel* closes an unchanged draft
and asks *Discard draft?* on a changed one, which a swipe down does not send away; *Create* needs a name and *Save* a
change. A step that may go has *Delete Step* in the form, which asks there as its page does. The room's band stands at
the sheet's foot, away while a field has the keyboard. Under the placement footer *Links* lists the links the step
shares, each sliding left for *Delete*, over *Add Link*, which raises New Link over the form; a link there only stands,
and opens on the step's page. Left out until its screen is built: Coach's composer.

`Kinds/` is a roadmap's kinds. `Kinds/RoadmapLegend.swift` is the legend the open roadmap reads once. `Kinds/KindActs.swift`
is the Kinds sheet's acts, each one act of the domain through the door, on an entry by its subject as the legend holds it
when the act is made, so a kind a step has come to wear is not removed: Add Kind ends the band standing over the sheet
and makes a kind at once, unnamed, on the first hue no entry has (`CreateKind`); a name and a description, each held to the domain's 24 and 80 characters, are written as their field
leaves them (`ChangeKind`), and a hue no kind names that is given one becomes a kind wearing it (`CreateKind`); a free hue
chosen recolors the kind and every step that wears it (`RecolourKind`, the server's command, predicted on the phone), or
moves the steps of a hue no kind names in one gesture (`ChangeStep`), with no band; and a kind no step wears is removed at
once (`DeleteKind`), the band holding *Undo* for six seconds, since the engine does not hold a kind's removal; that Undo
brings the kind back only while no other kind wears its hue, as the delete's plan checks. Add, a name,
a description and a colour keep no *Undo*, as the web's legend keeps none. `Kinds/RoadmapKinds.swift` is the sheet, a large
one with its own stack, which the room raises from the title menu's *Kinds* and the form from *Edit Kinds*: the legend
under the roadmap's name, each entry with its disc, name, description and how many steps wear it, pushing its page; *Add
Kind* while a hue is free, which opens the kind's page with Name focused once the phone's copy holds it, and at six the
footer saying why it is gone; and the system's edit mode and swipe, which remove only a kind no step wears, the footer
then saying why the others cannot go, and a removal refused leaving its row. A kind's page is a settings-style form with
no Save: Name, *What belongs here?*, and *Color*, the six hues as an inline picker, a hue another entry has dimmed with
whose it is. While the entry a name or a colour moved it to is still to be read, the page draws the entry it read last
(`LastRead`, as a step's page does while it leaves), so its form and the keyboard stay. The band stands at the sheet's
foot.

`Guide/` is a roadmap's guide (boards 08.1 to 08.5). `Guide/GuideSheet.swift` is the sheet's model, which the title
menu's *Guide* raises (`RoadmapModel.openGuide()`): the open roadmap's guide as the phone's copy holds it, and the
guides of the roadmaps above it, which the domain's `RoadmapAccount.guides(_:)` reads with it, at most eight, and the
open roadmap holds nearest first and equals in id byte order (`OpenRoadmap.guidesAbove`, by each guide's `distance`),
so the guide the person writes stands first; the menu's item
counts them (*Guide · +1 from above*). *Edit*, or *Add Guide* on a roadmap with none, opens one draft of the guide
(`GuideDraft`), which keeps every character typed but a NUL, which a guide cannot hold, and counts them as the domain
counts a guide, in code points: from 4,500 of the domain's 5,000 the footer says how many it may still hold, and past
them how many it is over, which is refused there and told once as it goes over. *Save* waits for a change that fits,
writes the draft once by the domain's `WriteRoadmap` through the door under the write name `guide`, a blank draft
writing no guide, and the band then says *Guide saved* or *Guide removed* with *Undo* for six seconds, which restores
the guide as it was; until the phone's copy is next read the sheet reads the guide it wrote. *Cancel* leaves an
unchanged draft at once and asks *Discard draft?* on a changed one. A draft with no change follows the guide another
device writes; one with a change keeps the person's words, which its save writes over the guide, told as a conflict.
`Guide/RoadmapGuide.swift` is the sheet, a large one with its own bar: read, the guide as one column with, where the
phone is signed in, who else reads it, then each guide from above under its roadmap's name, read-only, and the room's
empty view with *Add Guide* where the roadmap has no guide of its own; writing, one field over the draft with the keyboard
up, *Cancel* and *Save* in the bar and the counter in the footer, in ink past the limit. A swipe down does not send a
changed draft away. The band stands at the sheet's foot, away while the field has the keyboard.

A roadmap with no step says *Your first step* over *New Step*, which opens the form as the foot's + does, under the Graph
as under the Board, and one with every step done says so over Done. A finished Board's *Share* is drawn disabled. Debug
simulator boards
(`RoadmapFixture`): `-board roadmap-empty` opens the room on a phone that holds no roadmap; `-board roadmap-learn-to-sail`
signs the phone in to an account whose eight-step roadmap another phone planted on the model server, three steps done a second
apart and *Read the wind* sharing one link, so it arrives by sync; `-board roadmap-all-done` is that roadmap with every step
done; `-board roadmap-no-steps` is *Night sailing*, with no step; `-board roadmap-several` is that account with two
more roadmaps, each received a second after the one before so the list has an order: *Learn to sail* the most recent,
then *Spanish B1* with the steps 01.11 draws, and *Become a day skipper*, whose step *Learn to sail* opens that roadmap
by its pointer; `-board roadmap-workspace` is *Learn to sail* with the workspace the boards draw on *Read the wind*, two
subtasks, the first checked, a note and one link, planted by the account's other phone; `-board roadmap-two-phones` is
*Learn to sail* whose account's other phone stays on the model server until the room has a step's page open, then adds
the subtask *Ask about the tide table* to that step;
`-board roadmap-guide` is *Learn to sail* with the guide 08.1 draws, `-board roadmap-guide-long` with a guide 15
characters short of its limit, which ends as 08.3 draws it, and `-board roadmap-guide-above` is `roadmap-several` with
that guide and *Become a day skipper*'s; `-board roadmap-sign-in` leaves the phone signed out, its room holding no
roadmap, beside the account `roadmap-fixture@example.com`, which holds *Learn to sail*; `-board roadmap-unconfirmed` is
*Learn to sail* after the server stops answering, its last five steps completed on the phone, so the account has not
confirmed them; `-board roadmap-many` is a phone never signed in that holds the nine roadmaps All Roadmaps draws,
*Learn to sail* the one last open, listed in the order of their ids: no server has received them, and the board's clock
stands still, so the newest stamp the phone holds of each is of one millisecond; `-board
roadmap-handbook` is a phone never signed in that holds *Coastal navigation handbook*, the 5,000 steps, links and colours
of the layout's shared fixture, read from the repository the build was made in and planted through the domain, so its
steps' ids are the phone's, with the first 120 of the fixture's 1,800 done steps marked, since signed out each mark's
commit reads everything the phone has still to send; `-board roadmap-full` is a phone never signed in that holds *Every
harbour in Europe*, as many steps as the registry lets a roadmap hold, each harbour entered Up next and its berth Locked
behind it; `-board roadmap-unreadable` opens the room over views it cannot make; `-board roadmap-unwritable` is a phone
never signed in that holds *Learn to sail*, whose store fails every commit once it is planted, as a full disk would; and a
shared roadmap's covers
(`RoadmapFixture.prepareCover`): `-board roadmap-cover` has another account plant *Learn to sail*, complete three steps
and make it public, signs the phone in to an account of its own and opens the roadmap's link, and
`-board roadmap-cover-signed-out` opens it signed out; `-board roadmap-cover-offline` opens it with no connection;
`-board roadmap-cover-private` and `roadmap-cover-private-signed-out` open the link to it left private; and
`-board roadmap-cover-no-connection` opens a link with no connection to a roadmap the phone holds no copy of. Nested
roadmaps (`RoadmapFixture.prepareNested`): `-board roadmap-nested` has another account make *Reefing course* public and
puts its link on the pasteboard, and another phone of the person's account plant *Learn to sail* with three steps done,
*Become a day skipper* as the boards draw it (`plantSkipper`), its *Learn to sail* opening *Learn to sail*, and *Spanish
B1* and *Coastal navigation handbook* far smaller than the boards count them, a second apart so the list stands as 07.6
draws it, and opens the room on *Become a day skipper* signed in; `-board roadmap-nested-offline` is the same with no
connection for the board's requests; `-board roadmap-nested-signed-out` plants the person's roadmaps on the phone itself,
never signed in; `-board roadmap-nested-done` has every step of *Learn to sail* done; `-board
roadmap-nested-unattached` is the same whose *Learn to sail* opens no roadmap yet; `-board roadmap-nested-odd` is the
boards' variation whose *Learn to sail* opens a roadmap that leads back, *Night passage* one with no steps and *Log 100
miles* one no phone holds; and `-board roadmap-nested-subtree` the variation whose *Night passage* owns a subtree of five
steps, one done. On the cover's and the nested boards the board's own requests stand in for the backend's
(`RoadmapFixture.BoardSharing`): the owner's progress is read from the owner's phone, each subtree counted as the owner's
account reads it, and a fork is made by another phone of the reader's account, so the copy arrives by sync;
`-fork-held` leaves a fork unanswered. The gallery's boards (`RoadmapFixture.prepareGallery`): `-board roadmap-gallery`
has another account make *Run a 10k* and *Room makeover* public and another phone of the person's account plant
*Spanish B1*, signs the phone in, and has the board's gallery answer the rows 09.12a draws five to a page, *Spanish B1*
the person's own; `-board roadmap-gallery-unreachable` answers no page, as with no connection. Section 10's boards (`RoadmapFixture.prepareSync`) have another phone of the
person's account plant their roadmaps, sign the phone in, and once the room has read them, take the model server's
connection from the phone (`BoardConnectivity`, the connection every model-server launch has, online until a board cuts
it): `-board roadmap-sync-offline` makes *Reefing basics* in the room's own form with no connection (10.1);
`-board roadmap-sync-landed` does the same while the other phone deletes *Read the wind*, lets the receipt go and gives
the connection back, so the step lands following *Name the boat parts* (10.2, 10.3); `-board roadmap-sync-came-back`
has the other phone delete *Reefing basics* and, once that has reached the phone, writes an edit of it there, which
brings it back (10.4); and `-board roadmap-sync-set-aside` holds *Winter refit* beside *Learn to sail*, *Spanish B1* and
*Coastal navigation handbook*, which the other phone deletes while the phone, offline, adds *Anchor at night* to it and
writes the note of its *Plan the watch rota*, and gives the connection back, so neither lands (10.5a to 10.5c). A
simulator launch with
`-graph-measures <path>` appends what the Graph measures of itself to that file, and with `-board-measures <path>` what
the Board measures, one JSON line a measure; with
`-graph-pinch <way>` it keeps a pinch's frames that way, and with `-graph-crowd <count>` it does so from that many
steps in view, so a way can act on a board of eight steps. With `-band-stands <seconds>` every band stands that long
in place of its six seconds or the hold's nine (`RoadmapFixture.wait()`): the flows that take a band's Undo launch with
it, so a slow runner cannot outlast the band, and the flows that watch a band leave launch without it. A flow holds
that a control not built yet is absent with `for unbuilt in [...]`, so a change that builds one searches `UITests/` for
`unbuilt` and takes it off the list, and a change to words the room shows, a subtitle or a label, searches `UITests/`
for those words too. The roadmaps
under *Learn to sail* hold a few steps
each, not the counts the boards draw, and the account's board holds three roadmaps, not nine: it is planted by a
second engine on the model server, which takes about half a second longer for every roadmap the account already
holds. A board's clock stands still, so the engine's release timer never ends a hold there: a held delete is sent once
the app leaves or launches again.

`GymModel(runner:runtime:telemetry:)` exposes engine-backed log/catalogue/routines/notes/bodyweight/
preferences/proposals, sessions/sets/openSession, account/isAnonymous/authPaused, notices,
refusal/error/readFailed, and the one unsent rule: signed out nothing is unsent; signed in,
`unsentSets(_:)` and `sessionIsUnsent(_:)` mark what the log has not confirmed while no connection, a paused session
or a refused push holds it back. Use `run(_:)` for GymDomain actions, `save(_:)` for drafts,
`dismissNotice(_:)`, and `refresh()`; `start()`/`stop()` observe engine changes. The app constructs Gym's
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
Routines, empty or not, has *New routine* as the toolbar plus beside the account button, opening the
routine editor, a Form (`docs/design/ios/routines.md`). The editor pushes the movement picker and stacks
the movement form over it: name, equipment and the dumbbell count beside the targets and rest the
movement takes in this routine. Add/Save on the form changes the routine draft; the editor's Save
commits the routine and changed exercise metadata atomically through `SaveRoutinePlan`. The editor's
Cancel discards those staged edits; the form's Cancel restores the entry draft. Exercise metadata
applies across the account, while targets belong to that routine entry. The form keeps open plans,
open reps, per-set targets and one/two-dumbbell units on stock Steppers, a decimal Load
field, a Toggle and menu Pickers. Stale metadata or a changed owner refuses the whole save. Received Other movements
retain their category and signed targets through name-only and target edits. Other uses kg without
an equipment glyph; its rack and Fix set loads take negative, zero and positive values through the ± key. The six
existing equipment picker choices remain, and the Other movement's Targets section has no basis help.

The Log groups workouts, every weigh-in and optional records by local date. Timed entries share a
chronological sequence; a backdated or legacy weight with day-only precision follows timed entries
on that day. Workouts use filled cards, weights use separated rows and records use inset markers.
Weights remain factual rows regardless of highlight limits. Workout and weight rows open their
respective detail/correction; derived records open progress and have no independent Delete. A weight’s
context menu opens the Bodyweight chart. Weigh in floats directly above the canvas.

The weigh-in sheet is a content-sized native grouped `Form`: Weight and Date in one section, a refusal as its
footer, and on a correction Delete weigh-in in a section of its own. It preserves the typed weight while a native
graphical `DatePicker` stages another day in its own section; Back cancels the date change and checkmark accepts it
without saving the weight. The calendar dismisses the keyboard and expands within the same sheet. Correction keeps
its day fixed.

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
Coach keeps the full tab bar while scrolling; the composer has no backing panel. Programmatic end
scrolling targets the content’s bottom edge, including its existing padding. Returning from a pushed
screen restores that edge only when the conversation was at its end; finger scrolling cancels the hold.
Signed in or out, `create_routine` lands on the replica under the turn and is drawn as one receipt per
routine created. The drafts card (*3 NEW ROUTINES*, each routine a heading that opens in place to its
movements as added blocks, then **Apply** and **Reject**) stands only under an archived signed-out
onboarding answer of an earlier version: Apply commits its routines and their replay receipt in one domain
action (`ImportCoachRoutineBatch`, the shared vectors' action), under a receipt key of the answer's result,
so a retried Apply returns the routines it made; an answer imported under the earlier single receipt
(`rack:coachOnboarding`) replays its routines from there, and adoption rewrites a joined routine or movement
id in every import receipt. Reject drops the drafts on this phone with *Rejected · 3 routines*, which stays
through a new chat, an opened or deleted conversation and adoption. A movement the phone does not know
yet reads *New movement*. After sign-in and *Add* the adopted conversation stays on screen, and the next
question goes to the account's seat, which can answer it with a change to a routine the conversation
created. Existing routine changes are decided on their proposal card.

Allowance refusals keep the draft, with no balance indicator: a refusal before the stream withdraws the
turn's records so the refused question stays in the field, and the refusal is drawn once, centred in
the conversation — the sentence for its code — with *Sign in to continue.* and Sign in only signed out,
where the phone's own AI allowance refused the send or its AI access belongs to an account; a shared free
day's pause and concurrency refusals offer nothing to do. A `subject_exhausted` refusal says what the
allowance its body or `error` frame carries shows holds the request: *You have used all of your AI
allowance.* with nothing left or reserved, *Your earlier AI requests hold the rest of your AI allowance
until their cost is confirmed, at most 10 minutes after each began.* with nothing left but something
reserved, *This request needs more AI capacity than your remaining allowance.* with something left, and
*Your AI allowance has no room for this request.* where no allowance came. A turn the allowance refuses
mid-way ends failed with its partial text and the sentence its frame's allowance gives. A paused shared month says
*Coach is paused for everyone this month.* over *Use your own AI agent*, and *It comes back on Nov 1.*, in the phone's
zone and date order, where the server names the moment: the refusal's allowance before the stream, the `error`
frame's own `budgetResetsAtMs` mid-way. The reset line of an
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

The live workout's ledger is a card as tall as its rows, up to the room left 8 points above the rack,
past which it scrolls; at accessibility sizes it takes the page's height. Movement paging dots and clocks
remain, without the duplicate set statistics strip. Assembly, the movement menu's Add movement and the picker share one sheet destination. Selecting a
movement returns to its live logger with existing sets and draft intact; cancellation leaves the workout unchanged.
The movement's name is its native menu: a movement with nothing logged offers Edit sets and Swap movement, every one
Add movement and Edit movement. A movement with a logged set keeps its plan. Edit sets (`Workout/EditSets.swift`) saves
the whole entry once on ✓ as `ReviseWorkoutPlan` operations; Add movement, removal and Swap write the plan and the
`rack:<session-id>` walk in one gesture (`ReviseWorkout`). After any plan edit the Live Activity's durable offer is
minted again, and the rack prefills again only when the edit moved the selected movement's current slot and the lifter
has not touched the rack since its last prefill.

The finished-workout receipt places 👑 Share with Coach and the primary Done action in two full-width rows.
A native top-trailing options menu offers Discard workout and its actual-set-count confirmation.
The bottom actions use 52-point minimum heights and 12-point separation, growing with text; the menu
and actions are disabled during account transitions. The menu uses UIKit `UIButton` / `UIMenu`, with
open events from `.menuActionTriggered`. The approved gold crown is the original-color
`gym/coach-crown` image asset. Keep and review retry remain in the scrollable receipt content. Signed
out, the phone's first receipt suggests Keep once (03.15): *Only on this phone · Keep it* under the
tiles. The phone keeps that workout's id in its preferences, so the same receipt drawn again still
suggests it and no later receipt does, signed out or in. A workout whose plan changed carries *PLAN CHANGES*
under the tiles, with a *Save to ‹routine›* switch that Done commits through `SaveRoutinePlan` while the routine stands
at its revision at the start.

`GymRoom` keeps `WorkoutScreen` as its full-screen cover through finish and receipt and, on
dismissal, consumes the workout's handoff once: a finished workout's detail opens in The log, the
receipt's Keep it opens it there with Keep over it, Share with Coach sends *Check my last workout.* in a new conversation (a
handoff belongs to the account it was asked under, so the sign-in it waited for keeps it), and
the movement picker's written-program door opens You signed out or paused, Coach otherwise.
`gym.startWorkout(routineId:)` never joins an open workout (`joinOpenSession: false`); with one
open, the start is refused and the open workout returns. The device row `rack:<session-id>` holds
the workout's movement order, selected movement and hidden status. Lifting above the plan only
logs the set; a routine's targets change in the routine editor, through Coach's proposals or through the receipt's
Save to ‹routine›. A set logged before the clock passes the latest set completes 1 ms
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
down opens the keyboard with the caret at the end. The body reserves at least three lines at the current
text size. An empty, unfocused page shows a still lamp caret. The iOS journal draws no mood or energy:
no scale rows and no ratings on earlier pages; the stored values, the domain and sync keep them, and
the Keep offer follows the first kept page. The room (`JournalScreen`, Journal · iOS 05) is one
`NavigationStack` with no tab bar: Write stands at the trailing end of the system's bottom bar, in one glass
capsule on iOS 26 and the classic bar on iOS 18, disabled during read-only transitions and account sheets.
From anywhere in the canvas it brings today into view and opens the keyboard at its end. Search (05.7P)
and Talk are not built. The room counts no words and draws no saved state: while saving works nothing
shows. While writing, the keyboard's own bar, UIKit's toolbar since SwiftUI's keyboard toolbar never
reaches the UIKit editor, holds Done alone, trailing. A save the phone could not make says so in ink
under the page with its cloud symbol, and a borderless *Try again* while the writing waits unsaved. A save sends the words alone (`SaveWords`): the page keeps the ratings the phone
holds for it at that moment, another surface's included, and its source when it is `spoken`; a page emptied of words
is removed whole.
An echo sheet up when an account sheet is asked for steps aside first (`AppModel.roomSheetUp`), since one
presenter holds one sheet.
The room seat is a native menu of the rooms the build carries (`AppModel.rooms`), Journal · Gym and Roadmap where its room
exists, with the current room checked; the separate account button opens You. The last room persists across launches. A
fresh phone gets a door for each of those rooms after the introduction on Where to start?. Its quiet Sign in opens the account sheet as *Pick up where you left off* (02b). After that
sign-in, *Bringing it back* (02c) counts each room's visible records as they land against the totals the account's
hello tallies by the same rule (`SignInRestore`), and opens the room the person last wrote to once its own records are
in; the other keeps arriving behind it. A lost connection or session opens that room at once, and so do ten seconds
in which nothing lands (a hung pull, a server backing off).
Hand-drawn Caveat ink notes appear automatically only on a true first Journal open. Previous Journal
visits, retained history, drafts and unreadable state suppress automatic presentation; restored sign-in
stays quiet. Writing or a tap lifts them while the editor keeps the tap. No note reaches under the bottom bar: while they
stand, today sits higher, and *Tap to write* points down at Write from above it (05.8P). The room menu contains only the room switcher;
ink notes belong to the first Journal open.
`journal-empty-later` and `journal-history` board fixtures seed past pages through
the journal actions; `journal-history-refused` leaves today's save refused as `JournalModel.save` does. A `-RM`
suffix exercises the journal's Reduce Motion scroll.
Focus and dismissal emit the bounded `first_run_choice` actions `write` and `done_writing` on the
`journal` screen, without page content. When the local day changes at
midnight or after a timezone change, the whole open draft, including its saved prefix, carries into
today and is combined with today's existing page. Yesterday's saved page stays intact. The carried words are typed on
today's page, which is `spoken` only when Talk has written into it. The draft is
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
Journal · iOS 02.3P–02.5P draw it: a lamp count, the stock bordered mini capsule at the end of a day's date line
with a 44 pt target, opens one stock sheet (`JournalEchoSheet`) at `.medium`, `.large` at accessibility sizes, with
`.height(140)`, `.medium` and `.large` detents and the page above readable and scrollable. It lists every passage
beside its mono date stamp, by year at `.large`, with borderless *Useful* and *Not useful* in its foot. Useful marks
every passage the sheet holds; Not useful retires the page's echo. Close, a swipe down, the count again or the
keyboard closes it, and today's count does not draw while writing. A passage flies the canvas to its source with
highlighting and lowers the sheet to `.height(140)`: the source's stamp and a regular-glass *Back to tonight*, whose
menu holds the trail's days; back at tonight the sheet goes. The first echo an install receives heads its sheet with
a line and *Got it*, once. Echoes ask for no Windmill One: a signed-in account past the server's page floor sees them.
The model re-locates every full quotation in the phone's current pages before showing its count.
Shared journal vectors pin NFC-equivalent matching and UTF-16 anchors into the unchanged source;
equivalent edits retain an echo, while edits that remove its quotation retract it. The model
follows the server's 20-page floor and waiver, provenance and Useful state. The first-echo
line requires an explicit server flag; the current list route does not supply it.
Reads poll every 15 seconds only while the room is active. All reads and verdicts use the existing
REST echoes routes; writing continues through the sync engine. Offline, empty and failed reads
show no echo surface. Requests are cancelled and old replies discarded across account or lifecycle
changes. Verdict failures roll back without a retry queue; opened signals never delay source
navigation. HTTP caching is disabled.

The `journal-echoes` board fixture uses real journal actions with a deterministic echoes service;
`journal-echoes-first` carries the first-echo flag. `journal-echoes-AX3-RM` covers larger type and the
source-scroll Reduce Motion path, including Back to tonight. The source quote sits after 14 paragraphs;
the echo flows use the Debug simulator's UIKit quote rectangle to check that the exact passage reaches the
visible canvas centre above the lowered sheet and remains read-only. `JournalEchoFlowTests` walks the light flow;
the larger-type, Reduce Motion and canvas-end checks run in the opt-in `NightlyFlowTests`.
Journal's principles are in `docs/design/brand-foundations.md`; the room's boards are the Journal file
`pC6ciOUnfLmI42oMihd7l3`, iOS page `202:2`, sections 01 and 02 ([the flow index](../../../docs/index.md)).

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
[the iOS colour roles](../../../docs/design/ios/ios-redesign.md) and, for roadmap,
[Roadmap · iOS](../../../docs/design/ios/roadmap.md), which `Tools/tests/test_theme_assets.py`
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
Center, the Home Screen's quick actions from the background and from a cold start, the journal's Write and Done
geometry (Reduce Motion and the largest text included), echoes at accessible text, and the introduction at the
accessibility sizes. `GymNightlyFlowTests` holds the gym's layout checks at the screen's edges: the log's end clear
of the tab bar and the accessory, and the conversation's end clear of the composer, after a pushed screen pops or a bounce brings the bar back. XCTest
skips both classes unless the test runner sees `WM_NIGHTLY_UI=1` (`TEST_RUNNER_WM_NIGHTLY_UI=1` when invoking
xcodebuild); [iOS nightly](../../../.github/workflows/ios-nightly.yml) runs them once a day.

## Localization

The app and its Live Activity extension read their copy from String Catalogs, with English the only language; the App
Shortcut phrases alone stay in code, since phrases localize through an `AppShortcuts.xcstrings` that comes with a second
language. Each bundle has two catalogs: `Resources/Localizable.xcstrings` and `Resources/InfoPlist.xcstrings` for the
app, `WorkoutActivityWidget/Localizable.xcstrings` and `WorkoutActivityWidget/InfoPlist.xcstrings` for the extension.
`WorkoutActivityShared/` and `Sources/Theme/` compile into both bundles, so their strings stand in both catalogs. A
key is its English text. An `InfoPlist.xcstrings` entry is kept by hand under the Info.plist key it localizes: the name
under the icon, `CFBundleDisplayName`, and any `…UsageDescription` the app adds.

A new string follows these rules:

- `Text`, `Button`, `Label`, `navigationTitle`, `alert` and the accessibility modifiers given a literal already
  localize it. A parameter or property that only ever holds literals and that only a view draws is a
  `LocalizedStringResource`, drawn with `Text(resource)`: `sheetCommit("Save", …)`, an onboarding page's title. Copy
  decided in a model or a helper, or held as a `String` — a message a model raises, a refusal's sentence, a value an
  alert, UIKit, ActivityKit or a test reads — is `String(localized: "…")`, resolved where it is decided. User content
  and what the server sends are shown as they are, never looked up.
- A message interpolates only a `String` or an `Int`. A `Double`, a `Date` or a measurement is formatted first with the
  formatter the screen already uses, and that `String` is interpolated: an interpolated `Double` renders through
  `%lf`, *2.500000*. A `String(localized:)` that interpolates an `Int` resolves in `Locale.copy`
  (`Sources/Theme/CopyLocale.swift`, `locale: .copy`), so its digits read as Swift writes them, *1000*, under any
  region; the current locale would group them by the phone's region, *1,000* or *1.000*. A SwiftUI literal that
  interpolates an `Int` — `Text("\(count)")`, `Section("Set \(index + 1)")`, an accessibility label — formats in the
  view's locale, and every such count stays under 1000, where no region groups digits.
- A sentence is one message with placeholders, never joined from fragments. A word set in its own style is a `Text`
  interpolated into the whole message: `Text("\(Text("Build").fontWeight(.semibold)) — a program from a screenshot or
  your own words.")`. A count that changes its words is one `%lld` message with a plural variation in the catalog, and
  English's `one` and `other` must read as the app reads for every count it can receive. A plural variation shows its
  number; words that follow a count the text does not show, *it* or *them*, are two whole messages chosen by
  `count == 1`.
- A `comment:` says what the English alone leaves unclear: a word with more than one reading, the term a placeholder
  stands for, a fragment such as *since %@*. Where the call takes no comment — a `Section`, a `LabeledContent`, a
  picker's title, an App Intent's parameter — the comment is written in the catalog, where the sync keeps it. A word
  with two senses gets an explicit key for one of them, its English as the default value:
  `String(localized: "connected-tool.write", defaultValue: "Write", comment: …)` stands beside the verb `Write`.
- A key that holds no word is not for translators, and the catalog tool marks it `"shouldTranslate" : false`: a
  placeholder, digits or a mark alone, and joins by space, middle dot, dash, bullet, slash or ×. Joins by comma or colon
  are translatable, since their punctuation varies by language.
- A counted thing of the gym, *3 sets* or *1 routine*, is `GymCount.of(_:_:)` in
  `Sources/Gym/Components/GymFormat.swift`, one plural message per noun. The sign-in question writes its counts out
  itself, with the same messages, so the catalog holds each once.

Then regenerate the catalogs and commit them:

```sh
python3 Tools/generate_project.py
python3 Tools/string_catalogs.py
```

The tool builds the app in Release for the simulator, in the DerivedData folder Xcode keeps for the project, where
`SWIFT_EMIT_LOC_STRINGS` has the compiler record every localized string in a `.stringsdata` file. It syncs each
bundle's `Localizable.xcstrings` with `xcstringstool` from the files of the sources its target compiles: a new string
arrives, a string no source names leaves, plural variations and comments stay, and a key without a word is marked as
above. Before it builds, it holds the English kept by hand to its key: a value, and a plural's `other` form, reads as
its key once its positions, numbered in order, are dropped and each substitution reads as its `other` form; every other
form takes the key's placeholders; a substitution counts one of the key's `%lld`; and every plural has its `one` and
`other` forms, each showing its number. An explicit key's value is its English and answers to no key. It fails when
`xcstringstool` skips a file it could not read, and holds each `InfoPlist.xcstrings` to the built bundle's Info.plist.
With `--derived-data <path>` it reads an existing Release simulator build instead of building; `--check` changes
nothing and fails when a catalog differs, which [CI](../../../.github/workflows/ios.yml) runs on its Release build.

`python3 Tools/check_copy_literals.py` fails on a literal a person could read that is no key of its bundle's catalog,
matched with each interpolation as a placeholder, in `Sources/`, `WorkoutActivityShared/` and `WorkoutActivityWidget/`;
the launch fixtures, `Verification.swift`, `JournalModelTransport.swift` and the lines inside `#if DEBUG` or
`#if targetEnvironment(simulator)` stay out. It reads a literal as a name, not copy, when it is one lowercase word, an
identifier, a path, a URL or a file; when it is handed to a call or a label that names — an identifier, a symbol, a
telemetry event or property, a log line (`print`, `NSLog`, `os_log`, a `logger`'s calls), a key, a font's name, a date
format or template, a URL's query item, a keychain attribute — or set to such a property; and when it is a dictionary
key, a subscript, a side of a comparison, a `switch` pattern or an enum's one-word raw value. A raw value with spaces
between its words is copy. It also fails on a `String(localized:)` whose shape matches a key that counts an `Int`, even
when a `%@` twin of that shape exists, outside `Locale.copy`. Its allowlist names each remaining literal by its text and
why, the check prints every allowed literal with its reason, and an entry that no longer matches fails the check. Both
targets run it before they build, except the build `string_catalogs.py` makes, so a new string can reach its catalog;
`python3 -m unittest discover -s Tools/tests -v` includes its cases and runs it over the shipped sources.

## The Graph's benchmark

`Tools/graph_bench.sh` measures the Graph against its budget ([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md) §5:
a first frame under a second and 60 frames a second, at 5,000 steps) inside an iOS simulator, on a Release-configuration
build that compiles the Roadmap room and its simulator boards in, which no release carries:

```sh
bash apps/ios/App/Tools/graph_bench.sh    # SIM=<udid> uses a booted simulator, DERIVED_DATA=<path> a build folder
```

`Tests/Roadmap/Graph/GraphBenchmarks.swift`, hosted in the app, times the picture of the layout's 5,000-step handbook
fixture, with its seats, its model and every caption wrapped; the picture after one step is marked done; the domain's
read of the same roadmap, planted through the domain, taken as the layout's steps; and at five cameras the room's own
part of a frame: the zoom floor, the opening frame, the zoom at which connectors are first drawn, the working zoom and
the pinch ceiling. That part is the captions placed and the canvas's drawing issued; the offscreen render printed
beside them draws into a bitmap, which takes hundreds of times the main actor's work in a frame of the same picture on
a screen, and carries no budget.
`UITests/RoadmapGraphBenchmarks.swift` launches `-board roadmap-handbook`, switches to the Graph, and drives four pans of
the whole roadmap, five pinches in with a pan after each, and five pinches out. The app measures itself there
(`RoadmapGraph.Measure`, written to the launch's `-graph-measures` file): the time from the switch to the first frame
that draws the picture, with the layout's share of it, and for each gesture the gaps between the frames a display link
on the main actor sees and how long the main actor worked in each, its commit to the screen included (`GraphFrames`).

`apps/ios/GraphBench` puts the same Graph on a device's own screen, in an app of its own that compiles `GraphPicture`,
`GraphCamera`, `GraphDrawing` and `GraphSurface` from here and draws the handbook on the room's own surface, alone on
the screen ([its README](../GraphBench/README.md)). One command builds it, runs it on a phone or on a simulator and
removes it: a script pans and pinches at five cameras, at 5,000 steps and at the first 1,000, under each of the four
ways the surface can keep a pinch's frames (`GraphPinch`). `SHORT=1` runs the 5,000 steps at the whole roadmap and at
zoom 0.011 alone, every way three times. It judges a pan or a pinch over its budget when more than a tenth of its
frames are later than a frame and a half, or when it is given fewer than nine tenths of the 180 frames its three
seconds owe.

On an iPhone 13 mini (iOS 27.2, a 60 Hz screen, thermal state nominal, Low Power Mode off), drawn as the room draws
now, `live`, three runs at each size:

| | 5,000 steps | 1,000 steps |
|---|---|---|
| The first frame, with the picture's making | 164 to 169 ms | 50 ms |
| The whole roadmap, a pan: frames later than a frame and a half | 2 to 3 of 177 | none of 181 |
| The whole roadmap, a pinch: the same | 21 to 23 of 150 | none of 181 |
| The whole roadmap, a pinch: the main actor's work in a frame, median and nineteenth of twenty | 8 to 9 ms, 34 ms | 7.5 ms, 9 ms |
| The four closer cameras: frames later than a frame and a half | one, in one pan of twenty-four | none |
| The four closer cameras: the main actor's work in a frame, median | 5.6 to 8.4 ms | 5.2 to 7.5 ms |

On that phone one `Canvas` drawn live holds the budget at 1,000 steps at every camera, and at 5,000 steps at every
camera but one: a pinch with the whole roadmap in view, where about a seventh of the frames come late in every run,
more than the tenth the budget allows, and the gesture is given 150 frames of its 180. The draw closure and the
script's handler take about 2 ms each of those frames; the rest is the view's update and its commit. An iPhone 13
mini is faster than the oldest phone the app supports, so a camera that misses here misses there. No phone has run
`held`, `coarse` or `layered`.

On an iPhone 17 simulator on an M3 Pro, the short form twice, six runs of each way at 5,000 steps, with `layered`
composited at every camera, its pans and its pinch at zoom 0.011 among them, as `GraphSurface` composites it:

| | `live` | `held` | `coarse` | `layered` |
|---|---|---|---|---|
| The whole roadmap, a pinch: frames given of 180, and late | 178 to 180, 2 at most | 175 to 180, 5 at most | 167 to 180, 1 at most | 178 to 180, 2 at most |
| The same: the main actor's work in a frame, median and nineteenth of twenty | 7.2 to 9.5 ms, 9 to 12 ms | 3.0 to 3.5 ms, 7 to 11 ms | 7.3 to 8.7 ms, 10 to 11 ms | 6.1 to 8.9 ms, 8 to 12 ms |
| The same: draws of the canvas | 179 to 180 | 9 | 168 to 181 | 178 to 180 |
| The whole roadmap, a pan: frames given, and late | 178 to 180, 2 at most | 178 to 180, 2 at most | 179 to 180, 1 at most | 180, none |
| The same: the main actor's work, median and nineteenth of twenty | 6.6 to 9.1 ms, 10 to 13 ms | 7.9 to 9.5 ms, 11 to 14 ms | 7.7 to 9.2 ms, 11 to 13 ms | 6.0 to 7.7 ms, 8 to 12 ms |
| Zoom 0.011, a pinch: frames given, and late | 180, none | 180, none | 180, none | 180, none |
| The same: the main actor's work, median and nineteenth of twenty | 5.1 to 6.8 ms, 7 to 10 ms | 4.7 to 6.9 ms, 7 to 10 ms | 5.4 to 6.8 ms, 7 to 9 ms | 2.2 to 4.2 ms, 6 to 10 ms |
| Zoom 0.011, a pan: frames given, and late | 180, none | 180, none | 180, none | 180, none |
| The same: the main actor's work, median and nineteenth of twenty | 3.3 to 5.7 ms, 6 to 11 ms | 3.5 to 5.7 ms, 6 to 10 ms | 3.3 to 5.2 ms, 6 to 9 ms | 2.3 to 4.2 ms, 6 to 10 ms |

Every pan and pinch holds the budget there under every way, `live` included: the simulator does not show the late
frames the phone gives a pinch of the whole roadmap, so it cannot choose among them. What it does show: under `held`
the canvas draws 9 times in a pinch's 180 frames and the main actor's work in a frame falls by three fifths, and in
one session of the two a redraw at a stop cost a late frame, three to five in a pinch; `coarse` and `layered` move
the work by less than one run differs from the next; at zoom 0.011, where some 280 steps are in view, `held` and
`coarse` draw every frame as `live` does; and one pinch under `coarse` lost 13 frames to a single stall of a quarter
of a second, as a frame or two stall now and then under any way.

In `graph_bench.sh` each measure prints one `bench` line beside its budget with the share of the budget it used, and a
measure over its budget fails the run. The budgets are §5's own: a second for the first frame and for each part of it, a frame at 60 a
second for the room's part of a frame and for the median of the main actor's work in a gesture's frames, and no more
than a tenth of a gesture's frames later than a frame and a half. Now and then a frame or two of a gesture stall, at
the closest zoom too, where the canvas draws a step or two; their cause is not found, and the nineteenth of twenty is
printed and not judged. The budgets are held on the Mac that runs the simulator, which is faster than any iPhone
the app supports: a run under budget does not say a phone holds it, and the share says how wide the margin is. A
display link sees the main actor's frames, not what the screen composited after them. Both classes
run only under `WM_GRAPH_BENCH=1`, which the script sets, so the unit scheme and the UI shards skip them.

## The Board's benchmark

`Tools/board_bench.sh` measures the Board against the same budget ([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md)
§5: from the tap that opens a roadmap of 5,000 steps to the Board's first frame under a second, and 60 frames a second)
inside an iOS simulator, on the same kind of Release-configuration build:

```sh
bash apps/ios/App/Tools/board_bench.sh    # SIM=<udid> uses a booted simulator, DERIVED_DATA=<path> a build folder
```

`Tests/Roadmap/Board/BoardBenchmarks.swift`, hosted in the app, plants the 5,000-step handbook through the domain and
times the room's read of the open roadmap, which the model takes at every change of the phone's copy (the account's
read, the domain's Board and legend, every step's row, the groups and what follows each step), against the first frame's
second; and the Board read again under each query a person asks of it (*Newest First*, one kind shown, Find's first key,
a word, a branch), against a frame at 60 a second, since Find reads it at every key. It times *Recolor* and *Delete N
Steps* too, each one act of a hundred parts and of a thousand on a phone never signed in, against the two seconds past
which the App Hang report names the app frozen, since the room writes on the main actor. On an iPhone 17 simulator on an
M3 Pro, one run: Recolor takes 517 ms for a hundred steps and 5.0 s for a thousand, and Delete 660 ms and 5.8 s, so the
thousand are over. A part costs about 5 ms, which on the stepped engine's store in Debug no longer grows with the
roadmap (39 to 56 ms a part of an act of a hundred, at 250 steps and at 5,000); a Debug profile puts more than half of
it in the views each of its reads and commits builds, which walk the outbox entry that planted its step, 500 records, to
fold the one it names (the dogfood tree's `m1-read-a-planted-step-without-parsing-its-whole-entry`).
`UITests/RoadmapBoardBenchmarks.swift` launches `-board roadmap-handbook`, switches to the Graph and back to the Board
three times, and flings the list eight times down through Up next and Locked and eight times back. The app measures
itself there (`BoardFrames`, written to the launch's `-board-measures` file): the time from the switch's tap to the
Board's first frame, and for each scroll, from the finger's first move to the list at rest, the gaps between the frames
a display link on the main actor sees and how long the main actor worked in each, judged as a Graph gesture's are. On an
iPhone 17 simulator on an M3 Pro, one run: the room's read of the open roadmap takes 14 ms at the median of five, 1% of
the first frame's second; the Board read again under a query takes 2.3 ms (a branch) to 5.8 ms (*Newest First*), a
seventh to a third of a frame; the switch to the Board's first frame takes 96 to 112 ms, a tenth of its second; and
sixteen flings through the list are given 2,433 frames, one of them later than a frame and a half, with the main actor's
work in a frame at 1.8 ms at the median, 7.5 ms at the nineteenth of twenty and 18 ms at most. The same cautions hold as
for the Graph's: the Mac is faster than any iPhone the app supports, so the share is the margin a phone has to spend,
and no phone has run the Board's benchmark. Both classes run only under `WM_BOARD_BENCH=1`, which the script sets, so
the unit scheme and the UI shards skip them.

## Design captures

The design capture suite in `UITests/DesignCapture/` screenshots screens and sheets for design review, each in Dark
and Daylight. `DesignCapture.swift` holds the shared base: launch, capture, the gym's tab and sheet navigation, and
the opt-in skip. XCTest skips every capture unless the test runner sees `WM_DESIGN_CAPTURE=1`; Xcode forwards
`TEST_RUNNER_`-prefixed variables to the runner without the prefix. Each area keeps its captures in its own file and
class, a subclass of `DesignCapture`: `ShellCaptures`, `JournalCaptures`, `ChromeCaptures`, `CoachCaptures`,
`NotesCaptures`, `RoutinesCaptures`, `WorkoutCaptures`, `LogCaptures`, `RecoveryCaptures`, `RoadmapCaptures`, `RoadmapNestedCaptures`,
`RoadmapSharingCaptures` and `RoadmapCoachCaptures`. The CI shards leave
the suite out and check that its guard remains.

A capture's name is its screen, then `-375` on a 375 pt phone, `-ax3` at the largest text, and its appearance:
`gym-log-end-375-ax3-dark`. A screen drawn on a Figma board starts with the board's number, its direction letter included: `02L.1-routines-dark`
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

Repeat `-only-testing:` for more tests, or name `WindmillUITests/RoutinesCaptures` for an area.
`RoadmapCaptures/testFiveThousandSteps` (02.14) needs a Release-configuration build that compiles the room in, as
`Tools/board_bench.sh` builds it (`-configuration Release ENABLE_TESTABILITY=YES WM_ROADMAP_ROOM_ENABLED=YES
'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG'`): in a Debug build the app plants the 5,000-step handbook as
it launches and answers no query for longer than XCTest waits for one, so the capture's first query fails.
`TEST_RUNNER_WM_CAPTURE_ARGUMENTS` adds launch arguments to every capture the app launches itself, such as
`-AppleLanguages (ar) -AppleLocale ar_SA` to capture the app under another system language. The exporter writes
one PNG per capture named by the capture, `$CAPTURES/02L.1-routines-dark.png`, replacing that capture's PNG from an
earlier export, and a `capture-manifest.json` linking each PNG to its test and result bundle. Two captures with one
name in a result fail the export.

## TestFlight releases

TestFlight releases run through [`.github/workflows/ios-release.yml`](../../../.github/workflows/ios-release.yml).
The workflow uses the repository's signing credentials, builds with Xcode 27.1 (the iOS 27 SDK) and uploads to
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
records `processingState`, `internalBuildState`, `externalBuildState`, the checked plist hash, source
SHA and workflow run. Optional paired `reference_version`/`reference_build` dispatch inputs identify
an independently verified prior upload. The helper lists the app’s groups, selects internal groups
whose build relationships contain that prior upload, reads
the target build’s exact membership and counts existing tester relationships. Each group reports
Apple’s literal `hasAccessToAllBuilds` flag, membership and count; no tester IDs, names or emails enter receipts.
`betaAccess=VERIFIED` requires the target to be `VALID` and internally `READY_FOR_BETA_TESTING` or
`IN_BETA_TESTING`, with every established group containing the target and at least one tester.
Expired, compliance-blocked and unknown states remain incomplete even when membership is present.
It does not prove a particular device installed the build. Missing reference, missing distribution
or incomplete membership stays explicit; no groups, invitations or distribution settings change.

The separate [read-only status workflow](../../../.github/workflows/ios-beta-status.yml) accepts
exact target and reference version/build pairs without uploading again. Its receipt labels identity
as dispatch inputs; the release workflow reads identity from the actual archive plist. Both use only
signed GET requests and retain bounded status artifacts. Pagination stays on the same Apple endpoint.
A failed read reports only its static route and allowlisted Apple error code/parameter; response text,
resource IDs and user fields are excluded. A failed read leaves access unverified.
If the status step fails after upload, do not rerun the release workflow: the upload already exists.
Record the verified version, build, source SHA, run URL,
upload result and any processing or symbol limitations in `WORK_LOG.md`.
