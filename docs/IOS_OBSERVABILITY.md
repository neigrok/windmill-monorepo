# iOS observability

The Journal/Gym app uses Sentry Cocoa 9.29.0 through SPM for technical failures. Product events go to
the first-party `POST /v1/events` intake, which stores them in Postgres and forwards them to Amplitude.
The app contains no Amplitude API key. `SyncEngine.Telemetry` is injected into the app, account coordinator, journal, gym and roadmap models,
authentication, HTTP transport, engine, Keychain and protected storage. Tests default to `NoopTelemetry`.

Gym load validation accepts finite normalized values without a fixed kg cap; explicit zero remains
distinct from an absent target. An unrepresentable derived metric is unavailable data, rendered in
existing unavailable slots, and creates no technical failure or event. Existing set, target, fix and
import actions retain their bounded outcome events and storage/transport failure reporters. Fresh
sender hellos use the existing sync diagnostics. Loads, numeric buffers, metric values and raw
refusal text never enter telemetry properties.

## Configuration

Release builds require a valid HTTPS `IOS_SENTRY_DSN` for the dedicated iOS Sentry project. The
repository secret is embedded at build time; installed builds keep their original destination.
The backend's `SENTRY_DSN` is independent. CI uses `https://nonproduction@example.invalid/1`.
Debug telemetry is disabled unless `WM_DEBUG_TELEMETRY=YES` is set. Simulator-only launch arguments
`-telemetry -sentry-dsn http://ios@127.0.0.1:8091/42` enable local verification with environment `test`.
These switches and the authentication fixtures are absent from Release builds.

Every event carries `platform=ios`, `version`, `build`, release `ios-<version>-<source revision>` and
`environment`. Sentry uses the same release, environment and build as its distribution. Revision
comes from `WM_SOURCE_REVISION`, `GITHUB_SHA`, or the local Git HEAD. Release defaults to `production`,
Debug to `development`. The default API base is `https://windmill.works`; local verification overrides
`WM_SERVER_BASE_URL` or uses `-server http://127.0.0.1:8089`.

`Tools/prepare_build.py` validates and embeds configuration before compilation. CI and the manual
release workflow use `Tools/generate_project.py` to configure the app target before XcodeGen;
compiler settings and SPM signing identities are not overridden on the command line.

The backend needs its own `AMPLITUDE_API_KEY` and regional `AMPLITUDE_HOST` for forwarding. A successful
first-party intake proves storage, not asynchronous Amplitude receipt.

## Error coverage and privacy

Sentry starts before session or SQLite storage reads. The SDK captures native crashes and App Hangs: a main thread
unresponsive for 2 seconds or more (`appHangTimeoutInterval`), fully or partly blocked, as an error event with its stack
traces and no other content. Handled
reports cover HTTP/transport and successful-body decoding, journal and gym storage and drafts, Journal Echoes REST, Gym deletes, Gym REST, SQLite
reads/writes, protected-storage preparation, fork-guard I/O, Keychain reads/writes/deletions and
enumeration, session restoration, code authentication, Apple ticket creation/linking, sign-in-method
reads, Apple removal, adoption and sign-out. The sync engine
reports unexpected admission results, digest resets and doubts that reach the backoff ceiling,
once per doubt episode. A push answer to an opted entry that exceeds its byte bound reports `sync_push`
as decode and changes nothing. An `ok` whose scoped receipt (engine E-7) or inverse outcomes (K-3) do
not decode still acknowledges its entry with no receipt, ending its predictions until the pull brings
the rows, and reports `sync_admission` as malformed, as a 400 answer does; a receipt's ids never leave
the phone. Engine and app runtime adapters enqueue static diagnostics through
`BoundedTelemetry`: a serial utility worker invokes the sink outside engine/writer/publisher locks.
At most 128 records wait behind one in flight; overflow silently drops new diagnostics. A blocked
sink cannot delay commits/subscriptions or enter adaptive writer timing.
HTTP owns transport reports; the engine's deadline uses the same invocation
diagnostics to avoid a second report and retains the failure kind in pull/push outcome metrics.

HTTP failures carry method, coarse route family (`/v1/ai`, `/v1/auth`, `/v1/me`, `/v1/sync`, `/v1/gym`, `/v1/journal` or `/v1/events`), a static
operation, `failure_kind`, optional numeric status label and `duration_ms`. Duration uses a monotonic
clock through response consumption and decoding. Sync outcomes also cover application of the reply
to the local store. Expected statuses 400, 401, 403, 404, 409, 410, 422, 426 and 429 are product/API metrics,
not Sentry Issues, and so is a sync push's 413, which the engine halves or refuses too-large, the server's own 503
`unavailable` in the sync envelope, and any 503 at the live socket's upgrade, whose body is not read; a bare or foreign
503 (an edge, a maintenance page) is reportable. A deployment without Coach
does not mount `POST /v1/gym/coach/turns`, so a send meets the server's 404 page: `api_request_failed` carries status `404`
under operation `gym_coach_turn`, `gym_ask_outcome` carries `absent`, and the room states the unavailable stance with no
composer and no retry. A turn stream that drops resumes after 1, 2, 4 and 8 beats through `GET …/turns/{turnId}`; a fifth
loss ends the turn `interrupted` and reports once under `gym_coach_turn` (kind transport), a frame the phone cannot read
reports as decode, a 5xx as http, a replica that refuses the turn's own record (kind refusal) is a defect of this phone's turn, a `coach-turn-unknown` on resume or a `coach-turn-order` on a timed-out batch is an expected refusal that ends the turn interrupted with that code on `coach_turn`,
and a stream's closing `error coach-stream-replaced` (another stream of the turn took over) resumes like a drop.
Known USD allowance refusal codes at status 503 are also expected refusals; accounting failures remain
reportable. The typed allowance state retains partial creation receipts and the editable draft without
an automatic retry. Amounts, reset timestamps and request IDs never enter telemetry.
Offline/DNS/connect failures are metrics, and so is a live socket the server or the network drops with no close
frame, and one the server closes with 1008 once its session ends (`failure_kind` refused); cancellation is quiet. Timeouts, TLS, unexpected HTTP responses and decoding failures are reportable. Sync
files each once per outage: a retry that fails as the one before it did is a metric alone until its operation
succeeds or fails another way. No URL, dynamic identifier, query string, authorization header or response body
enters telemetry.

The promise is **Only you.** Never send journal text, text length, mood or energy values, email
addresses, Apple subjects/tickets/identity tokens, session tokens or response bodies. Apple tickets
live in memory only and are cleared on dismissal, expiry or completion. Product properties pass a finite allowlist of labels;
unknown event names, property names and label values are discarded. Duration, a Coach turn's counts
(`ability_calls`, `refusals`, `answer_bytes`) and `sync_inverse`'s (`applied`, `skipped`, `waiting`, `age_ms`, `given_up`) are the
only numeric product properties; duration is clamped to 0–86,400,000 ms and a count to 0–10,000,000. Version/build/release
metadata is bounded.

The final Sentry send hook removes messages, requests, extras, breadcrumbs, user identity, transaction
and server names, arbitrary tags and custom contexts. It strips exception messages and mechanism
details while retaining compiled exception types, stack traces, release and technical operation tags.
Only bounded technical fields of app/device/OS/runtime contexts and a reconstructed numeric `telemetry.duration_ms` survive.
Device-app hashes, view names and locale are removed. Memory introspection, screenshots, view hierarchy, replay, logs, metrics, tracing, profiling and
MetricKit are disabled. Technical reports contain no product navigation history.

## Product events

The allowlist below covers the app's screens and actions. Property labels accept only fixed values;
status and duration use the bounded numeric rules above. Every row also carries the common
platform/version/build/release/environment properties. The journal asks no mood or energy question on iOS, so no
scale event exists. Journal ink emits `first_run_screen_viewed` with screen `ink_notes` for its automatic first-open
presentation and `first_run_choice` with action `dismiss_ink` once when writing or a tap lifts it; no ink replay action
is allowlisted. Write in the bottom bar, a tap on today's page and *Write tonight* each open the keyboard with
`first_run_choice` screen journal, action `write`; Done in the keyboard's bar ends it with action `done_writing`, and
*Try again* under a page not saved records action `retry`. A save the phone refuses before it leaves, or the log's
rules refuse, records `journal_save_refused` with its reason alone.

| Area | Events | Properties, as each emitter sends them |
| --- | --- | --- |
| Application | `app_started`, `app_foregrounded`, `app_backgrounded` | common metadata |
| Authentication | `auth_restore` | outcome: anonymous, signed_in, paused, failed |
| Email code | `auth_code_requested`, `auth_code_sent` | method: email; outcome: ok, failed (on `auth_code_sent` only) |
| Sign-in | `auth_sign_in_started`, `auth_signed_in` | method: email, apple; outcome: ok, linked, failed, cancelled (on `auth_signed_in` only, linked following a code link or signed-in attach) |
| Sign-out | `auth_signed_out` | outcome: ok, refused (a sign-out that could not begin, or an answer it could not carry out; the account stays signed in and the reason is the Sign out footer) |
| Introduction | `onboarding_screen_viewed`, `onboarding_skipped`, `onboarding_finished` | page: windmill, roadmap, journal, gym; presentation: first_launch, replay |
| Introduction replay | `onboarding_replayed` | presentation: replay |
| First-run screens | `first_run_screen_viewed` | screen: welcome, journal, ink_notes, gym, routines, log, coach, workout, keep, address, code, you, adoption, discard_adoption, 23a, 23b, 23c, 24c, 24d, apple_no_account, apple_expired, auth_pending |
| Choices | `first_run_choice` | screen; action: open_journal, open_gym, open_roadmap (the Roadmap door, in a build that carries the room), dismiss_ink, write, done_writing, keep, close, email, back, change_email, resend, add, discard, cancel, sign_out, use_account, create_account, remove_apple, retry. Sign out and the answer to its alert (keep, discard, cancel) are screen you |
| Rooms | `room_switched` | room: journal, gym, roadmap (in a build that carries the Roadmap room); emitted after switching |
| Roadmap Coach, opened | `roadmap_coach_opened` | entry: foot (the composer focused at the foot of the Board or the Graph), step (a step's page, its Coach circle or composer), row (*Ask Coach* in a Board row's long-press menu). Emitted only where Coach is switched on (roadmap-ios.md §8). Roadmap Coach §13 |
| Roadmap Coach, a question not asked | `roadmap_coach_ask_refused` | reason: offline (Send with no connection, the question kept in the field), or the access state a turn was withdrawn by before the service admitted it: allowanceUsed, capacityUsed, busy, signIn, update, switchedOff, didNotAnswer. Roadmap Coach §13 |
| Roadmap Coach, a turn | `roadmap_coach_turn` | the engine's turn outcome: state (completed, declined, failed, stopped, interrupted), seat (anon, bound), truncated (true, false: the turn's own, false where it reached no end), code (bounded: the engine's codes and §6.1's, `unknown` past them), ability_calls, refusals and answer_bytes as bounded counts, duration_ms. Never the question, the answer or a result. Roadmap Coach §13 |
| Roadmap Coach, an ability | `roadmap_coach_ability` | name (catalog roadmap/1's ability, `unoffered` for any other), outcome (ok, or the gate's or §6.1's refusal code), one for each call the engine runs, a direct write's one product event. Roadmap Coach §13 |
| Roadmap Coach, Stop | `roadmap_coach_stopped` | common metadata alone, as Stop is pressed on a running turn. Roadmap Coach §13 |
| Roadmap Coach, a direct write's Undo | `roadmap_coach_write_undone` | ability (set_progress, update_node, create_node, connect), outcome (undone, skipped, unavailable), told by the tool host once the engine has settled the band's *Undo*. Roadmap Coach §13 |
| Roadmap room | `roadmap_room_opened` | common metadata alone; emitted each time the room comes to the front, from its door, the room menu or a launch that reopens it. No title, step text, count or id of a roadmap or a step is sent |
| Roadmap Board, completing | `roadmap_board_complete` | door: swipe (the row's leading action), menu (the long-press menu); emitted once the mark is written on the phone. The web's event |
| Roadmap step page, opening | `roadmap_board_step_open` | surface: document (a step's page, in the web's word); column: upNext, locked, done, the group the step stands in as its page opens; door: card (a Board row), step (a *Requires* or *Opens* row of another step's page), graph (the Graph's bar of the selected step), activity (a row of the roadmap's Activity), link (a link to the person's own roadmap that names the step), band (*Show* in the band of a line told once, 10.2 and 10.4). Emitted once as the page is pushed, and not when Back returns to it. The web's event |
| Roadmap step page, acts | `roadmap_board_step_action` | surface: document; action: complete (*Complete* at the page's foot) and reset (*Reset* on the status row), each emitted once the mark is written on the phone, delete (*Delete Step* in the … menu, as its question opens), editNote (the note's screen pushed over the page, from the note's row or *Add Note*), openInGraph (*Open in Graph* in the … menu) and viewBranch (*View Branch* in the … menu); and surface: board with action openInGraph for *Open in Graph* in a Board row's long-press menu. The web's event, with the Board's surface added |
| Roadmap step page, the workspace | `roadmap_board_workspace` | action: subtaskAdd (return in *Add Subtask* added one), subtaskToggle (a tap checked or unchecked one), subtaskDelete and linkDelete (a swipe's *Delete*, held by the engine), linkOpen (*Add Link* raised New Link), linkCancel (New Link closed with no link added), linkAdd (*Add* added one) and noteSave (the note's screen, or the app, left with the note changed, and its draft was saved), each but linkOpen and linkCancel emitted once the act is written on the phone; and undo (the band's *Undo* of a subtask checked or of a held removal), with act: subtaskToggle, subtaskDelete or linkDelete and outcome: ok or unavailable. The web's event and its actions, with linkOpen, linkCancel, and act and outcome on undo, the iPhone's own. No subtask's words, note's text, link's title or address, count or id is sent |
| Roadmap room, deleting | `roadmap_board_delete` | step: confirm (the delete question answered *Delete Step*, or *Delete N Steps* for several), cancel (the question closed unanswered), held (the engine holds the step's delete, with door: swipe, menu on the Board, page on a step's page, form for *Delete Step* in the step's form and bulk for the steps chosen on the Board, deleted as one gesture); view: board on every row. On the Board and in the form the question's opening emits nothing; on a step's page it is `roadmap_board_step_action` with action delete. The web's event, with the page's and the form's doors added |
| Roadmap room, the band's Undo | `roadmap_board_undo` | act: complete, reset, delete (one step's or several's), create (a step the form made), edit (a step's change the form saved), recolor (several steps moved to a kind), removeKind (a kind removed in Kinds), graft (the steps Paste Steps added, with their marks and the kinds they brought), guide (a guide saved in the Guide sheet), and attach, change and detach (a roadmap attached to a step, changed for another or detached on its page), whichever screen the act was made on; outcome: ok (the kit took the act back and changed what the phone holds: a held delete cancelled, a step's delete past its hold or any other act's Undo cancelled in place, reserved, or settled with a restore applied), unavailable (nothing was taken back: the engine kept no Undo of the act, its Undo settled with every restore skipped, as where another phone deleted the same step, or the domain refused the Undo before anything was written, a check its act named failing over what stands, as for a kind removed whose hue another kind has come to wear), as the band then says in the receipt's place. What the engine made of an act's Undo is its own `sync_inverse`. The web's event, with the outcome, Reset and edit added |
| Roadmap room, its roadmaps | `roadmap_sheet` | step: switch (a roadmap chosen became the open one, with door: menu for the title menu, list for All Roadmaps and gallery for a gallery row's *Open Your Copy* where the person's list holds the copy already, a copy still on its way opening with the fork's band and no switch; choosing the open one emits nothing), open (All Roadmaps pushed on the stack), search (the first search of All Roadmaps in one visit), new (the New Roadmap sheet opened, with door: menu, list, or empty for the room that holds no roadmap), rename (a name committed in the bar's field and written; a name left as it was emits nothing). The web's event of its roadmap sheet and switcher, with the iPhone's doors |
| Roadmap room, a roadmap made | `birth` | door: blank (a name alone), import (a plan pasted through *A Copied Plan*), file (a plan read from *A File*); count: 0, 1, 2-5, 6-20, 21+, the steps it was planted with as a bucket; emitted once the roadmap and its steps are written on the phone, before a plan's done marks. The web's event, its door for its `import` and its bucket under `count` for its `steps`, without its `local`: the iPhone's does not say whether the phone was signed in |
| Roadmap room, New Roadmap's plan and its leaving | `roadmap_board_create` | step: read (a plan read back, with door: import or file), clear (*Clear* back to *Start from*, with the plan's door), unread (door: file, a chosen file the phone could not open, or with reason: too_large one past the 2,000,000 bytes it reads, or an importer that handed back none, each said in the footer, a file by its name, which no event carries), cancel (the sheet's *Cancel*, or the sheet sent away, with door: blank, or the door of the plan read back). The web's event and its words for a start; the web's own page tells no read, clear or unread |
| Roadmap Board, Paste Steps | `roadmap_board_create` | door: paste; step: open (the read-back raised over the open roadmap, with view: board or graph), saved (*Add* wrote the steps, with view and count: 0, 1, 2-5, 6-20, 21+, the steps as a bucket), refused (*Add* the domain refused, with refusal: its kind, the read-back staying open and saying why), cancel (the read-back closed with nothing written), unread (nothing read back, with reason: empty for a clipboard that holds no text or a text that lands no step, denied for a paste the person did not allow), settings (*Settings* in the band of a paste not allowed). The web's event and its door for a paste; unread and settings are the iPhone's own. No text of the paste is sent |
| Roadmap step form, a new step | `roadmap_board_create` | step: open (New Step raised the form, with door: foot for the + at the room's foot, empty for *New Step* on a roadmap with no step and find for *New Step “…”* where Find matched nothing, and view: board, or graph for the + under the Graph; a roadmap at the registry's cap opens no form and emits `roadmap_write_refused` instead), saved (*Create* wrote the step with what it requires and opens, with column: upNext or locked, the group it landed in), cancel (the form closed on an unchanged draft, by *Cancel* or sent away, with its door) and discard (*Discard* answered on a changed draft, with its door). The web's event and its steps; foot is the iPhone's door, and a step's doors are never blank, which names a roadmap's start |
| Roadmap step form, a step edited | `roadmap_step_edit` | step: open (*Edit* on a step's page or in a Board row's long-press menu raised the form), cancel (closed on an unchanged draft), discard (*Discard* answered on a changed one); door: page, or menu for the Board row's. The web's event of its editor, without its field: the iPhone edits a step in one form |
| Roadmap step form, an edit saved | `roadmap_board_edit` | step: saved; name, description, kind, prerequisites, opens, links and roadmap: true or false, whether *Save* changed that part of the step (prerequisites for what it requires, links for the links it shares, roadmap for the roadmap it opens). Emitted once the one gesture is written on the phone. The web's event, with opens, links and roadmap added. New Link in the form joins a link to the draft and emits nothing by itself |
| Roadmap room, deleting a roadmap | `roadmap_deletion` | step: ask (the question opened, with door: menu for the title menu and list for a row's swipe in All Roadmaps), confirm (answered *Delete Roadmap*), cancel (closed unanswered), held (the engine holds the delete, with the door and openers: some where a step of another roadmap opens it, none otherwise), undo (the band's *Undo*, with outcome: cancelled where the hold let it go, released where the hold had ended and nothing came back). The web's event, with the question and its answer added |
| Roadmap room, the switch and the Graph opened | `roadmap_view_switch` | view: board, graph, the view the switch row's choice gave the open roadmap, and graph also when a roadmap opens on its Graph, at the room's first read, from the title menu or All Roadmaps, or as another takes the place of one gone; steps: 1-100, 101-1000, 1001-5000, 5001-10000, the roadmap's size as a bucket, on each event whose Graph comes up, once as it comes and not as it draws again. A switch to the Graph of a roadmap with no step shows the Board and carries no steps, and choosing the view it shows emits nothing. The web's event, with steps added; the web tells a roadmap opening on a view as its own `roadmap_view_open` |
| Roadmap Graph, Next | `roadmap_whats_next` | step: open (the menu of *Next*, the bar in the foot's band slot, opened), pick (a step chosen from it, which is then selected and brought to the centre of the canvas); count: 0, 1, 2-5, 6-20, 21+, the roadmap's Up next steps as a bucket. The web's event without its close: the system's menu tells the room nothing when it closes with no step chosen |
| Roadmap Graph, Fit | `roadmap_graph_fit` | step: open (*Fit* pressed: the bars leave and the camera goes to the whole roadmap), close (the tap on the canvas that brings the bars back); a Fit ended by the canvas leaving the screen emits nothing. The iPhone's own: the web tells nothing of its camera |
| Roadmap Board, Find | `roadmap_board_search` | no property; emitted once for each words Find looked for, at the search key or as Find closes on words not yet told, by its own close, the Graph shown or another roadmap opened. The web's event. Find's words are never sent |
| Roadmap Board, the Sort and filter menu | `roadmap_board_menu` | menu: sortFilter; emitted as the switch row's Board tool opens its one menu. The web's event, with the iPhone's one menu for the web's two |
| Roadmap Board, the order | `roadmap_board_sort` | sort: roadmap, newest, oldest; emitted when the menu's Sort picker chooses another order. The web's event |
| Roadmap Board, a kind filter | `roadmap_board_filter` | count: 0, 1, 2-5, 6-20, the kinds shown after the toggle as a bucket; emitted when a kind's toggle under *Filter by Kind* changes. The web's event, its count bucketed |
| Roadmap Board, a filter cleared | `roadmap_board_clear` | what: kinds; from: row (*Clear* on the list's first row) or empty (*Clear Filters* on a Board the filter left with nothing). The web's event, with the iPhone's places |
| Roadmap Board, a branch | `roadmap_board_branch` | action: clear (*Clear* on the branch's first row). Viewing a branch is the step page's `roadmap_board_step_action` with action viewBranch. The web's event |
| Roadmap Board, several steps | `roadmap_board_select` | step: start (with door: menu for *Select* in a row's long-press menu, tool for *Select Steps* in the Board's tool), end (with via: done for the checkmark, act once Recolor or Delete N Steps ended it). The web's event, with the iPhone's doors |
| Roadmap Board, an act on several steps | `roadmap_board_bulk` | step: recolor (Recolor wrote every step chosen) or delete (the engine holds their delete), each with count: 1, 2-5, 6-20 or 21+, the steps as a bucket; and step: delete_refused with reason: last_root, as the choice comes to hold every starting step and Delete dims. The web's event |
| Roadmap Kinds | `roadmap_kinds` | step: open (the sheet raised, with door: menu for the title menu's *Kinds*, form for *Edit Kinds* in the step form's Kind list), kind (a kind's page pushed), close (the sheet closed). The iPhone's own: the web edits kinds in a legend panel. A kind's edits are `roadmap_board_edit` with step: saved and legend: add, rename, describe, recolor or remove, the web's event of its legend, emitted once each act is written on the phone |
| Roadmap Activity and History | `roadmap_activity` | step: open, with surface: activity (the roadmap's Activity pushed from the title menu's *Activity*) or history (a step's History pushed from its page's last row) and read: loaded (the domain's read of the phone's copy gave rows) or empty (it gave none, as on a roadmap with no step), emitted once as the screen is pushed; step: unfold, with surface: activity and count: 2-5, 6-20 or 21+, the steps a fold holds as a bucket, as a fold of steps added at once is opened. A row of Activity that opens its step is `roadmap_board_step_open` with door: activity. The iPhone's own: the web's Activity is a panel its verbs tell as `roadmap_verb` |
| Roadmap Guide | `roadmap_guide` | step: open (the title menu's *Guide* raised the sheet, with door: menu, view: board or graph, the view it rose over, and above: none or some, whether guides of the roadmaps above apply), edit (a draft began, with via: edit for the bar's *Edit*, add for *Add Guide*), save (*Save* wrote the draft, with outcome: saved, or cleared for a blank draft, which removes the guide, and length: 0, 1-500, 501-2000, 2001-4500 or 4501-5000, the saved guide's length in code points as a bucket; or outcome: failed with the draft's length and reason: refused where the domain refused the write, device where the phone's commit failed), conflict (after a save of a draft begun from a guide another device has since replaced, which the save writes over), tooLong (the draft went past the guide's 5,000 characters, once each time it goes over), cancel (*Cancel* left an unchanged draft, or the sheet closed over one) and discard (*Discard draft?* answered *Discard*). A save is emitted once the write is on the phone; its *Undo* is `roadmap_board_undo` with act: guide, and the door's own `roadmap_write_refused` with write: guide tells a refused save too. The web's event, with the iPhone's doors; the guide's text, its count of characters and any id are never sent |
| Roadmap room, its first read | `roadmap_first_read` | step: shown (the room's first read of the phone's copy has run half a second and its spinner shows), ended (that wait ended, with outcome: read for a roadmap or none shown, failed for *Couldn’t load this roadmap*, left for the room put away while the read was under way). A first read that ends within half a second tells nothing, and a roadmap gone into that waits for its read tells none. The iPhone's own |
| Roadmap link opened | `roadmap_link_opened` | address: share (the share's `/t/<id>`) or app (the app's `/#/app/<id>`), the claimed form the system handed the app; target: roadmap, step (the address names a step) or none (a claimed address that names no roadmap, which opens All Roadmaps); mine: true where the roadmap is the person's own and opens in the room, on its Board or its step's page, false where it raises a cover; none carries no mine. Emitted once the room has read the phone's copy and followed the link. No address, id, title or name is sent. The iPhone's own: the web opens a link as a page load |
| Roadmap shared roadmap's cover | `roadmap_cover` | step: open, with read: loaded (the roadmap on the Graph with its owner's progress), seeds (the roadmap with its steps' own seeds, the read of its owner's progress having failed), missing (with a connection, the phone can neither read nor hold it: *This roadmap can’t be opened*), offline (no connection and no copy on the phone: *Needs a connection*) or failed (the phone's copy of it could not be read: *Couldn’t load this roadmap*), once a cover, as it first shows something; step: close, with reason: closed (its close button), forked (its fork's copy opened in the room), copy_late (the copy did not arrive within fifteen seconds; the room opens it when it lands) or replaced (another link, or the same one found the person's own after a sign-in). A step page pushed on the cover is `roadmap_board_step_open`, its *Copy Link* `roadmap_board_step_action` with action copyLink, and the switch, Find, sort and filter tell as the room's do. The iPhone's own: the web tells a reader's room as `roadmap_view_open` with role reader |
| Roadmap Fork | `fork_attempt`, `fork_claim` | mode: instant on a roadmap's own screen, browse on a row of the public gallery. `fork_attempt` as *Fork Roadmap* or a gallery row's *Fork* is tapped, then again with outcome: signed_out (the phone has no session it can send as, signed out or while the session waits to be renewed: the shell's sign-in rose over the cover, before any request), unauthenticated (the request found no session to send, or the server answered 401: the sign-in rises), offline (the request found no connection), refused (the server's refusal: a roadmap the person may not read), busy (the server answered 503) or failed. A sign-in closed with no fresh session ends the fork; a fresh one follows the link again, and the fork runs, telling `fork_attempt` anew, once the roadmap is still someone else's. `fork_claim` once the server answers the copy, which the room opens when it arrives. With no connection the cover's *Fork Roadmap* is dimmed, and a subtree's cover has none; neither tells anything. The attach list's *Fork Roadmap*, over a pasted link to someone else's roadmap, tells the same: offline once tapped with no connection, which its band says, and signed_out where *Sign In to Fork* raises the shell's sign-in; its copy heads the person's roadmaps once it arrives. A gallery row's *Fork* tells the same with mode: browse: offline once tapped with no connection or when its request finds none, and failed, refused or busy where it came to nothing, each of which the room's band says, and signed_out where it raises the shell's sign-in; a fresh session first reads the gallery again, and the fork runs only where the row is neither the person's own, which then opens in the room, nor one they hold a copy of; `fork_claim` once the server answers the copy, which the row then offers as *Open Your Copy*. The web's events and their instant and browse modes |
| Roadmap Share | `roadmap_verb` | verb: share; step: open (the title menu's *Share* raised the sheet over a root), publish and private (the switch turned on or off and written on the phone, once a change, with outcome: ok, or failed where the domain refused the write or its commit failed, the switch then standing where the copy holds it; a turn that changes nothing tells nothing), link (*Share Link* pressed, handing the address to the system's share sheet), copy (*Copy Link* put it on the pasteboard), sign_in (*Sign In*, signed out, opened the shell's sign-in over the sheet). Signed out or with no connection the switch is dimmed and tells nothing. The web's event and its publish and private steps; open, link, copy and sign_in are the iPhone's own, the web telling a copy as `link_copy` and a failed one as this event's copy with outcome failed. No address, title or id is sent |
| Roadmap Export | `roadmap_export` | step: open (Export handed the open roadmap's file to the system's exporter, with door: menu for the root's title menu, more for the … menu of a roadmap gone into); outcome: saved (the person chose where the file landed and it was written), cancelled (the exporter closed with nothing saved) or failed (the system could not write it, also reported as `roadmap_export`), with the door. The web's event with its outcome done told as saved, cancelled and failed; step: open is the iPhone's own. The file's name and text are never sent |
| Roadmap public gallery | `roadmap_gallery` | step: open (*Planted in Public* pushed from All Roadmaps), load (the first page read) and page (a later one, as the list's last row comes on screen or under *Try Again*), each with outcome: available (rows came), empty (none came) or failed (no connection, or the request came to nothing: *Can’t reach the gallery just now.*); retry (*Try Again*, on the gallery that could not be reached or under a later page that came to nothing); row (a row opened as its link opens it, with mine: true where the phone opens it in the room as the person's own roadmap, false where it opens on a cover that tells its own `roadmap_cover`); copy (*Open Your Copy*, the copy then opening on its Board, at once where the person's list holds it, else once it arrives). A later page whose cursor the server refuses tells page failed, and the read of the gallery from its start that follows tells load; a sign-in, a sign-out or another account reads it again, telling load. A row's Fork is `fork_attempt` and `fork_claim` with mode browse. The web's event with its load, page and retry steps; open, row and copy are the iPhone's own, and its retry carries no read, where the web's says initial or page. No title, count of steps, id or cursor is sent |
| Roadmap, going into a roadmap a step opens | `roadmap_tree_open`, `roadmap_subtree_open` | door: swipe (a Board row's leading *Open*), step (the step page's Roadmap or Subtree row), foot (*Open Roadmap* or *Open Subtree* at the page's foot); view: board, graph, the view of the roadmap gone in from; `roadmap_subtree_open` for a subtree the step owns, with role: owner. Emitted as the roadmap's room is pushed on the stack, in a roadmap gone into too. The web's events, with the iPhone's doors |
| Roadmap, coming back from a roadmap gone into | `roadmap_tree_back`, `roadmap_subtree_back` | `roadmap_subtree_back` with role: owner; emitted once a going in, as its room leaves the stack: by the system's Back, by its long-press menu, or with the screen it was gone in from, as when another roadmap opens; one Back past several rooms tells each, the deepest first. The web's events |
| Roadmap, attaching a roadmap to a step | `roadmap_tree_attach` | step: open (the attach list pushed, with door: page from the step page's *Attach a Roadmap*, *Change Roadmap* or *Choose Roadmap*, form from the step form's Roadmap row), paste (a copied link pasted, with outcome: own, one of the person's roadmaps, which is chosen; readable, someone else's they can read; unreadable, none they can read, or no roadmap named), fork (*Fork Roadmap* or *Sign In to Fork* tapped, beside `fork_attempt`), attach, change and detach (written: on the page, with mark: kept where the step holds a Done mark the roadmap sets aside or gives back, none otherwise; or the step form's save, with door: form). The web's event, with the iPhone's doors; its retry is the web's alone, since the iPhone's list reads the phone's copy |
| Roadmap Graph, a step selected | `roadmap_graph_select` | column: upNext, locked, done, the group the step stands in; emitted when a tap on the canvas selects a step other than the one selected. A tap on empty canvas, which selects none, emits nothing. The iPhone's own: the web opens a step on the tap |
| Roadmap room, a refused write | `roadmap_write_refused` | write: mark (Complete, Reset, and the done marks of a plan planted), DeleteNode (Delete), createRoadmap (Create, blank or from a plan), ImportSubgraph (Paste Steps' *Add*), title (Rename), visibility (Share's switch), deleteRoadmap (Delete Roadmap), CreateNode (the step form's *Create*, and New Step refused at the registry's cap before any form opens), EditNode (its *Save*), workspace (a subtask or a link of a step's workspace added, checked or removed), note (the note's save), BulkRecolor and BulkDelete (Recolor and Delete N Steps on several steps), and AddKind, RenameKind, DescribeKind, RecolorKind and RemoveKind (the Kinds sheet's acts), guide (the Guide sheet's *Save*), pointer (a roadmap attached, changed or detached on a step's page); refusal: the domain's kind, invalid, gone, taken, tooLarge, full, roadmapGone, unreachable, notARoot, stepOpensARoadmap, depthLimit or other; startingStep where the room keeps a roadmap's one starting step; and the step form's own, before any write: noName (a name typed and cleared) and loop (a tap on a step that would close a loop in *Requires* or *Opens*). The band says a refusal only where it is a limit the boards word (startingStep, full), and the form says its own, and a loop the domain refused, in a footer; the attach list says why a choice was refused under the list; any other shows nothing. The web's event |
| Roadmap room, a change that met one made elsewhere | `roadmap_landing` | rule: follows (a step the person made or linked now follows something else, past a step another device deleted before their change landed) or cameBack (a step their change brought back); place: band (its band was drawn, 10.2 and 10.4) or step (the step's page showed it under its status row before its band was drawn, 10.3). Emitted once a line, the first time either is on screen, as the phone lets the line go from its note; a later visit is quiet. The band is offered a line only while the room stands on screen in the foreground with no sheet of the shell's over it and no other band stands, so no receipt loses its Undo; it is drawn, and the line told, only where the person can see it: not while the screen's foot is away (a field holding the keyboard, the Graph's Fit, the Guide being written, a subtask or a link being added), and on the room's own screens not under a sheet or a cover the room raised. The web's event and its rule, with the iPhone's places. No step's name, title or id is sent |
| Roadmap room, a change that cannot land | `roadmap_write_cannot_land` | reason: roadmapDeleted, capFilled, accessEnded, noteTooLong, the domain's (`CannotLand`). Emitted once a notice of roadmap's the domain lists, Set Aside's or one with no words of the person's that it does not show, however often the engine republishes it: the phone keeps the ids of the notices it has told that the engine still holds (`roadmapToldNotices`), never what they hold. The web's event |
| Roadmap Set Aside | `roadmap_kept` | step: open (the title menu's *N Set Aside* raised the list, with count: 0, 1, 2-5, 6-20, 21+, its changes as a bucket), copy (a change's *Copy*, in its … menu or its swipe, with door: menu or swipe, reason and outcome: copied, its words on the pasteboard), discard (a change's *Discard*, asking nothing, with door and reason, once the engine let its notice go; one the engine no longer held leaves the list and tells nothing), ask (*Discard All* asked, with count), cancel (that question closed unanswered) and discardAll (answered *Discard All*, with count: the notices the engine let go, as a bucket; none let go tells nothing). The web's event and its steps, with the iPhone's doors and its one question for all; the web asks once a change. No change's words, title, roadmap or id is sent |
| Appearance | `appearance_chosen` | appearance: light, dark, system; emitted when You's Settings changes it |
| Update required | `client_update_required` | Android's vocabulary: state: shown with status: 426 once the alert is on screen; action: update (Get the update, from the alert or You), keep (Keep working on this phone); outcome: failed when the destination could not open. trigger: sync (the engine's flag), sign_in (a 426 at sign-in) on every row. Dismissing the could-not-open transient emits nothing |
| Adoption | `room_adoption_answered` | room: journal, gym, roadmap, one event for each room the one answer covers; action: add, discard; no counts or identifiers |
| Returning on a new phone | `sign_in_restore` | stage: started (a sign-in from Where to start? brings rooms back), room_opened (the room last written to opens: its records are in, the connection or session is lost, or nothing lands for 10 s), complete (every room's records are in); no counts, names or rooms. Restore failures report through the sync engine's existing `sync_pull` boundary |
| Delete account | `account_delete` | state: shown (the page opens); outcome: ok (closed and gone from this phone), failed (the request, the phone's flush, sign-out or discard failed, another account change was running, or a 401 after the confirm, when the phone discards the account and lands on You signed out), cancelled (Cancel or Back). No email, id or count. A failure other than offline reports to Sentry under `account_delete`: the request's own boundary, or failure_kind keychain (no session token), flush (a room could not save first), unexpected (the sign-out), and unexpected / sqlite / storage for the discard the phone owes once the account is closed, which it retries on Try again and at the next launch |
| Gym screens | `gym_screen_viewed` | screen: routines, routine, routine_editor (once a visit to the editor, however often the picker pops off it), routine_movement_editor (the movement form: name, equipment, targets and rest), routine_movement (the Add movement picker), movement, log, on_this_phone (the list On this phone opens), session, fix_set, record, bodyweight, weigh_in, session_share, coach, history, notes, note, review (the Routines row's proposal sheet), connected_log, connected_log_guide (How this works), sources (What Coach read), workout, edit_sets (the workout's Edit sets sheet), receipt |
| Outside the app | `gym_activity_set_logged`, `gym_activity_offer_refused`, `gym_intent_opened` | surface: activity (the Live Activity's *Log set*), control (the workout control in Control Center), shortcut (an App Shortcut) on every row; `gym_activity_set_logged`: a set logged durable on the phone; `gym_activity_offer_refused`: outcome: refused (the rack had moved past the offer, or a rule of the log refused the set, and the logger opened), failed (the phone could not save the set and the logger opened, or Windmill could not start to log it and opened instead), absent (a *Log set* shortcut found no workout open); `gym_intent_opened`: intent: start_workout, open_workout (Windmill opened on Routines or on the logger, a *Log set* shortcut with nothing on offer included) |
| Home Screen quick actions | `quick_action` | item: write (*Write tonight*), start (*Start ‹routine›*, which also records `gym_session_started` when the workout begins), open_workout (*Open workout*); once per item chosen, from a cold start or the background. The routine's name is never a property. |
| Coach routine setup | `gym_setup_step` | screen: coach, or receipt for the phone's first signed-out receipt's Keep it (action: keep); action: shown, screenshot, build_manually, drafts_rejected (Reject on the drafts card), save_routines (outcome: failed, when a signed-out result cannot be saved on the phone), routines_saved (after Apply and its durable receipt), open_routine, keep_routines, photo_selected, photo_removed, sign_in (a recovery's Sign in, or the one under a signed-out answer whose call needed the account), connect (the cap's Use your own AI agent). Legacy draft actions remain decode-compatible. No chosen option, goal, program text, image, amount or routine name is sent. Storage failures use the existing static gym_read/gym_action boundary. |
| Training | `gym_session_started`, `gym_set_logged`, `gym_session_finished` | screen: workout; outcome: ok, and refused for a Finish the phone cannot queue |
| Hidden workout | `gym_hidden_workout` | action: hide when the lifter hides the open workout (*Hide workout*, *Build my routine* on a first workout, or a door out of the workout from Coach over it: You, Keep, a routine Coach made, *Build my own*); action: open with door: accessory (the tab bar's accessory, iOS 26) or row (The log's Hidden row, iOS 18) when the lifter brings it back. A return the room cannot make records nothing and leaves the band's *Gym could not restore this workout. Try again.* |
| Routines | `gym_routine_saved` | screen: routine_editor; action: create, update |
| Workout rack adjustment | `gym_workout_adjusted` | screen: workout; field: weight, reps; outcome: ok, failed, refused — once per save of a burst of taps, with what the save came to (refused when the log refuses it or an account change is under way). No numeric value is sent. |
| Workout load typed | `gym_workout_load_typed` | screen: workout; action: open (a tap into the rack's numeral raised the decimal pad), land (the pad let go after its keys changed the load; a pad let go unchanged sends nothing). The load's save reports as `gym_workout_adjusted` field: weight, and its failures under the rack's existing gym_action boundary. No numeric value is sent. |
| Workout movement picker | `gym_workout_picker` | action: open, select, cancel; selection outcome: ok or refused. A refused addition keeps the picker open. No query, movement name, identifier or set value is sent. Existing read/write failures report under gym_read/gym_action. |
| Workout rest target | `gym_rest_target_reached` | screen: workout. Once per rest, when the selected movement's since-last-set clock reaches its rest target (the plan entry's rest, else the rest preference) while the workout is on screen; a rest without a target never sends it. No duration, target, movement or set value is sent. The one light impact it plays is not reported. |
| Workout plan edits | `gym_workout_plan_changed` | action: retarget, add_set, remove_set, swap, add_movement, remove_movement, rest — one event per kind of change a save makes (Edit sets' ✓, Swap, Add movement, a removal from This workout or Edit sets); outcome: ok, refused (the log refused it — a movement with a logged set, a plan changed elsewhere, a finished workout — or the workout could not take an edit then), failed (the phone could not save it); door: workout (the lifter's edit; an applied Coach workout change is `gym_proposal_outcome` target: workout). Storage failures report under the existing gym_action boundary. No movement, target, load, reps or rest value is sent. |
| Receipt plan save | `gym_receipt_plan_saved` | outcome: ok (Done with *Save to ‹routine›* on saved the plan to the routine), refused (the routine changed since the start, or the log refused the save), failed (the phone could not save it); nothing is sent with the switch off. Storage failures report under gym_action. No routine name or change count is sent. |
| Exercise editor | `gym_exercise_updated` | screen: movement; action: rename (only the name changed), equipment (the equipment or the dumbbell count changed); outcome: ok, refused, failed. No exercise name, weight, quantity or identifier is sent. |
| Coach navigation | `gym_action` | screen: coach or history; action: new_chat, view_answer, open_conversation, delete_conversation; door on new_chat: tab, history, handoff, new_chat, workout (Coach opened over the open workout); outcome: ok, failed or refused. Archive failures use static gym_read/gym_action reports. No conversation text, photo, owner, thread or request identifier is sent. |
| Coach | `gym_ask_started`, `gym_ask_outcome`, `coach_turn`, `coach_ability` | screen: coach. `gym_ask_started` once a turn is recorded on the replica; `gym_ask_outcome` once it ended or was refused: answered (completed), cancelled (stopped), refused (declined, a refusal before the stream, or the local admission of a log still arriving), failed (failed or interrupted), capped with cap: allowance (an allowance code) or daily (`coach-rate-limited`), absent (a deployment without the turn route), offline (a send held back with no network); duration_ms. `coach_turn` once per turn that opened (Coach §10.2): state (completed, declined, failed, stopped, interrupted), seat (anon, bound), code (the §6.5 code a failed turn ended on; on an interrupted turn its cause: a §6.5 code the server refused a turn request with, or transport, decode, storage, refusal, other), ability_calls, refusals and answer_bytes as bounded counts, duration_ms. `coach_ability` once per ability call the phone ran, the context reads included (the four list reads and, while a workout is open, its `get_session`): name (the catalog name), outcome (ok, or the refusal code: not-offered, seat-required, invalid-input, invalid-arguments, refused, load-floor, result-too-large, coach-turn-volume). Never the question, the answer, a result, a picture or an id. |
| Proposals | `gym_proposal_outcome` | screen: coach (the card in the conversation, or the Routines row's sheet, whose toolbar Apply and Reject row record the same events); target: workout (a change to the open workout, decided on its own card, which records apply or reject as decided, refused or failed and no stall or retry) or routine; action: apply, reject (Android records the same turn-down as dismiss), retry; outcome: decided, refused, failed, stalled, ok, offline (a decision is decided when the log took it, refused when the phone's rules refuse it, as a target under its movement's load floor, and failed when the log refused it, stalled once a launch when unanswered after 15 seconds, however many Try agains then wait, with no action when the queue cannot be read; action retry is a Try again on a decision still queued, ok when the log took it, offline when its push got no answer — no network, a refused connection, a deadline — and failed when the log answered with a failure; a Try again after the log refused an Apply decides afresh and records apply). Failures report under `gym_action`; offline is this event, never a Sentry Issue |
| Connected log | `gym_connect_tool` | action: connect, manage (Connect a tool, a connected credential's row); outcome: ok, failed (whether the browser opened) |
| Gym actions | `gym_action` | screen: gym, session_share, history, workout, log, session, on_this_phone, review (the Remove that a connected tool's routine removal asks before, on its proposal sheet; Remove routine then records the Apply's `gym_proposal_outcome`); outcome: ok, refused, failed, cancelled. Receipt Share uses action share. Destructive confirmations use action discard + state shown, then action cancel + outcome cancelled on dismissal; committed removals use their existing outcome. No action payloads |
| Log moments | `gym_moment_opened` | no properties; a new-best moment on the log opened its Record |
| Weigh-in entry and history | `gym_action` | screen: log; action: open with item weigh_in for new entry, fix with item weigh_in for correction, inspect with item bodyweight for the chart. Deletion uses screen weigh_in, action discard, outcome saved, refused or failed at the shared write boundary; no date, weight or identifier is sent. |
| Weigh-in form | `gym_action` | screen: weigh_in; action: open, apply or cancel with item date for the staged native calendar; cancel with outcome cancelled for the form; create/update with outcome saved, refused or failed for persistence; fix with outcome refused for validation. No selected day or measurement is sent. |
| Workout receipt | `gym_screen_viewed`, `gym_action` | screen: receipt; action: retry for review recovery, menu when UIKit `UIButton` emits `.menuActionTriggered` before native `UIMenu` presentation. Share, Done, Keep and destructive confirmation retain their existing events. VoiceOver activation requires its own runtime check. |
| Routine editing | `gym_action` | screen: routine_movement_editor; stage with outcome ok or refused (the account changed, the routine is full), cancel with outcome ok. The routine_movement picker records cancel with outcome ok. Outer routine_editor create/update records saved, refused or failed; cancel records ok. The atomic save reports unexpected failures through gym_action. No name, equipment, target value or identifier is sent. |
| Import recovery | `gym_import_recovery` | Android's vocabulary: action: inspect, fix, keep, retry, discard; state (a screen opening only): opened; outcome (a commit or a close only): completed, cancelled, and the iOS-only refused, failed; reason, iOS-only: session-open, session-overlap, id-taken, bad-instant, too-many-sets, invalid-set, unknown-exercise, session-finished, unsent, other |
| Writing | `journal_line_saved` | day_kind: today; emitted after a changed body with non-whitespace text saves |
| Refused save | `journal_save_refused` | reason: too_large (over the page's byte limit, refused on the phone), invalid, claim_conflict, other (the log's refusal); never the page |
| Echo sheet | `journal_echo_ink` | action: open, close, back |
| Echoes | `journal_echo_shown`, `journal_echo_reader_opened`, `journal_echo_intro_dismissed`, `journal_echo_opened`, `journal_echo_useful`, `journal_echo_dismissed` | no properties |
| Synchronization | `sync_pull_outcome`, `sync_push_outcome` | outcome: ok, failed; failure_kind, status, duration_ms |
| Undo of an act | `sync_inverse` | an Undo or Redo of a journaled act (engine K-3). Requested: outcome ok (cancelled in place, or settled at once), pending (its slots wait or travel), unavailable (an act it cannot invert), failed (the transaction did not commit). A request the phone sent that settles later: outcome settled, with `applied` and `skipped` operation counts and `skip_reason`, why operations were skipped: none, the phone's own refusals to send (history-changed, epoch-changed, reference-unbound), the server's conditions (version-changed, record-changed, record-present, scope-changed), or other (a refusal, an unreadable answer, a discard, an ended scope); when slots skipped for several reasons, the first in that order. At engine start, while requests still wait: outcome pending, with how many (`waiting`) and the oldest one's `age_ms`. At sign-in's Add, when the acts it adopted gave up Undo targets because the account's dormant replica holds writes of their records (engine §7.10): outcome adopted, with how many (`given_up`); an Undo asked later plans nothing for them. No act, request or record id and no value |
| Reliability | `api_request_failed`, `client_error` | operation, method, route, status, failure_kind, duration_ms; optional coarse scope_kind |

Echoes reads and feedback stay REST and report failures under the static operation `journal_echoes`
and coarse route `/v1/journal`. Expected HTTP refusals and offline/DNS/connect failures emit only
`api_request_failed`; cancellation is quiet. Timeouts, TLS, unexpected HTTP responses and decoding
failures also reach Sentry. Offline, Echoes adds no cached echo, placeholder, spinner or error to the
journal and never blocks writing. Product events contain no journal text, excerpts, connection
reasons, dates, similarity scores, echo/page identifiers or counts. Echoes REST bodies and dynamic
routes never enter telemetry. Echo events carry only common app metadata, and `journal_echo_ink` its action.

A day's count opens its echo sheet with `journal_echo_ink` action `open`. Close, a swipe down, the count again or the
keyboard closes it with action `close`; the room's own closes (Back to tonight, Not useful, an account sheet taking the
screen, an offline or failed read) record none. *Back to tonight*, or a day in its menu, records action `back`.
`journal_echo_shown` records each verified passage once per foreground session, when its row draws in the sheet; the
count draws no passage and records nothing. The sheet standing at `.large`, every passage by year, records
`journal_echo_reader_opened`, whether it opened there at an accessibility size or the person raised it; the sheet's
other detent changes are the room's or a drag back down and record nothing.
The first echo's *Got it* records `journal_echo_intro_dismissed`. `journal_echo_opened` records following a passage to
its source in the canvas, which lowers the sheet to its smallest detent; the REST opened signal is best effort.
*Useful* records one `journal_echo_useful` per tap and marks every passage the sheet holds, one REST signal each;
*Not useful* records one `journal_echo_dismissed` and retires the page's echo. Both are optimistic and roll back if a
request fails. Closing the sheet dismisses no echo.

Coach archive migration and read failures report under `gym_read`; save, selection and removal
failures use `gym_action`. A turn's failures at the wire or the store report under `gym_coach_turn`
with kinds transport, timeout, http (a 5xx), decode and storage; expected refusals (installation,
update-required, a lost turn, any other 4xx) are `api_request_failed` metrics, and an allowance or the
daily cap is told by `gym_ask_outcome` `capped` alone.
Conversation content, draft text, photo data, archive paths and thread, message, turn or call
identifiers stay out of these reports.

The finished-workout receipt’s Done emits `first_run_choice` with screen `workout` and action `close`.
Its Share tap and destructive confirmation steps emit bounded `gym_action` labels. Confirmed Discard
emits the existing write outcome. Share with Coach retains its intent through sign-in and enters the
existing Coach flow; events contain no workout names, set values or Coach question.

Every door to Share this workout opens one sheet, which records `gym_screen_viewed` with screen `session_share` each
time it is presented. Signed out or paused, its *Sign in to share* opens You (`first_run_screen_viewed` with screen
`you`); when You closes signed in, the sheet is presented again and records its view again, and a sign-in left
unfinished shares nothing and records nothing more.

The Roadmap room's boundary operation labels are `roadmap_read`, `roadmap_write`, `roadmap_plant`, `roadmap_file`,
`roadmap_export`, `roadmap_landing` and `roadmap_kept`, and those of its requests, `roadmap_progress`, `roadmap_fork` and
`roadmap_gallery`.
`roadmap_plant` says a creation from a plan did not stand whole where no limit refused it: failure_kind refusal, with the
domain's refusal kind, for a creation the domain refused other than at the roadmap's cap, which the grammar's bounds should
leave nothing to do; marks for a roadmap planted whose done steps could not be marked after it, refused or failed, the
roadmap standing and the band counting none done. `roadmap_file` says a file New Roadmap's importer handed back could not
be opened, or that the importer handed back none (failure_kind unexpected), with error_domain: cocoa, posix or other, and
error_code: missing, permission, unreadable, cancelled or other, its code as a bucket; it names no file and carries no
message. `roadmap_export` says the system's exporter could not write the file Export handed it: failure_kind storage for a
Cocoa file error, unexpected for any other, with error_domain: cocoa, posix or other and error_code: missing, permission,
space, unreadable, cancelled or other, its code as a bucket, as `roadmap_file`'s, and with no file's name or message; the
person's choice to save nothing is an event. A read reports a view of the person's
roadmaps the room could not ask the engine for (failure_kind unexpected), or records the domain could not read (decode), while
the room shows *Couldn’t load this roadmap* and *The copy on this iPhone couldn’t be read.* with *Try Again*; New Step's read of how many steps the roadmap holds reports the
same way where it throws, and opens no form. The model reports each kind once per launch, since a read runs
again with every change; a view's own failed read of the store reports through the engine's `storage_read`. A write reports
every throw of an act's commit, of an Undo or of letting an act's journal go, when its band leaves or at once for a creation
and a rename, which keep no Undo, with the write as its one label (mark for Complete and Reset, DeleteNode, createRoadmap,
title, visibility for Share's switch, deleteRoadmap, CreateNode and EditNode for the step form's one save, ImportSubgraph for Paste Steps' *Add*, workspace for an act on a step's subtasks or
links, note for the note's save, BulkRecolor and BulkDelete for an act on several steps, AddKind, RenameKind,
DescribeKind, RecolorKind and RemoveKind for the Kinds sheet's, guide for the Guide sheet's save, clearLanding for letting a line told
once go from the phone's note, dismissNotice for Set Aside's *Discard* and *Discard All*, undo, release): failure_kind storage for a commit
the store failed, unexpected for any other, while the room's screens stay as the phone's copy holds them and say nothing, New
Roadmap, New Link, the step form and the Guide's draft staying open; a failure the store itself classifies is the engine's report. A note
whose save is refused or fails as its screen leaves is told so and not kept: the screen has left. A step's page reads the same
views as the Board, its workspace from three more of them in the person's overlay, and adds no boundary: a workspace record the
domain cannot read is the read's decode report, and a step that is
gone while its page, its note or its History is open closes it and reports nothing. Activity and a step's History are the
domain's read of those same views and add no boundary. A refusal is an event (`roadmap_write_refused`), never a
report. `roadmap_landing` says the domain's read of what the phone tells once of a roadmap threw (failure_kind unexpected, or
decode for a record it could not read), once a launch each: the room tells no line and reads on, and the phone's note keeps
what it holds. `roadmap_kept` says a notice no rule of Set Aside lists (failure_kind unexpected, with code: the engine's
refusal code, other where it is not one a code is spelled as), once a launch each code, and only of a notice not told
before; a *Discard* whose dismissal throws is a write's report with write dismissNotice, and the change stays listed. A
notice the engine cannot decode is left out of its notices view with nothing reported, so Set Aside never lists it. The Graph reads the same views and reports two things of its own, each kind once per launch. `roadmap_layout` says the
picture is not the bubble layout's: failure_kind fallback for a roadmap that layout refused and the fallback seated, which
is drawn, and unseated for steps that follow each other in a loop, which have no seats, while the Graph's place says
*Couldn’t load this roadmap*. `roadmap_canvas`, failure_kind budget, says the Graph missed its budget
([Roadmap on iOS](foundation/roadmap-ios.md) §5) on a roadmap of at most 5,000 steps, the size the budget is measured at:
budget first_frame where the first frame that drew the picture came more than a second after the tap that showed the
Graph, the switch or a roadmap opened on its Graph; and frames where a gesture or a glide of the camera of half a second
or more was given more than a tenth of its frames later than a frame and a half at 60 a second, as a display link on the
main actor saw them. Both
carry steps, the roadmap's size as a bucket: 1-100, 101-1000 or 1001-5000. The room's three requests of the backend each
tell `api_request_failed` with their route under their operation where they fail, and report where nobody expects it,
neither no connection nor a status the server answers on purpose: `roadmap_progress` for a shared roadmap's cover's
owner's progress (`GET /v1/trees/{id}/progress`, route /v1/trees), and its failure_kind decode, reported too, for an
answer that is not the contract's or holds a mark row or a subtree row it cannot read, which it leaves out;
`roadmap_fork` for Fork on a cover, the attach list or a gallery row (`POST /v1/trees/{id}/fork`, route /v1/trees), with
mode: cover, attach or browse, where it was asked, and decode for an answer that names no copy; and `roadmap_gallery` for
a page of the public gallery (`GET /v1/gallery`, route /v1/gallery), decode for an answer that is not the contract's, and
decode once a launch for a page that holds a row it cannot read, which it leaves out. The
gallery asks no account: a session the server no longer takes is told as its 401 and the page asked again with none. A
503 is the server busy, told and never reported, and a request its asker gave up, as a cover that closed, tells
nothing. `roadmap_subscribe`, failure_kind
unexpected, says the engine threw as the cover followed a roadmap's scope, while the cover reads what the phone holds,
or with step close as it let one go, and as the attach list follows and lets go a pasted link's roadmap; a scope the
engine answers gone is the person's access, and reports nothing. A cover's read of the phone's copy that throws reports
as the room's own (`roadmap_read`). No event or report carries a roadmap's title, a step's text, a subtask's words, a
note's text, a link's title or address, a kind's name or description, a plan's text, a file's name, a count of
roadmaps, a count of steps or kinds finer than a bucket, what was searched for or an id. The Board measures its first
frame and its scrolls only on a simulator launch that names a file for them (`BoardFrames`), and reports nothing.

Gym boundary operation labels are `gym_read`, `gym_action`, `gym_flush`, `gym_rest`, `gym_reissue_workout_proposal` (a proposal a signed-out workout held that the account did not take),
`gym_activity_request`, `gym_activity_update`, `gym_control_update`, and `gym_import_fix`, `gym_import_keep`, `gym_import_retry`
and `gym_import_discard` for the commits that recover a saved workout. The gym model reports each distinct `gym_read`
failure once per launch, a session whose saved plan this build cannot read included, so a record a view reads on every
render files one report; every failed write reports. A queued Finish whose background confirmation
outlasts 15 seconds reports a `gym_flush` timeout under the offline rule below. The short wait before
Finish reports nothing: when the server does not confirm in time, Finish ends in its local decision,
and a refusal emits `gym_session_finished` with outcome refused.
Expected REST refusals emit metrics. Missing network, refused connections, dropped connections
and timeouts become one `api_request_failed` with `failure_kind=offline` and one informational
Sentry event per offline stretch in the process. The Sentry state has no exception, message,
request, content or identity; the normal scrubber retains only bounded operation labels. Repeated
offline requests and failed sync outcomes are suppressed until a successful sync or sign-in event.
The first-party event stays queued for later delivery. Unexpected responses, TLS and other
transport failures still report as failures. Known missing paths report even when hello is skipped. REST requests retain their captured account and bearer and cancel
on real backgrounding or an account transition; an inactive scene persists drafts while live sync,
REST work continue. Late conversation reads and Stop results are accepted only for
the work they captured. A late Stop reply preserves newer composer text and photos, including their
durable draft. Send reuses the retained request ID after a lost response when question and
attachments are unchanged. These local identifiers remain outside event properties.
Gym engine notices retain typed refusals for local UI only. No movement/routine names, set values,
notes, Coach messages, counts, IDs or REST bodies enter telemetry.
Removal receipts emit the same bounded proposal outcome once, when their durable result is first observed, in the
launch that sent them or after a relaunch: the receipt keeps that its outcome was recorded, and a failure to mark it
reports through `gym_action`. Any other decision records `decided` or `failed` when the log's answer reaches the phone in
the launch that sent it; one still waiting when the app quits records none. A decision the log has not answered after
15 seconds emits its action with outcome `stalled`, once a launch for that decision, though a Retry's wait or the Review
opened again runs out on it after; a queue that cannot be read reports through `gym_read` and the stall carries no
action. Retry pushes the queued command again and emits action `retry` with the push's outcome.
Reading their local journal reports through `gym_read`; failure to
acknowledge a shown receipt reports through `gym_action` and leaves it available for retry.

Gym adoption uses the verified account's explicit Add/Discard decision, one answer for every room due. Finished
signed-out workouts use one whole-session import, with their original set identities and values.
An unfinished workout refused by an account's open workout retains a durable recovery copy; an
explicit Keep as finished imports it as finished at its last set. It is never silently
joined into the account workout. The recovery copy is refreshed before each change of the replica; a
failed refresh reports through `gym_action` and aborts that account change, which its auth operation
also reports. Recovery commits also emit the bounded `gym_action` outcomes;
adoption approvals use `room_adoption_answered`, without workout counts, content or identifiers.

A saved workout the account has not taken is a row of The log's **On this phone** section with the
reason the engine notice or the phone's own retry checks give it; the Log tab's badge counts the
rows waiting on the lifter. Opening Inspect, opening Fix workout, Keep, Retry, Save and retry and Discard each
emit one `gym_import_recovery` with the action and the reason as bounded labels, in the vocabulary
Android's event uses. Opening Inspect or Fix workout is `state=opened`. A queued commit is
`outcome=completed`; when the log refuses it, the action is recorded again with `outcome=refused` and the row's new
reason once that answer reaches the row (kept in memory, so an answer that arrives after the app quits records nothing).
Closing Fix workout without saving is `fix` with `cancelled`. Confirmed Discard returns to The log
and emits `discard` with its commit’s outcome. Cancelling the confirmation keeps the workout. A retry that lands dismisses the notices it answered. A
restart queues the start and every saved set in one plan, or refuses whole; sets a landed workout
refused go back into it in one plan, appended while it is open or through an additive correction,
and the ones outside its window become a saved copy of their own whose import is queued. An
unexpected storage or engine failure of a commit reports to Sentry under its action's own operation
(`gym_import_fix`, `gym_import_keep`, `gym_import_retry`, `gym_import_discard`) and the outcome is
`failed`; a refusal the phone or the log gives is the outcome `refused` and never a Sentry issue. No
times, movement names, set values, notes, counts or identifiers enter the event.

An app the server finds too old is an expected refusal, never a Sentry Issue: every HTTP boundary reads
`ExpectedStatuses`, so a 426 from sync or an auth route is an `api_request_failed` metric whose message never
reaches the screen, and the engine's upgrade-required sign-in error is skipped by the auth boundary report. The engine
requires the upgrade only for a 426 whose body names `upgrade-required`; a bare 426 (a proxy) backs off like any
failure. `client_update_required` records the alert once it is on screen — after the introduction or another alert,
when one is in front — which the app shows once per launch while the flag holds and again for each sign-in the
server refuses for it. Signed out the alert reads *Update Windmill to sign in.*; signed in, *to keep syncing*.

Screen and choice events also record visits when the same screens are revisited after first run.
Apple auth operations use static labels `auth_apple`, `auth_apple_create`, `auth_verify_code`,
`auth_methods` and `auth_apple_remove`. Removal uses method `DELETE`; reading methods uses `GET`.
Gym REST uses `GET` for reads, `POST` for share creation and `DELETE` for share revocation; gym records,
conversations included, are written only through the engine. A Coach turn uses the turn routes:
`POST /v1/gym/coach/turns` opens a stream, `GET …/{turnId}` resumes it, `POST …/results` answers a batch
of ability calls the phone ran on its replica, `POST …/stop` asks for Stop. A signed-out turn
authenticates with the installation credential (POST to issue it, GET to read its allowance, POST to
bind its cost after verified sign-in). Installation calls use `ai_installation` and the `/v1/ai` route
family; turn calls use `gym_coach_turn` and `/v1/gym`. The separate installation Keychain service
reports read/write failures with `keychain_read`/`keychain_save` and never replaces an unreadable or
rejected credential. Expected installation, rate and allowance refusals are metrics; accounting and
unexpected transport/decoding failures report to Sentry. Stop records `gym_ask_outcome:cancelled` once
the turn ended stopped. Applying an archived signed-out answer's drafts uses `gym_action`; no creation
receipt appears until all routines and their replay marker commit.
Keep, sign-in and Add/Discard retain the existing account/adoption events; installation costs bind
independently of whether local content is added or discarded. Local drafts, photos, result identities,
allowance amounts and IP signals never enter product events or failure properties.
The simulator model follows the same auth-boundary failure reporting, without secrets in diagnostics.
A legacy Apple door returning `created: true` is a decode failure; its session never reaches the engine.
`auth_pending` is You's *Finish signing in* section, an authenticated sign-in awaiting engine recovery, drawn above
the rest of You; `retry` resumes the retained identity without repeating code verification or ticket creation, and
`cancel` gives the sign-in up: the engine forgets it, the verified session is revoked and `auth_signed_in` carries
outcome `cancelled`. In-process authenticated sign-in retries
also run after a five-second delay while the app is open; restored engine sign-ins use the account
recovery cooldown below. Completing a restored app sign-in retains its method and linked outcome.
Paused Apple linking validates the verified account id before bearer attachment. Apple removal treats
HTTP 404 as already removed, alongside 204.

The four-page introduction records each viewed page, Skip and completion; opening About Windmill
records replay before the sheet's page views. Its labels contain no picture text or user content.
Account recovery runs independently of introduction gating and scene changes. Interrupted recovery
stays retryable and emits no outcome; a failed initial restore emits `auth_restore: failed`, and a later
successful retry emits its restored outcome. Retries are single-flight with a jittered 1–30 second
exponential cooldown. Install history is captured before engine credential cleanup and is never telemetry.
No page counts, record IDs, dates, text, scale values or account identity are included in properties.
The wire schema is `{sessionKey, platform: "ios", events: [{id, name, clientMs, props}]}`.
UUID event IDs and the session key persist across relaunch and retries.

## Delivery and limits

Queue restoration opens and decodes the file on a detached utility worker, independently of journal
startup. A 1 MiB size check precedes reading/decoding, and the read itself is capped to reject growth
between checking and reading. Enqueues await the same restoration and preserve restored IDs.
The actor-owned queue writes atomically before sending, excludes its directory from backup and uses
file protection until first unlock. It retains at most 500 events across account shelves and sends
batches of at most 50. Full queues reject new events and report `telemetry_overflow` once until
delivery frees capacity. Queue failures cannot fail a journal action. Launch and identity changes
attempt delivery, and a running process schedules a flush every 30 seconds. Delivery failures wait
30 seconds before retrying. Storage failures retain dirty state and retry persistence before delivery,
even at capacity, with exponential backoff from 1 second capped at 30 seconds. New events cannot
bypass that storage backoff; a scheduled flush can recover without relaunch or another event.

Anonymous queued events always send without credentials, including after sign-in. An account's
events wait until that account is active with a usable token. Account identity is local queue routing
metadata and is omitted from the wire batch. Tokens remain in memory/Keychain, never in the event
file. A request in flight retains its original credential and acknowledges only its captured IDs.
The backend resolves signed-in identity from the bearer, independently of event properties.

`202 {"accepted":N}` removes the submitted batch. Partial acceptance reports `telemetry_rejected`
and drops the entire submitted batch because the client cannot identify rejected entries. An invalid
acknowledgement retains the events and IDs. Unexpected delivery failures report once per failure
streak, reset after success, without recursively producing a product event. Expected HTTP statuses,
offline and cancellation do not create delivery Issues. Storage errors likewise use Sentry directly.

Delivery is bounded best effort. Uninstall, corrupt storage, a full queue, termination before an
asynchronous enqueue, or an account that never returns can lose events. Stable IDs let Amplitude
deduplicate retries; Postgres may retain repeated accepted entries. Backend forwarding has no durable
outbox, so neither local persistence nor Postgres receipt proves vendor delivery.

ActivityKit request failures report `gym_activity_request`; offer persistence and clock-correction read failures report
`gym_activity_update`, with bounded failure kinds only. Local updates carry no titles, movement names,
loads or identifiers into telemetry. ActivityKit update itself has no throwing failure channel.
Rack edits synchronously replace or revoke the durable offer before accepting new values. A failed
write rejects the edit visibly and makes one separate synchronous revocation attempt; continuing
storage failure blocks logging. Activity dates subtract the current engine server offset so its
workout/set clocks and four-hour expiry use device wall time. An unreadable offset prevents publication.
Every reconcile also writes the workout control's state (the offer, or whether a workout is open, and its stale point)
to the App Group file the extension's control reads, then reloads the control; a failed write reports
`gym_control_update` with failure kind storage, a missing App Group container unexpected, each once until the state
changes; an unreadable clock offset publishes nothing and reports `gym_control_update` storage or unexpected, unless
storage already reported the read. The app embeds the `WindmillWorkoutActivity` widget extension. Release generation selects automatic
signing and sets its team and build number to the app’s values.

## Release readiness

`WM_APPLE_SIGN_IN_ENABLED=NO` is the default: `Tools/Windmill-NO.entitlements` declares no Sign in
with Apple capability. Every app entitlement file and `Tools/WorkoutActivity.entitlements` declare the App Group
`group.works.windmill.app`, registered in the developer portal and assigned to `works.windmill.app` and
`works.windmill.app.workout-activity`. Debug builds take `Tools/Windmill-Debug-NO.entitlements` or `-YES`, each its
Release twin with the associated domain `applinks:windmill.works` added, so a roadmap's link opens the Roadmap room; the
Release files carry none, and the App ID has no Associated Domains capability. `YES` selects the entitlement and UI only for a configured server/team.
Apple sign-in remains postponed pending developer-portal setup and a real-device check.
`CFBundleVersion` follows `CURRENT_PROJECT_VERSION`. The app's `PrivacyInfo.xcprivacy` declares
UserDefaults for local app state and monotonic time for elapsed durations, with no tracking. Its
collection declarations distinguish journal/auth synchronization from analytics; writing and scale
values have only the app-functionality purpose. Sentry and GRDB bundle their own manifests. The
manifest follows [Apple's required API reasons](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
and [data collection categories](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype).

`.github/workflows/ios-release.yml` runs only through `workflow_dispatch`, with Xcode 27.1. It uses
`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, `IOS_DEV_CERT_P12_BASE64`,
`IOS_DEV_CERT_PASSWORD` and `IOS_SENTRY_DSN`. `IOS_DEV_CERT_P12_BASE64` is the base64 of a
password-protected .p12 holding one Apple Development certificate and its private key; the workflow
imports it into a temporary keychain, so automatic development signing reuses that certificate
instead of creating one per run. It archives with automatic development signing (a registered device
is required), fails if the app or its extension is signed by any other certificate, then
exports/re-signs for App Store Connect and uploads. The certificate expires after a year; then export
a new one from Keychain and set both secrets again. Build number is the workflow run number. It never
forces a distribution identity onto SPM targets. dSYMs are retained as CI artifacts; uploading them to Sentry requires
authentication beyond the DSN and is not configured with the existing secrets.

After upload, `Tools/AppStoreBuildStatus.swift` reads the archive's bundle identifier, version and
build, then polls Apple's [build status endpoint](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds)
for up to ten minutes. The existing runner-only key signs short-lived, GET-scoped JWTs. CI records
only processing and internal/external beta states in structured status lines and a versioned JSON
artifact. Static `app_store_status` error codes identify failed lookup, invalid responses and HTTP
status without response bodies, tokens or private keys. Pending or inaccessible status never means
tester access is confirmed; a status failure after successful upload must not trigger another upload.

## Local checks

Always use `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` locally.

```sh
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
export IOS_SENTRY_DSN=https://nonproduction@example.invalid/1 # Local/CI verification only.
cd apps/ios/App
xcodegen generate
python3 -m unittest discover -s Tools/tests -v
xcodebuild test -project Windmill.xcodeproj -scheme Windmill \
  -destination 'platform=iOS Simulator,id=<own-simulator-uuid>'
# Build Windmill in Debug and Release for generic/platform=iOS Simulator, then inspect both:
codesign -d --entitlements :- <derived-data>/Build/Products/Debug-iphonesimulator/Windmill.app
codesign -d --entitlements :- <derived-data>/Build/Products/Release-iphonesimulator/Windmill.app
# From each package directory:
swift test # Sync (twice), Domain and SyncTestingSurface
# From Sync:
xcodebuild build -scheme WindmillSync-Package -destination 'generic/platform=iOS Simulator'
# From the repository root:
actionlint .github/workflows/ios.yml .github/workflows/ios-release.yml
```

Regression tests block the technical sink while committing and subscribing, proving it does not
enter adaptive writer timing; they also exercise queue restoration off startup, oversized/growing
files, storage backoff and recovery of a full 500-event dirty queue without relaunch.

The simulator-only `-scenario telemetry-first-run -report <path> -code-file <path>` fixture uses the
real backend with a seeded development code in a throwaway database. It saves anonymously, chooses
Keep, signs in, backs up, exercises session revocation/reauthentication and sign-out, and returns to
the same account. With Resend unset, its final code request forces a real handled 502 auth failure.
Run with `-server http://127.0.0.1:8089 -telemetry -sentry-dsn http://ios@127.0.0.1:8091/42`, a local
Sentry envelope collector and the checkpoint helper described in App/README.md. Inspect `events`
with `props->>'platform'='ios'` and the collector envelope for excluded content and scrubbed fields.
These checks establish first-party and local SDK receipt. Native crash delivery, real Apple sign-in,
Sentry symbolication, Amplitude acceptance and App Store Connect/TestFlight upload require separate
credentials/device or vendor checks.

The eight-step isolated backend account/Journal journey records 41 first-party iOS events and one
decoded handled Sentry envelope for `auth_request_code` / HTTP 502. Its privacy scan finds none of
the fixture page text, email or auth code. Local evidence is
`/tmp/ios-gym-ui-verify/telemetry-journey.log` and `telemetry-evidence.json`. This covers that account
journey's intake and failure scrubbing. The signed Gym backend journey separately records 99
first-party events, including combined-editor stage, workout-picker open/cancel, weigh-in calendar
open/cancel, fresh Coach entry from the tab and receipt menu activation. Across the isolated run,
352 structured writes are recorded. The Gym scan finds no fixture content, email, session tokens or
links in events or Sentry envelopes (`gym-telemetry-evidence.json`). These checks establish the named
local paths, not external Amplitude forwarding or production Sentry receipt.

The isolated serial signed journey also passes with 99 events covering the same changed steps and
a clear privacy scan (`gym-serial-evidence.json`). It records one `App Hang Non Fully Blocked` after
edited-set Save as the load-wheel sheet closes, in addition to three parallel-run reports. The original
baseline journey passes with 84 events and the same hang category at the same boundary; its privacy
scan is clear and original/copied debug-library hashes and UUIDs match (`baseline-native/evidence.json`).
Sampled stacks identify framework UI work, not a changed flow function. This establishes a pre-existing
simulator responsiveness issue, not harmlessness or severity/rate equivalence. The scoped comparison
is `/tmp/ios-gym-ui-verify/gym-hang-audit.md`; the load-wheel Release/device profiling follow-up is in
[App/WORK_LOG.md](../apps/ios/App/WORK_LOG.md).

The Roadmap room's run builds the app with `IOS_SENTRY_DSN=http://ios@127.0.0.1:8091/42`, `WM_DEBUG_TELEMETRY=YES` and
`WM_TELEMETRY_ENVIRONMENT=test` through `Tools/generate_project.py` and `WM_SERVER_BASE_URL=http://127.0.0.1:8089` on the
`xcodebuild build-for-testing` line, so every board launch of the room's UI tests posts its events to a local backend on a
throwaway database while the in-process model server serves sync and the covers' requests. `ShellFlowTests` but account
deletion, `RoadmapFlowTests`, `RoadmapNestedFlowTests` and `RoadmapSharingFlowTests`, with Sort's Newest First, a row
menu's Complete and Back from a subtree walked once by a journey kept outside the suites, record 1,328 first-party iOS
events, 505 of them the room's, and every Roadmap row of the table above arrives with labels its row names.
`RoadmapIntegrationFlowTests`, against the verify skill's backend, posts `roadmap_verb` (open, publish, copy, link),
`roadmap_export` (open and saved, door menu), `roadmap_gallery` (open, load available, copy), `fork_attempt` and
`fork_claim` with mode browse and `roadmap_sheet` (switch, door gallery), each with only the labels its row names.
`-board roadmap-unreadable` forces `roadmap_read` (unexpected)
and `-board roadmap-unwritable` `roadmap_write` (storage, write mark); each arrives at the envelope collector as one
handled event with its allowlisted tags and no message, request, user, extra or breadcrumbs, beside its `client_error`
event, and so do `roadmap_file` and `roadmap_canvas` (budget frames), beside 17 App Hang reports of the simulator. Every
property of every event passes the allowlist, and neither the events nor the envelopes hold a fixture's roadmap, step,
subtask, note, link or guide text, an email, an address or an id. The run reaches no `roadmap_layout`, `roadmap_plant`,
`roadmap_progress`, `roadmap_fork` or `roadmap_subscribe`: no board seats a loop or refuses a plan, and the boards' covers
answer their own requests. Local evidence is `.claude/scratch/roadmap-ios/events-arrive/evidence/` (`rows.txt`,
`timeline.txt`, `analysis.json`, `envelopes.jsonl`). These checks establish the named local paths, not Amplitude
forwarding or production Sentry receipt.

## Coach engine libraries

The `Agent` and `WindmillPlatform` packages expose telemetry ports for their library integration. The App's Roadmap Coach
routes them (`App/Sources/Roadmap/Coach/RoadmapTurnHost.swift`, `CoachTelemetry`): `hostFailure()` reports `agent-host`
(kind host), `AiDiagnostics` reports `ai-call` and `ai-pass` with their kinds, the ability and turn outcomes become
`roadmap_coach_ability` and `roadmap_coach_turn` above, a failure of the App's own wiring around a turn (a seat it
cannot read, its records written or withdrawn before the engine runs, or a profile that cannot be built) reports
`roadmap-coach-turn` (kind storage or unexpected), and an Undo of a direct write that throws, or a settling Undo's read,
once for each kind while the room lives, reports `roadmap_write` with write coachUndo, as History's delete reports it with
write coachDelete. History's delete is held with the room's band and its Undo, and tells no event: Roadmap Coach §13 names
none. The App's gym Coach keeps its own event and failure routes above. `Agent.Telemetry`
receives one ability outcome with a profile-allowlisted name (unknown names become `unoffered`)
and bounded refusal code, and one turn outcome with state, seat kind, bounded code, rounds,
admitted executions, gate refusals, answer bytes and elapsed milliseconds. Host-returned codes
outside the profile and engine allowlists become `unknown` in telemetry. Its `hostFailure()` port
carries no data and must report static operation `agent-host`: unexpected host/storage/runtime
failures at open, recovery, marks, visible text, ability checks/execution or completion use this port.
Expected record-gone, stale-seat and host refusals produce no Issue. These failures are distinct
from AI wire defects.

`AiDiagnostics` receives only static operation `ai-call` or `ai-pass` and kind `wire`, `refusal` or
`transport`. It reports malformed answers, unexpected transport failures and defect refusal codes.
Offline connections, proxy responses without a valid service refusal, recognized temporary pass
refusals and actionable refusals create no Issue. Recovery `call_unknown` is quiet because its mark
may precede dispatch; a live `call_unknown` remains a defect. A pass-expired answer refreshes once;
a second reports a defect. Picture repair follows the same once-only rule. Passes, installation and
session credentials, seat keys, call IDs, prompts, questions, text deltas, assistant carry and tool
inputs/results never enter these ports. The shared-story tests assert complete telemetry traces;
platform tests reject malformed event, allowance, pass and refusal shapes before delivery, assert
delayed old-seat replies cannot publish allowance or authorize another seat, and prove a suspended
response ends at the whole-round deadline. Host fault tests assert only `agent-host`, with no raw
error text. Offline pass and picture requests map to the offline outcome without an Issue.
