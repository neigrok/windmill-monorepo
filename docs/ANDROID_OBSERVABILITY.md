# Android observability

The Android app reports technical failures to Sentry through the Sentry Android SDK and sends
product events to the first-party `POST /v1/events` intake, which stores them and forwards them to
Amplitude. The APK contains no Amplitude key. Both carry labels only: no journal or note text,
workout, movement, routine or note names, loads, reps, Coach questions or answers, emails, tokens,
identifiers or raw exception messages.

`ObservabilityDocTests` (`apps/android/app/src/test`) holds this page to the code: every failure
operation and event the app names, and every registered event label, has a row here, and every row
names something the code still sends.

## How it is wired

- **Telemetry:** the `Telemetry` interface (`:platform`, `platform/telemetry/Telemetry.kt`) is
  injected through the application, account, HTTP transport, stores, the sync runtime,
  notifications and the Compose `LocalTelemetry`. Tests default to `Telemetry.None`.
- **When it runs:** release builds always; debug builds only with `WM_DEBUG_TELEMETRY`. The
  secret vault, session storage and account-deletion storage are built before `AndroidTelemetry`
  and report through `SentryErrors`: Issues only, with no `client_error` event.
- **Sentry:** the SDK starts with default PII off, no screenshots, view hierarchy, ANR thread dump,
  NDK, logs, traces or profiles, and every breadcrumb dropped. Before sending, an event loses its
  message, request, extras, user and exception values. Each Issue is tagged with its static
  `operation`, `failure_kind`, the allowed properties and the build metadata, and is fingerprinted
  by its operation.
- **Release symbols:** release APKs are R8-minified; throwable names are kept so `failure_kind`
  stays unchanged. Each APK carries a ProGuard UUID whose retained mapping is uploaded to Sentry
  at release by the release agent, with its digest checked against finalized provenance. If no
  local token is available, the upload is recorded as pending in the release notes.
- **Event queue:** one background worker owns restoration, ordered queue changes and saves to the
  app's private preferences (`works.windmill.telemetry`), once after each burst of changes. Events
  become durable after the worker saves them. Shelves hold at most 500 events in total; dormant
  accounts' events give way, oldest first, to the current account and signed-out shelves. Otherwise
  a dormant shelf waits for its account to sign in again. Events leave in batches of 50 with the
  account's credential, or none when signed out, and retry every 30 s. Acknowledgements remove
  exactly the sent event ids, including events moved by retirement. An event that tells of the
  account ending (`signedOutEvent`) waits on the
  signed-out shelf instead, so the ending cannot strand it. An account that cannot return
  (`retireAccount`) sends the events it names, `account_delete`, without a credential and drops
  the rest.

## Failures

`telemetry.failure(operation, error, properties)` sends one `client_error` event and one Sentry
Issue, both under the static operation. It sends neither for an expected answer:

- a cancellation;
- lost network (`WindmillApiException.Offline`), or a `Transport` failure that
  `TelemetryPolicy.networkLoss` reads as lost network;
- an HTTP refusal with status 400, 401, 403, 404, 409, 410, 422, 426 or 429;
- on an AI door (`ai_installation`), a 503 whose code
  `AiAvailability` declares: `anonymous_ai_unavailable` or an allowance code.

The gym and Coach stores also drop domain refusals (`TrainingRefused`, `TrainingUnanswered`,
`TrainingReadChanged`) and every `WindmillApiException`, which their HTTP door has already judged.
A failed HTTP request always sends `api_request_failed`; an unexpected one also reports under its
operation. A `Timeout` still reports. Raw storage exceptions remain reportable even when their
type also occurs during network loss. Failures of the telemetry pipeline itself (`telemetry_*`) go to Sentry only.

| Operation | Module | Reported when |
|---|---|---|
| `account_delete_cleanup` | platform | Local cleanup after a confirmed account deletion fails |
| `account_delete_prepare` | platform | Preparing the deletion request fails before it is sent |
| `account_delete_recovery` | platform | Recovering a deletion whose answer was lost fails |
| `account_delete_request` | platform | `DELETE /v1/me` fails unexpectedly |
| `account_delete_result` | platform | `POST /v1/account-deletion/result` fails unexpectedly |
| `account_delete_storage` | platform | The pending deletion cannot be read or saved on the phone |
| `ai_installation` | platform | The signed-out Coach installation cannot be issued, read or bound, or its sealed state cannot be read, saved or retained |
| `application_coroutine` | app | A coroutine in the application scope throws |
| `auth_local_identity` | platform | The saved account cannot be resolved at restore |
| `auth_logout` | platform | The server sign-out call fails other than with an HTTP answer |
| `auth_request` | platform | A session-minting auth request fails unexpectedly, including a 2xx response without a nonempty session cookie (`malformed`, phase `decode`) |
| `auth_restore` | platform | Verifying the saved session fails unexpectedly |
| `auth_sign_in` | platform, app | Completing a sign-in by code or link fails unexpectedly |
| `auth_sign_out` | platform | Ending the account on the phone fails |
| `gym.acceptSet` | gym | Logging a set fails |
| `gym.adoptCoachDraft` | gym | Moving the signed-out Coach draft into the account fails |
| `gym.applyProposal` | gym | Applying a Coach routine proposal fails |
| `gym.applyWorkoutProposal` | gym | Applying a Coach change to the open workout fails on this phone |
| `gym.choose` | gym | Reading the last time or saving the movement choice fails |
| `gym.coachAccess` | gym | Reading this phone's installation for the signed-out Coach fails on this phone's own storage |
| `gym.coachOnboarding` | gym | Saving the routines a retained onboarding answer drafted fails |
| `gym.coachTurn` | gym | A phone Coach turn fails: by `failure_kind`, `transport` (a stream or a post that failed other than by lost network), `decode` (a frame or answer that cannot be read), `storage` (the replica or a picture file threw), `refusal` (the replica refused the turn's own record), `http` with `status` (a 5xx the server did not mean), and `lease` (its job could not be enqueued). Lost network, a cancellation, a seat change, an account in transition, a record removed elsewhere and a refusal the server answered on purpose, `coach-busy` and a cap at any status among them, file nothing; they end the turn with their code on `coach_turn`, or withdraw it when no frame had arrived. An answer that cannot be read before any frame reports `decode` once and withdraws the turn |
| `gym.connect` | gym | Connecting the training store to the account fails |
| `gym.copyMessage` | gym | Copying a Coach message or its link to the clipboard fails |
| `gym.create` | gym | Creating a movement fails |
| `gym.deleteNote` | gym | Deleting a note fails |
| `gym.deleteSet` | gym | Deleting a set fails |
| `gym.deleteThread` | gym | Clearing what this phone keeps beside a deleted Coach conversation fails; the conversation's own records fail under `gym.coachTurn` |
| `gym.deleteWeighIn` | gym | Holding or undoing a deleted weigh-in fails; the engine releases it |
| `gym.discard` | gym | Discarding a workout fails |
| `gym.dismissProposal` | gym | Dismissing a Coach routine proposal fails |
| `gym.dismissWorkoutProposal` | gym | Turning down a Coach change to the open workout fails on this phone |
| `gym.dropMovement` | gym | Removing a movement from the live workout fails |
| `gym.dropRoutine` | gym | Deleting a routine fails |
| `gym.editExercise` | gym | Editing a movement fails |
| `gym.editRack` | gym | Editing the rack's number fails |
| `gym.editWorkout` | gym | Editing the workout in flight fails |
| `gym.finish` | gym | Finishing a workout fails |
| `gym.finishReceipt` | gym | The first signed-out finish receipt's phone marker cannot be read or saved |
| `gym.fixSet` | gym | Correcting a set, or re-reading it after the correction, fails |
| `gym.import_reconcile` | gym | Reconciling signed-out imports fails |
| `gym.loadLastSets` | gym | Reading the last sets fails |
| `gym.loadLog` | gym | Reading the log, a workout detail, imports or recovery fails, a frozen plan is unreadable, or saving this phone's workout copy after a log read fails |
| `gym.loadOlder` | gym | Reading an older page of the log fails |
| `gym.loadProgress` | gym | Reading progress fails |
| `gym.logger_visibility` | gym | Saving whether the logger is hidden fails |
| `gym.notification.capabilities` | gym | Reading the notification capabilities fails |
| `gym.notification.post` | gym | Posting the workout notification fails |
| `gym.notification.receive` | gym | Handling a notification action fails |
| `gym.openConnections` | gym | Opening the Connected log page fails |
| `gym.openLink` | gym | Opening a Coach answer's link fails unexpectedly; a missing browser sends only `open_link` / `unavailable`, never an Issue |
| `gym.prepareAdoption` | gym | Preparing an anonymous workout fails and retains that item locally for retry; an outer preparation failure retains the anonymous replica without blocking sign-in |
| `gym.preparePhoto` | gym | Preparing a Coach photo fails |
| `gym.readConversation` | gym | Reading a Coach conversation, History, or how far the phone has read for an answer's unread proposal off the replica fails; What Coach read's details fail to read, once per opening of the sheet, whose rows keep their titles; or a `thread` or `message` record cannot be read: once per process, the record costs itself and never its conversation |
| `gym.proposal_receipt_shown` | gym | Recording that a proposal receipt was shown fails |
| `gym.readNotes` | gym | Reading the notes list, or re-reading it after an unconfirmed note deletion, fails |
| `gym.readProgram` | gym | Re-reading the program after an unconfirmed routine deletion fails |
| `gym.reconcileWorkoutTime` | gym | Closing a workout that ran past its automatic close fails |
| `gym.record` | gym | Reading a movement's record fails |
| `gym.refreshConnectedLog` | gym | Refreshing the Connected log fails |
| `gym.refreshWorkout` | gym | Refreshing the program or the workout from the engine fails, or a `proposal` or `workoutProposal` record cannot be decoded: once per kind per process, naming the kind alone, and that record costs itself and never the workout or the program |
| `gym.reorderMovements` | gym | Reordering the live workout's movements fails |
| `gym.reorderNotes` | gym | Reordering notes fails |
| `gym.rereadRow` | gym | Re-reading a workout row after a set deletion fails |
| `gym.restoreConversation` | gym, app | The Coach archive cannot be read, once per process when Coach first reads it: the engine's conversations stand and the file is left as it is; a retained answer's body cannot be read, once per process under a static failure, and that answer alone is lost to the room; or rewriting an earlier version's archive at launch fails |
| `gym.restoreFinishedSession` | gym | Restoring the finish receipt after recreation fails |
| `gym.restoreNavigation` | gym | Restoring the navigation stack after recreation fails |
| `gym.restoreRoutineDraft` | gym | Restoring the routine editor's draft after recreation fails |
| `gym.restoreSessionDetail` | gym | Restoring a workout detail after recreation fails |
| `gym.restoreWorkout` | gym | Restoring the workout in flight fails |
| `gym.review` | gym | Reading a workout review fails |
| `gym.revokeShare` | gym | Revoking a workout share fails |
| `gym.revokeWorkoutAuthority` | gym | Revoking the workout's authority on the phone fails |
| `gym.routineHistory` | gym | Reading a routine's history fails |
| `gym.saveConversation` | gym | Saving a Coach chat on the phone fails: its selection, its place, or the thread its turn opened |
| `gym.saveDraft` | gym | Saving the Coach composer draft fails |
| `gym.saveNote` | gym | Saving a note fails |
| `gym.savePhoto` | gym | Saving a Coach photo fails |
| `gym.saveRoutine` | gym | Saving a routine fails |
| `gym.saveRoutineDraft` | gym | Saving the routine editor's draft for recreation fails |
| `gym.share` | gym | Creating or copying a workout link fails |
| `gym.shareLink` | gym | Opening the share sheet fails unexpectedly |
| `gym.showWorkout` | gym | Showing the workout notification again fails |
| `gym.start` | gym | Starting a workout fails |
| `gym.storage.decode` | gym | A stored gym document or the workout controls cannot be decoded |
| `gym.storage.read` | gym | A stored gym document cannot be read |
| `gym.tile` | gym | The Quick Settings tile cannot listen, launch or open |
| `gym.weighIn` | gym | Saving a weigh-in fails |
| `gym.workoutClock` | gym | Reading the boot count for the workout clock fails |
| `gym.workout_controls` | gym | Reading the workout controls fails |
| `gym_grants` | gym | Reading the Connected log grants fails unexpectedly |
| `gym_import_<action>` | gym | Recovering a signed-out workout fails, by action: `keep`, `retry`, `fix` or `discard` |
| `gym_import_fix` | gym | Reading why a recovery fix was refused fails |
| `gym_mcp_keys` | gym | Reading the Connected log keys fails unexpectedly |
| `gym_revoke_share` | gym | Revoking a share on the server fails unexpectedly |
| `gym_share` | gym | Creating a share on the server fails unexpectedly |
| `gym_sign_in_decision` | gym | Answering the sign-in decision fails |
| `http_request` | platform | A request that names no operation fails unexpectedly |
| `onboarding_motion_settings` | gym | Reading or watching the system animation setting fails |
| `onboarding_storage` | app | The onboarding flag cannot be read or saved |
| `session_decode` | platform | The saved session cannot be decoded |
| `session_key` | platform | The Keystore key for the session cannot be created or read |
| `session_migrate` | platform | Sealing or persisting a session saved by an older build fails; reported once per process, with the plaintext retained but unused |
| `session_open` | platform | Opening a sealed secret fails |
| `session_seal` | platform | Sealing a secret fails |
| `session_sign_out_decode` | platform | The saved sign-out choice cannot be decoded |
| `session_user_decode` | platform | The saved user cannot be decoded |
| `sync_<operation>` | app | The sync engine files a fault, by engine operation: `commit`, `read`, `undo`, `release`, `dismiss`, `storage`, `writer`, `shutdown`, `sync`, `hello`, `push`, `pull`, `live`, `lifecycle` or `subscription`. A request's fault that repeats its operation's last files none until the operation is answered; lost network and the statuses the server answers on purpose (400, 401, 403, 404, 409, 410, 422, 426, 429, a push's 413, the server's own 503 `unavailable` in the sync envelope, and any 503 at the live upgrade, whose body is not read) file none, and so does the server's 1008 close of a live socket whose session ended, a refusal; a bare or foreign 503 (an edge, a maintenance page) is a fault |
| `telemetry_credential` | platform | The credential for event delivery cannot be read |
| `telemetry_delivery` | platform | An event batch fails to reach the intake, other than by lost network; once until a batch lands |
| `telemetry_enqueue` | platform | An event cannot be queued |
| `telemetry_event_name` | platform | An event name is malformed or uses a reserved prefix without registration |
| `telemetry_identity` | platform | Switching or retiring the queue's account fails |
| `telemetry_overflow` | platform | An event is refused because the current account and signed-out shelves alone hold 500 events; once until a batch lands |
| `telemetry_persist` | platform | The queue cannot be saved; once until it saves again |
| `telemetry_rejected` | platform | The intake accepts fewer events than were sent |
| `telemetry_restore` | platform | The saved queue cannot be read at start |
| `telemetry_storage` | platform | The queue's preferences cannot be opened |

## Events

Every event carries `platform`, `app_version`, `build`, `release` and `environment`. A name is
1–64 characters of `a-z`, `0-9` and `_`. Values are 1–80 characters of letters, digits and
`_ . : / -`, at most 900 bytes per event.

A module registers a schema for each event whose labels it bounds, through `:platform`'s
`EventSchema` (`EventSchemas`, `LabelSchema`, which also takes counts: digits alone); such an event keeps
only the labels its schema allows, under any key the schema names. `:platform` registers `account_delete` and `ai_installation_outcome`. `:gym` registers
the rest in `gym/telemetry/GymEvents.kt`, owns the `onboarding_` prefix, and the app hands
`GymEvents.schemas` to `AndroidTelemetry`. An unregistered event keeps only the keys `operation`,
`outcome`, `failure_kind`, `status`, `cap`, `action`, `method`, `route`, `state`, `duration_ms`,
`network_phase` and `screen`.

| Event | Module | Properties |
|---|---|---|
| `account_delete` | platform | `state`: `shown`; `action`: `confirm`, `check`, `cleanup`, `back`, `done`, `retry` (Try again on Not deleted), `date_time` (with `outcome`: `failed` when date settings cannot open); `outcome`: `started`, `cancelled`, `refused`, `clock_refused` (the phone's date and time are wrong), `not_deleted` (the close never reached Windmill in time), `failed`, `ok`, `cleanup_pending`, `pending_confirmation`. Refusals file no Issue. |
| `ai_installation_outcome` | platform | `action`: `bind`; `outcome`: `refused`, `failed` |
| `api_request_failed` | platform, gym | `method`, `route` (first two path segments), `operation`, `failure_kind`, `status`, `duration_ms`, `network_phase`. A Coach turn the server refused before its stream sends `operation`: `gym_coach_turn`, `route`: `/v1/gym`, `method`: `POST`, `failure_kind`: `http`, `status`; one withdrawn with no answer from the server, every attempt lost or the answer unreadable, or a Stop before any frame that went unheard, sends the same with `failure_kind`: `offline` and no `status` |
| `app_backgrounded` | app | none |
| `app_foregrounded` | app | none |
| `app_started` | app | none |
| `auth_code_requested` | platform | none |
| `auth_code_sent` | platform | none |
| `auth_restore` | platform | `outcome`: `verified`, `unverified`, `expired`, `signed_out`, `unresolved` |
| `auth_sign_in_started` | platform | `method`: `code`, `link`; code submissions include malformed entries refused locally, which send no `api_request_failed` or failure report |
| `auth_signed_in` | platform | none |
| `auth_signed_out` | platform | none |
| `client_error` | platform | `operation`, `failure_kind` and the failure's allowed properties |
| `coach_ability` | gym | One per ability call a turn ran, the context reads included: `name` (the catalog name, or `other`); `outcome`: `ok`, `not-offered`, `seat-required`, `invalid-input`, `invalid-arguments`, `refused`, `result-too-large`, `coach-turn-volume`, `other` |
| `coach_turn` | gym | One per turn that opened, none for a turn withdrawn before any frame: `state`: `interrupted`, `completed`, `declined`, `failed`, `stopped`; `seat`: `anon`, `bound`; `code`: the §6.5 code a failed turn ended on, or an interrupted one's cause: `subject_exhausted`, `free_month_exhausted`, `free_day_exhausted`, `concurrency_exhausted`, `funding_required`, `debt_outstanding`, `device_bound`, `invalid_installation`, `coach-bad-request`, `coach-update-required`, `coach-turn-conflict`, `coach-turn-unknown`, `coach-turn-order`, `coach-turn-volume`, `coach-rate-limited`, `coach-replica-syncing`, `coach-busy`, `coach-vendor-error`, `coach-stream-replaced`, or this phone's own `transport`, `decode`, `storage`, `refusal`, `http`, `gone` (its record was removed under it, as a conversation deleted on another phone), `seat_changed` (the active replica changed or a sign-in rebound it; its counts are absent when the record left with that replica), `process_ended` (a sweep found it running with nothing to run it, told once by the sweep that ends it, with no duration), `other`; `ability_calls`, `refusals`, `answer_bytes` and `duration_ms` as counts |
| `client_update_required` | app, platform | `state`: `shown` with `status`: `426`; or `action`: `dismiss`, `keep`, `update`, with `outcome`: `failed` when the update link cannot open |
| `gym_action` | gym | `screen`, `action` and `outcome` from the table below; an action that asks first sends `state`: `shown` without an outcome when its question opens |
| `gym_ask_outcome` | gym | One per send the room takes up, either seat; a send it turns away at once, as a second tap or a question past its bound, returns false and tells nothing, and a finish share asked again is the same send: `screen`: `coach`; `outcome`: `answered` (completed), `cancelled` (stopped), `refused` (declined, a refusal before the stream, the local admission of a log still arriving, or a send held back while Coach answers another message, the account is changing or the seat could not be taken), `failed` (failed, interrupted, a 5xx before the stream, or a send held back because this phone could not record it or read its picture), `capped` with `cap`: `allowance` or `daily`, `absent` (a deployment without the turn route), `offline` (a send held back with no network, or withdrawn with no answer from the server: every attempt lost, an answer it could not read, or a Stop before any frame that went unheard); `duration_ms` |
| `gym_ask_started` | gym | A Coach turn, once recorded on the replica, either seat: `screen`: `coach` |
| `gym_bodyweight_saved` | gym | none |
| `gym_coach_import` | gym | `outcome`: `started`, `committed`, `replayed`, `refused`, `failed` |
| `gym_import_recovery` | gym | `action`: `inspect`, `keep`, `retry`, `fix`, `discard`; `state`: `opened`, `started`, `shown`, `date_opened`, `time_opened`, `date_confirmed`, `time_confirmed`, `date_cancelled`, `time_cancelled`, `marked_finished`, `link_changed`, `set_opened`, `set_staged`, `set_removed`; `outcome`: `ok`, `completed`, `refused`, `failed`, `cancelled` |
| `gym_note_moved` | gym | none |
| `gym_proposal_missing` | gym | none. Counts only answers this visit of the Coach room waited for; a proposal deleted before the visit, as on a reopened thread, draws the line and sends nothing. A proposal named by such an answer has no row on the phone, live or dead, 10 s after its own first miss and once the phone, caught up at or after that miss, has read further into the account or a pull sent after the wait ended has landed caught up (the wait's end asks for one); once per proposal while the room stays composed |
| `gym_proposal_outcome` | gym | `target`: `workout` on a change to the open workout, absent on a routine's; `action`: `apply`, `dismiss`; `outcome`: `decided`, `moved` (the routine or workout changed under the proposal), `gone`, `settled` (the other decision was taken first), `refused` (the rules refuse the decision, as a target under its movement's load floor), `failed`. A workout's decision the phone queued is told when the log's answer reaches it: `decided` if it took, `failed` if not. That wait lives in the running process: a death before the answer tells nothing, though the decision stands |
| `gym_proposal_receipt_shown` | gym | `outcome`: `applied` |
| `gym_routine_saved` | gym | `action`: `create`, `update` |
| `gym_screen_viewed` | gym | `screen`: `routines`, `log`, `coach`, `workout`, `workout_fix`, `proposal`, `finish`, `routine_editor`, `routine`, `session`, `movement`, `threads`, `thread`, `connections`, `notes`, `note_editor`, `bodyweight`, `on_this_phone`, `workout_inspect` |
| `gym_session_finished` | gym | none |
| `gym_session_started` | gym | none |
| `gym_set_logged` | gym | none |
| `gym_setup_step` | gym | `screen`: `coach`; `action`: `shown`, `screenshot`, `build_manually`, `photo_selected`, `photo_removed`, `sign_in`, `open_routine`, `keep_routines`, `connect` (a refusal's Use your own AI agent door) |
| `gym_sign_in_decision` | gym, app | `state`: `shown`, `discard_confirmation`; `action`: `add`, `discard`, `cancel`; `outcome`: `completed`, `cancelled`, `changed` or the engine's error code |
| `gym_sign_out` | gym | `state`: `shown`; `action`: `keep`, `discard`, `cancel`; `outcome`: `completed`, `failed`. Keep and Discard send their outcome signed out, under the phone's device id, so it cannot be joined to `shown` per user. A sign-out nobody was asked about (an expired session, account deletion) sends none |
| `onboarding_action` | gym | `state`: `first_launch`, `replay`; `screen`: `windmill`, `roadmap`, `journal`, `gym`; `action`: `next`, `back`, `swipe`, `adjust` |
| `onboarding_exited` | gym, app | `state`: `first_launch`, `replay`; `screen`: `windmill`, `roadmap`, `journal`, `gym`; `outcome`: `skipped`, `completed`, `back`, `closed` |
| `onboarding_opened` | gym | `state`: `first_launch`, `replay` |
| `onboarding_page_viewed` | gym | `state`: `first_launch`, `replay`; `screen`: `windmill`, `roadmap`, `journal`, `gym` |
| `sync_connectivity` | app | `state`: `online`, `offline`, as the default network's own callback reports it: offline once that network is lost |
| `sync_engine` | app | A sync engine result other than success: `operation` (the engine operation), `outcome`: `refused`, `failure`, `timeout`; `failure_kind` (the engine's code); `status` |

### gym_action labels

`GymActions` in `gym/telemetry/GymEvents.kt` is the allowlist. A row marked *asks first* also
sends `state`: `shown` when its question opens. The log's `first_pull` sends `state`: `shown` when the
reading bar shows before the first pull, then once `read` when the pull lands or `failed` when the
foot turns to Retry.

| Screen | Action | Outcomes | Asks first |
|---|---|---|---|
| `bodyweight` | `calendar_cancel` | `ok` | |
| `bodyweight` | `calendar_confirm` | `ok` | |
| `bodyweight` | `calendar_open` | `ok` | |
| `bodyweight` | `cancel` | `rewritten` | |
| `bodyweight` | `delete` | `held`, `closed`, `refused`, `failed` | |
| `bodyweight` | `undo` | `ok`, `closed`, `failed` | |
| `coach` | `access` | `available`, `bound`, `unavailable` | |
| `coach` | `answering_elsewhere` | `ok` | |
| `coach` | `account_changing` | `shown` | |
| `coach` | `answer_in_progress` | `shown` | |
| `coach` | `continue_draft` | `ok` | |
| `coach` | `copy` | `ok`, `failed` | |
| `coach` | `copy_link` | `ok`, `failed` | |
| `coach` | `draft_restored` | `ok` | |
| `coach` | `fresh_entry` | `ok` | |
| `coach` | `history_open` | `ok` | |
| `coach` | `jump_latest` | `ok` | |
| `coach` | `open_link` | `ok`, `unavailable`, `failed` | |
| `coach` | `read_sources` | `ok` | |
| `coach` | `reconnecting` | `ok` | |
| `coach` | `reply_open` | `ok` | |
| `coach` | `stop_notice` | `ok` | |
| `coach` | `stop_notice_closed` | `ok` | |
| `coach` | `too_long` | `shown` | |
| `finish` | `discard` | `ok`, `cancelled`, `refused`, `failed` | yes |
| `finish` | `done` | `ok` | |
| `finish` | `keep` | `ok` | |
| `log` | `discard` | `ok`, `cancelled`, `refused`, `failed` | yes |
| `log` | `first_pull` | `read`, `failed` | yes |
| `log` | `open_bodyweight` | `ok` | |
| `log` | `open_record` | `ok` | |
| `log` | `open_workout` | `ok` | |
| `log` | `retry` | `requested`, `refused`, `ok`, `failed` | |
| `log` | `share` | `ok`, `refused`, `failed` | |
| `movement_form` | `add` | `ok`, `refused`, `failed` | |
| `movement_form` | `cancel` | `ok` | |
| `movement_form` | `create` | `ok`, `refused`, `failed` | |
| `movement_form` | `discard` | `ok`, `cancelled` | yes |
| `movement_form` | `open` | `ok` | |
| `movement_form` | `stage` | `ok`, `refused` | |
| `note_editor` | `delete` | `ok`, `refused`, `failed` | |
| `note_editor` | `save` | `ok`, `refused`, `failed` | |
| `notes` | `delete` | `ok`, `refused`, `failed` | |
| `notification` | `log_set` | `ok`, `refused` | |
| `notification` | `open` | `ok`, `refused` | |
| `record` | `edit` | `ok`, `refused`, `failed` | |
| `routine_editor` | `discard` | `ok`, `cancelled` | yes |
| `routine_editor` | `save` | `ok`, `refused`, `failed` | |
| `routines` | `delete` | `ok`, `refused`, `failed` | |
| `session` | `delete` | `ok`, `refused`, `failed` | |
| `session` | `discard` | `ok`, `cancelled`, `refused`, `failed` | yes |
| `session` | `fix` | `ok`, `refused`, `failed` | |
| `session` | `copy_link` | `ok`, `failed` | |
| `session` | `share_link` | `ok`, `unavailable`, `failed` | |
| `threads` | `delete` | `ok`, `refused`, `failed`, `cancelled` | yes |
| `threads` | `empty` | `shown` | |
| `tile` | `open` | `ok`, `failed` | |
| `tile` | `routines` | `ok`, `failed` | |
| `workout` | `fix` | `ok`, `refused`, `failed` | |
| `workout` | `hide` | `ok`, `refused` | |
| `workout` | `movement_switch` | `ok` | |
| `workout` | `open_coach` | `ok` | |
| `workout` | `open_workout` | `ok` | |
| `workout` | `picker_add` | `ok`, `refused` | |
| `workout` | `picker_cancel` | `ok` | |
| `workout` | `picker_open` | `ok` | |
| `workout` | `remove` | `ok`, `refused`, `failed` | |
| `workout` | `reorder` | `ok`, `failed` | |
| `workout` | `show_notification` | `ok`, `refused` | |
| `workout_bar` | `open` | `ok`, `refused` | |

For `session/share_link`, `ok` means the system chooser opened; it does not report a selected app or delivery. `unavailable` means no activity handles the chooser and produces no Sentry Issue. Unexpected launch errors report `gym.shareLink` and `failed`. Properties contain only the screen, action and outcome labels.

## Adding a failure or an event

- **A failure operation:** add a row to the failures table.
- **An event:** add a row to the events table.
- **A bounded event:** register its schema in its module (`GymEvents.schemas` for gym), and list
  every allowed value in its row.
- **A gym_action label:** add it to `GymActions`, then add or extend its row in the gym_action
  table.

`ObservabilityDocTests` fails until the row exists.
