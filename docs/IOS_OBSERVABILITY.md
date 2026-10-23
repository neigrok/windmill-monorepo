# iOS observability

The Journal/Gym app uses Sentry Cocoa 9.29.0 through SPM for technical failures. Product events go to
the first-party `POST /v1/events` intake, which stores them in Postgres and forwards them to Amplitude.
The app contains no Amplitude API key. `SyncEngine.Telemetry` is injected into the app, account coordinator, journal and gym models,
authentication, HTTP transport, engine, Keychain and protected storage. Tests default to `NoopTelemetry`.

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
once per doubt episode. Engine and app runtime adapters enqueue static diagnostics through
`BoundedTelemetry`: a serial utility worker invokes the sink outside engine/writer/publisher locks.
At most 128 records wait behind one in flight; overflow silently drops new diagnostics. A blocked
sink cannot delay commits/subscriptions or enter adaptive writer timing.
HTTP owns transport reports; the engine's deadline uses the same invocation
diagnostics to avoid a second report and retains the failure kind in pull/push outcome metrics.

HTTP failures carry method, coarse route family (`/v1/ai`, `/v1/auth`, `/v1/me`, `/v1/sync`, `/v1/gym`, `/v1/journal` or `/v1/events`), a static
operation, `failure_kind`, optional numeric status label and `duration_ms`. Duration uses a monotonic
clock through response consumption and decoding. Sync outcomes also cover application of the reply
to the local store. Expected statuses 400, 401, 403, 404, 409, 410, 422, 426 and 429 are product/API metrics,
not Sentry Issues, and so is a sync push's 413, which the engine halves or refuses too-large. A deployment without Coach
does not mount `POST /v1/gym/ask`, so a send meets the server's 404 page: `api_request_failed` carries status `404`,
`gym_ask_outcome` carries `absent`, and the room states the unavailable stance with no composer and no retry. Coach's
`503 ask-not-configured`, over HTTP or in the stream, reads the same way with status `503`. A streamed ask that goes idle or
drops reconnects up to three times; each attempt still records `api_request_failed`, and only the failure the ask gives up on
reports to Sentry under `gym_rest`.
Known USD allowance refusal codes at status 503 are also expected refusals; accounting failures remain
reportable. The typed allowance state retains partial creation receipts and the editable draft without
an automatic retry. Amounts, reset timestamps and request IDs never enter telemetry.
Offline/DNS/connect failures are metrics, and so is a live socket the server or the network drops with no close
frame; cancellation is quiet. Timeouts, TLS, unexpected HTTP responses and decoding failures are reportable. Sync
files each once per outage: a retry that fails as the one before it did is a metric alone until its operation
succeeds or fails another way. No URL, dynamic identifier, query string, authorization header or response body
enters telemetry.

The promise is **Only you.** Never send journal text, text length, mood or energy values, email
addresses, Apple subjects/tickets/identity tokens, session tokens or response bodies. Apple tickets
live in memory only and are cleared on dismissal, expiry or completion. Product properties pass a finite allowlist of labels;
unknown event names, property names and label values are discarded. Duration is the only numeric
product property and is clamped to 0–86,400,000 ms. Version/build/release metadata is bounded.

The final Sentry send hook removes messages, requests, extras, breadcrumbs, user identity, transaction
and server names, arbitrary tags and custom contexts. It strips exception messages and mechanism
details while retaining compiled exception types, stack traces, release and technical operation tags.
Only bounded technical fields of app/device/OS/runtime contexts and a reconstructed numeric `telemetry.duration_ms` survive.
Device-app hashes, view names and locale are removed. Memory introspection, screenshots, view hierarchy, replay, logs, metrics, tracing, profiling and
MetricKit are disabled. Technical reports contain no product navigation history.

## Product events

The allowlist below covers the app's screens and actions. Property labels accept only fixed values;
status and duration use the bounded numeric rules above. Every row also carries the common
platform/version/build/release/environment properties. Scale answers record only that the invitation
was answered or declined; neither the scale name nor its value is recorded. Journal ink emits
`first_run_screen_viewed` with screen `ink_notes` for its automatic first-open presentation and `first_run_choice` with
action `dismiss_ink` once when writing or a tap lifts it; no ink replay action is allowlisted.

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
| Choices | `first_run_choice` | screen; action: open_journal, open_gym, dismiss_ink, write, done_writing, keep, close, email, back, change_email, resend, add, discard, cancel, sign_out, use_account, create_account, remove_apple, retry. Sign out and the answer to its alert (keep, discard, cancel) are screen you |
| Rooms | `room_switched` | room: journal, gym; emitted after switching |
| Appearance | `appearance_chosen` | appearance: light, dark, system; emitted when You's Settings changes it |
| Update required | `client_update_required` | Android's vocabulary: state: shown with status: 426 once the alert is on screen; action: update (Get the update, from the alert or You), keep (Keep working on this phone); outcome: failed when the destination could not open. trigger: sync (the engine's flag), sign_in (a 426 at sign-in) on every row. Dismissing the could-not-open transient emits nothing |
| Adoption | `room_adoption_answered` | room: journal, gym, one event for each room the one answer covers; action: add, discard; no counts or identifiers |
| Returning on a new phone | `sign_in_restore` | stage: started (a sign-in from Where to start? brings rooms back), room_opened (the room last written to opens: its records are in, the connection or session is lost, or nothing lands for 10 s), complete (every room's records are in); no counts, names or rooms. Restore failures report through the sync engine's existing `sync_pull` boundary |
| Delete account | `account_delete` | state: shown (the page opens); outcome: ok (closed and gone from this phone), failed (the request, the phone's flush, sign-out or discard failed, another account change was running, or a 401 after the confirm, when the phone discards the account and lands on You signed out), cancelled (Cancel or Back). No email, id or count. A failure other than offline reports to Sentry under `account_delete`: the request's own boundary, or failure_kind keychain (no session token), flush (a room could not save first), unexpected (the sign-out), and unexpected / sqlite / storage for the discard the phone owes once the account is closed, which it retries on Try again and at the next launch |
| Gym screens | `gym_screen_viewed` | screen: routines, routine, routine_editor (once a visit to the editor, however often its steps pop), routine_movement_editor (combined name, equipment and targets), routine_movement (the Add movement picker), movement, log, on_this_phone (the list On this phone opens), session, fix_set, record, bodyweight, weigh_in, session_share, coach, history, notes, note, review (the Routines row's proposal sheet), connected_log, connected_log_guide (How this works), sources (What Coach read), workout, receipt |
| Outside the app | `gym_activity_set_logged`, `gym_activity_offer_refused`, `gym_intent_opened` | surface: activity (the Live Activity's *Log set*), control (the workout control in Control Center), shortcut (an App Shortcut) on every row; `gym_activity_set_logged`: a set logged durable on the phone; `gym_activity_offer_refused`: outcome: refused (the rack had moved past the offer, or a rule of the log refused the set, and the logger opened), failed (the phone could not save the set and the logger opened, or Windmill could not start to log it and opened instead), absent (a *Log set* shortcut found no workout open); `gym_intent_opened`: intent: start_workout, open_workout (Windmill opened on Routines or on the logger, a *Log set* shortcut with nothing on offer included) |
| Home Screen quick actions | `quick_action` | item: write (*Write tonight*), start (*Start ‹routine›*, which also records `gym_session_started` when the workout begins), open_workout (*Open workout*); once per item chosen, from a cold start or the background. The routine's name is never a property. |
| Coach routine setup | `gym_setup_step` | screen: coach, or receipt for the phone's first signed-out receipt's Keep it (action: keep); action: shown, screenshot, build_manually, clarify (a choice chip), drafts_rejected (Reject on the drafts card), save_routines (outcome: failed, when a signed-out result cannot be saved on the phone), routines_saved (after Apply and its durable receipt), open_routine, keep_routines, photo_selected, photo_removed, sign_in (a recovery's Sign in, or the one under a signed-out answer that needs an account), connect (the day's cap's Use your own AI agent). Legacy draft actions remain decode-compatible. No chosen option, goal, program text, image, amount or routine name is sent. Storage failures use the existing static gym_read/gym_action boundary. |
| Training | `gym_session_started`, `gym_set_logged`, `gym_session_finished` | screen: workout; outcome: ok, and refused for a Finish the phone cannot queue |
| Hidden workout | `gym_hidden_workout` | action: hide when the lifter hides the open workout (*Hide workout*, or *Build my routine* on a first workout); action: open with door: accessory (the tab bar's accessory, iOS 26) or row (The log's Hidden row, iOS 18) when the lifter brings it back. A return the room cannot make records nothing and leaves the band's *Gym could not restore this workout. Try again.* |
| Routines | `gym_routine_saved` | screen: routine_editor; action: create, update |
| Workout rack adjustment | `gym_workout_adjusted` | screen: workout; field: weight, reps; outcome: ok, failed, refused — once per save of a burst of taps, with what the save came to (refused when the log refuses it or an account change is under way). No numeric value is sent. |
| Workout movement picker | `gym_workout_picker` | action: open, select, cancel; selection outcome: ok or refused. A refused addition keeps the picker open. No query, movement name, identifier or set value is sent. Existing read/write failures report under gym_read/gym_action. |
| Exercise editor | `gym_exercise_updated` | screen: movement; action: rename (only the name changed), equipment (the equipment or the dumbbell count changed); outcome: ok, refused, failed. No exercise name, weight, quantity or identifier is sent. |
| Coach routine confirmation | `gym_coach_routine_confirm` | outcome: started when a signed-in Apply sends its confirmation; saved when the server saved the draft, even when the lifter has moved to another conversation; refused when the server answers 4xx; failed for a 5xx or no answer. A confirmation the phone cancels for an account change records nothing more. Only failed reports to Sentry, under `gym_rest`. No routine name, draft or identifier is sent. |
| Coach navigation | `gym_action` | screen: coach or history; action: new_chat, view_answer, open_conversation, delete_conversation; door on new_chat: tab, history, handoff, new_chat; outcome: ok, failed or refused. Archive failures use static gym_read/gym_action reports. No conversation text, photo, owner, thread or request identifier is sent. |
| Coach | `gym_ask_started`, `gym_ask_outcome` | screen: coach; outcome: answered, cancelled, failed, refused, capped, fresh, absent, and offline for a send the phone held back with no network; cap: daily, ceiling, allowance; duration_ms |
| Proposals | `gym_proposal_outcome` | screen: coach (the card, in the conversation or on the Routines row's sheet); action: apply, reject (Android records the same turn-down as dismiss), retry; outcome: decided, failed, stalled, ok, offline (a decision is decided when the log took it and failed when the log refused it, stalled once a launch when unanswered after 15 seconds, however many Try agains then wait, with no action when the queue cannot be read; action retry is a Try again on a decision still queued, ok when the log took it, offline when its push got no answer — no network, a refused connection, a deadline — and failed when the log answered with a failure; a Try again after the log refused an Apply decides afresh and records apply). Failures report under `gym_action`; offline is this event, never a Sentry Issue |
| Connected log | `gym_connect_tool` | action: connect, manage (Connect a tool, a connected credential's row); outcome: ok, failed (whether the browser opened) |
| Gym actions | `gym_action` | screen: gym, session_share, history, workout, log, session, on_this_phone; outcome: ok, refused, failed, cancelled. Receipt Share uses action share. Destructive confirmations use action discard + state shown, then action cancel + outcome cancelled on dismissal; committed removals use their existing outcome. No action payloads |
| Log moments | `gym_moment_opened` | no properties; a new-best moment on the log opened its Record |
| Weigh-in entry and history | `gym_action` | screen: log; action: open with item weigh_in for new entry, fix with item weigh_in for correction, inspect with item bodyweight for the chart. Deletion uses screen weigh_in, action discard, outcome saved, refused or failed at the shared write boundary; no date, weight or identifier is sent. |
| Weigh-in form | `gym_action` | screen: weigh_in; action: open, apply or cancel with item date for the staged native calendar; cancel with outcome cancelled for the form; create/update with outcome saved, refused or failed for persistence; fix with outcome refused for validation. No selected day or measurement is sent. |
| Workout receipt | `gym_screen_viewed`, `gym_action` | screen: receipt; action: retry for review recovery, menu when UIKit `UIButton` emits `.menuActionTriggered` before native `UIMenu` presentation. Share, Done, Keep and destructive confirmation retain their existing events. VoiceOver activation requires its own runtime check. |
| Routine editing | `gym_action` | screen: routine_movement_editor; stage with outcome ok or refused, update with item targets and outcome refused, cancel with outcome ok. The routine_movement picker records cancel with outcome ok. Outer routine_editor create/update records saved, refused or failed; cancel records ok. The atomic save reports unexpected failures through gym_action. No name, equipment, target value or identifier is sent. |
| Import recovery | `gym_import_recovery` | Android's vocabulary: action: inspect, fix, keep, retry, discard; state (a screen opening only): opened; outcome (a commit or a close only): completed, cancelled, and the iOS-only refused, failed; reason, iOS-only: session-open, session-overlap, id-taken, bad-instant, too-many-sets, invalid-set, unknown-exercise, session-finished, unsent, other |
| Optional scales | `scale_invitation_shown`, `scale_invitation_answered` | action: answered, declined (on `scale_invitation_answered` only) |
| Writing | `journal_line_saved` | day_kind: today; emitted after a changed body with non-whitespace text saves, never for scale-only changes |
| Echo ink | `journal_echo_ink` | action: open, close |
| Echoes | `journal_echo_shown`, `journal_echo_reader_opened`, `journal_echo_intro_dismissed`, `journal_echo_opened`, `journal_echo_useful`, `journal_echo_dismissed` | no properties |
| Synchronization | `sync_pull_outcome`, `sync_push_outcome` | outcome: ok, failed; failure_kind, status, duration_ms |
| Reliability | `api_request_failed`, `client_error` | operation, method, route, status, failure_kind, duration_ms; optional coarse scope_kind |

Echoes reads and feedback stay REST and report failures under the static operation `journal_echoes`
and coarse route `/v1/journal`. Expected HTTP refusals and offline/DNS/connect failures emit only
`api_request_failed`; cancellation is quiet. Timeouts, TLS, unexpected HTTP responses and decoding
failures also reach Sentry. Offline, Echoes adds no cached echo, placeholder, spinner or error to the
journal and never blocks writing. Product events contain no journal text, excerpts, connection
reasons, dates, similarity scores, echo/page identifiers or counts. Echoes REST bodies and dynamic
routes never enter telemetry. Echo events carry only common app metadata, and `journal_echo_ink` its action.

A day's count opens its ink with `journal_echo_ink` action `open`. The count again, a tap outside the ink or the
keyboard closes it with action `close`; the room's own closes (following a passage, Not useful, the trail, an offline
or failed read) record none. `journal_echo_shown` records each verified passage once per foreground session, when its
row is on screen in the ink or the reader; the count draws no passage and records nothing. *N more* records
`journal_echo_reader_opened`, and the first-echo card's *Got it* `journal_echo_intro_dismissed`.
`journal_echo_opened` records following a passage to its source in the canvas, from the ink or the reader; the REST
opened signal is best effort. *Useful* records one `journal_echo_useful` per tap and marks every passage the ink shows,
one REST signal each; *Not useful* records one `journal_echo_dismissed` and retires the page's echo. Both are optimistic
and roll back if a request fails. Closing the reader dismisses no echo and records nothing.

Coach archive migration and read failures report under `gym_read`; save, selection and removal
failures use `gym_action`. History merges server rows only for the active owner, and late reads retain
their captured owner. A cached conversation refresh never dispatches an ask. Conversation content,
draft text, photo data, archive paths and owner/thread/request identifiers stay out of these reports.

The finished-workout receipt’s Done emits `first_run_choice` with screen `workout` and action `close`.
Its Share tap and destructive confirmation steps emit bounded `gym_action` labels. Confirmed Discard
emits the existing write outcome. Share with Coach retains its intent through sign-in and enters the
existing Coach flow; events contain no workout names, set values or Coach question.

Every door to Share this workout opens one sheet, which records `gym_screen_viewed` with screen `session_share` each
time it is presented. Signed out or paused, its *Sign in to share* opens You (`first_run_screen_viewed` with screen
`you`); when You closes signed in, the sheet is presented again and records its view again, and a sign-in left
unfinished shares nothing and records nothing more.

Gym boundary operation labels are `gym_read`, `gym_action`, `gym_flush`, `gym_rest`,
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
Gym REST uses `GET` for reads, `POST` for Ask, Stop, explicit routine confirmation and share creation, `PUT` for Coach attachments
and `DELETE` for share revocation and Coach conversations; gym records are written only through the
engine. Anonymous Coach setup uses POST to issue an installation credential and create an immutable
onboarding request, GET to read the server allowance and poll the same request, and POST to bind its
cost after verified sign-in. Installation calls use `ai_installation` and the `/v1/ai` route family; onboarding uses `gym_rest` and `/v1/gym`. The separate
installation Keychain service reports read/write failures with `keychain_read`/`keychain_save` and never
replaces an unreadable or rejected credential. Expected installation, rate and allowance refusals are
metrics; accounting and unexpected transport/decoding failures report to Sentry. Stop waiting records
`gym_ask_outcome:cancelled` for the phone wait, without claiming provider cancellation. Local import
failures use `gym_action`; no creation receipt appears until all routines and their replay marker commit.
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
with Apple capability. Both app entitlement files and `Tools/WorkoutActivity.entitlements` declare the App Group
`group.works.windmill.app`, registered in the developer portal and assigned to `works.windmill.app` and
`works.windmill.app.workout-activity`. `YES` selects the entitlement and UI only for a configured server/team.
Apple sign-in remains postponed pending developer-portal setup and a real-device check.
`CFBundleVersion` follows `CURRENT_PROJECT_VERSION`. The app's `PrivacyInfo.xcprivacy` declares
UserDefaults for local app state and monotonic time for elapsed durations, with no tracking. Its
collection declarations distinguish journal/auth synchronization from analytics; writing and scale
values have only the app-functionality purpose. Sentry and GRDB bundle their own manifests. The
manifest follows [Apple's required API reasons](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
and [data collection categories](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype).

`.github/workflows/ios-release.yml` runs only through `workflow_dispatch`, with Xcode 26.3. It uses
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
