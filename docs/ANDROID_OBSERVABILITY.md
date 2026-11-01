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
- **Event queue:** events wait in the app's private preferences (`works.windmill.telemetry`), on a
  shelf per account, at most 500. They leave in batches of 50 with the account's credential, or
  none when signed out, and retry every 30 s. An account that cannot return
  (`retireAccount`) sends the events it names, `account_delete`, without a credential and drops
  the rest.

## Failures

`telemetry.failure(operation, error, properties)` sends one `client_error` event and one Sentry
Issue, both under the static operation. It sends neither for an expected answer:

- a cancellation;
- lost network (`WindmillApiException.Offline`);
- an HTTP refusal with status 400, 401, 403, 404, 409, 410, 422, 426 or 429;
- on an AI door (`ai_installation`, `gym.coachOnboarding`), a 503 whose code
  `AiAvailability` declares: `anonymous_ai_unavailable` or an allowance code.

The gym and Coach stores also drop domain refusals (`TrainingRefused`, `TrainingUnanswered`,
`TrainingReadChanged`) and every `WindmillApiException`, which their HTTP door has already judged.
A failed HTTP request always sends `api_request_failed`; an unexpected one also reports under its
operation. Failures of the telemetry pipeline itself (`telemetry_*`) go to Sentry only.

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
| `auth_request` | platform | A session-minting auth request fails unexpectedly |
| `auth_restore` | platform | Verifying the saved session fails unexpectedly |
| `auth_sign_in` | platform, app | Completing a sign-in by code or link fails unexpectedly |
| `auth_sign_out` | platform | Ending the account on the phone fails |
| `gym.acceptSet` | gym | Logging a set fails |
| `gym.adoptCoachDraft` | gym | Moving the signed-out Coach draft into the account fails |
| `gym.applyProposal` | gym | Applying a Coach routine proposal fails |
| `gym.ask` | gym | Stopping or settling a Coach question fails |
| `gym.choose` | gym | Reading the last time or the current workout choice fails |
| `gym.coachOnboarding` | gym, app | Signed-out Coach transport, request storage, recovery, photo preparation or routine import fails |
| `gym.coachRoutineConfirm` | gym | Confirming a Coach routine fails |
| `gym.connect` | gym | Connecting the training store to the account fails |
| `gym.copyMessage` | gym | Copying a Coach message to the clipboard fails |
| `gym.create` | gym | Creating a movement fails |
| `gym.deleteNote` | gym | Deleting a note fails |
| `gym.deleteSet` | gym | Deleting a set fails |
| `gym.deleteThread` | gym | Deleting a Coach conversation fails |
| `gym.deleteWeighIn` | gym | Holding, keeping or settling a deleted weigh-in fails |
| `gym.discard` | gym | Discarding a workout fails |
| `gym.dismissProposal` | gym | Dismissing a Coach routine proposal fails |
| `gym.dropRoutine` | gym | Deleting a routine fails |
| `gym.editExercise` | gym | Editing a movement fails |
| `gym.editRack` | gym | Editing the rack's number fails |
| `gym.editWorkout` | gym | Editing the workout in flight fails |
| `gym.finish` | gym | Finishing a workout fails |
| `gym.finishReceipt` | gym | The first signed-out finish receipt's phone marker cannot be read or saved |
| `gym.fixSet` | gym | Correcting a set, or re-reading it after the correction, fails |
| `gym.import_reconcile` | gym | Reconciling signed-out imports fails |
| `gym.loadLastSets` | gym | Reading the last sets fails |
| `gym.loadLog` | gym | Reading the log, a workout detail, imports or recovery fails, or a frozen plan is unreadable |
| `gym.loadOlder` | gym | Reading an older page of the log fails |
| `gym.loadProgress` | gym | Reading progress fails |
| `gym.logger_visibility` | gym | Saving whether the logger is hidden fails |
| `gym.notification.capabilities` | gym | Reading the notification capabilities fails |
| `gym.notification.post` | gym | Posting the workout notification fails |
| `gym.notification.receive` | gym | Handling a notification action fails |
| `gym.openConnections` | gym | Opening the Connected log page fails |
| `gym.preparePhoto` | gym | Preparing a signed-in Coach photo fails |
| `gym.proposal_receipt_shown` | gym | Recording that a proposal receipt was shown fails |
| `gym.readNotes` | gym | Re-reading notes after an unconfirmed note deletion fails |
| `gym.readProgram` | gym | Re-reading the program after an unconfirmed routine deletion fails |
| `gym.readThreads` | gym | Reading Coach History fails |
| `gym.reconcileWorkoutTime` | gym | Closing a workout that ran past its automatic close fails |
| `gym.refreshConnectedLog` | gym | Refreshing the Connected log fails |
| `gym.refreshWorkout` | gym | Refreshing the program or the workout from the engine fails |
| `gym.reorderNotes` | gym | Reordering notes fails |
| `gym.rereadRow` | gym | Re-reading a workout row after a set deletion fails |
| `gym.restoreConversation` | gym | Restoring the Coach archive, chats or pending questions fails |
| `gym.restoreFinishedSession` | gym | Restoring the finish receipt after recreation fails |
| `gym.restoreNavigation` | gym | Restoring the navigation stack after recreation fails |
| `gym.restoreRoutineDraft` | gym | Restoring the routine editor's draft after recreation fails |
| `gym.restoreSessionDetail` | gym | Restoring a workout detail after recreation fails |
| `gym.restoreWorkout` | gym | Restoring the workout in flight fails |
| `gym.review` | gym | Reading a workout review fails |
| `gym.revokeShare` | gym | Revoking a workout share fails |
| `gym.revokeWorkoutAuthority` | gym | Revoking the workout's authority on the phone fails |
| `gym.routineHistory` | gym | Reading a routine's history fails |
| `gym.saveConversation` | gym | Saving a Coach conversation or request on the phone fails |
| `gym.saveDraft` | gym | Saving the Coach composer draft fails |
| `gym.saveNote` | gym | Saving a note fails |
| `gym.savePhoto` | gym | Saving a Coach photo fails |
| `gym.saveRoutine` | gym | Saving a routine fails |
| `gym.saveRoutineDraft` | gym | Saving the routine editor's draft for recreation fails |
| `gym.share` | gym | Sharing a workout fails |
| `gym.showWorkout` | gym | Showing the workout notification again fails |
| `gym.start` | gym | Starting a workout fails |
| `gym.storage.decode` | gym | A stored gym document or the workout controls cannot be decoded |
| `gym.storage.read` | gym | A stored gym document cannot be read |
| `gym.thread` | gym | Reading a Coach conversation fails |
| `gym.tile` | gym | The Quick Settings tile cannot listen, launch or open |
| `gym.weighIn` | gym | Saving a weigh-in fails |
| `gym.workoutClock` | gym | Reading the boot count for the workout clock fails |
| `gym.workout_controls` | gym | Reading the workout controls fails |
| `gym_ask` | gym | `POST /v1/gym/ask` fails unexpectedly |
| `gym_ask_stop` | gym | Stopping a Coach generation fails unexpectedly |
| `gym_coach_photo` | gym | Downloading a Coach photo fails unexpectedly |
| `gym_coach_photo_upload` | gym | Uploading a Coach photo fails unexpectedly |
| `gym_coach_routine_confirm` | gym | The Coach routine confirmation request fails unexpectedly |
| `gym_delete_thread` | gym | Deleting a Coach conversation on the server fails unexpectedly |
| `gym_grants` | gym | Reading the Connected log grants fails unexpectedly |
| `gym_import_<action>` | gym | Recovering a signed-out workout fails, by action: `keep`, `retry`, `fix` or `discard` |
| `gym_import_fix` | gym | Reading why a recovery fix was refused fails |
| `gym_mcp_keys` | gym | Reading the Connected log keys fails unexpectedly |
| `gym_revoke_share` | gym | Revoking a share on the server fails unexpectedly |
| `gym_share` | gym | Creating a share on the server fails unexpectedly |
| `gym_sign_in_decision` | gym | Answering the sign-in decision fails |
| `gym_thread` | gym | Reading a Coach conversation from the server fails unexpectedly |
| `gym_threads` | gym | Reading Coach History from the server fails unexpectedly |
| `http_request` | platform | A request that names no operation fails unexpectedly |
| `onboarding_motion_settings` | gym | Reading or watching the system animation setting fails |
| `onboarding_storage` | app | The onboarding flag cannot be read or saved |
| `session_decode` | platform | The saved session cannot be decoded |
| `session_key` | platform | The Keystore key for the session cannot be created or read |
| `session_migrate` | platform | Moving a session saved by an older build fails |
| `session_open` | platform | Opening a sealed secret fails |
| `session_seal` | platform | Sealing a secret fails |
| `session_sign_out_decode` | platform | The saved sign-out choice cannot be decoded |
| `session_user_decode` | platform | The saved user cannot be decoded |
| `sync_<operation>` | app | The sync engine files a fault, by engine operation: `commit`, `read`, `undo`, `release`, `dismiss`, `storage`, `writer`, `shutdown`, `sync`, `hello`, `push`, `pull`, `live`, `lifecycle` or `subscription`. A request's fault that repeats its operation's last files none until the operation is answered; lost network and the statuses the server answers on purpose (400, 401, 403, 404, 409, 410, 422, 426, 429, a push's 413, the server's own 503 `unavailable` in the sync envelope, and any 503 at the live upgrade, whose body is not read) file none; a bare or foreign 503 (an edge, a maintenance page) is a fault |
| `telemetry_credential` | platform | The credential for event delivery cannot be read |
| `telemetry_delivery` | platform | An event batch fails to reach the intake, other than by lost network; once until a batch lands |
| `telemetry_enqueue` | platform | An event cannot be queued |
| `telemetry_event_name` | platform | An event name is malformed or uses a reserved prefix without registration |
| `telemetry_identity` | platform | Switching or retiring the queue's account fails |
| `telemetry_overflow` | platform | The queue reaches 500 events; once until a batch lands |
| `telemetry_persist` | platform | The queue cannot be saved; once until it saves again |
| `telemetry_rejected` | platform | The intake accepts fewer events than were sent |
| `telemetry_restore` | platform | The saved queue cannot be read at start |
| `telemetry_storage` | platform | The queue's preferences cannot be opened |

## Events

Every event carries `platform`, `app_version`, `build`, `release` and `environment`. A name is
1–64 characters of `a-z`, `0-9` and `_`. Values are 1–80 characters of letters, digits and
`_ . : / -`, at most 900 bytes per event.

A module registers a schema for each event whose labels it bounds, through `:platform`'s
`EventSchema` (`EventSchemas`, `LabelSchema`); such an event keeps only the labels its schema
allows. `:platform` registers `account_delete` and `ai_installation_outcome`. `:gym` registers
the rest in `gym/telemetry/GymEvents.kt`, owns the `onboarding_` prefix, and the app hands
`GymEvents.schemas` to `AndroidTelemetry`. An unregistered event keeps only the keys `operation`,
`outcome`, `failure_kind`, `status`, `cap`, `action`, `method`, `route`, `state`, `duration_ms`,
`network_phase` and `screen`.

| Event | Module | Properties |
|---|---|---|
| `account_delete` | platform | `state`: `shown`; `action`: `confirm`, `check`, `cleanup`, `back`, `done`, `retry` (Try again on Not deleted), `date_time` (with `outcome`: `failed` when date settings cannot open); `outcome`: `started`, `cancelled`, `refused`, `clock_refused` (the phone's date and time are wrong), `not_deleted` (the close never reached Windmill in time), `failed`, `ok`, `cleanup_pending`, `pending_confirmation`. Refusals file no Issue. |
| `ai_installation_outcome` | platform | `action`: `bind`; `outcome`: `refused`, `failed` |
| `api_request_failed` | platform | `method`, `route` (first two path segments), `operation`, `failure_kind`, `status`, `duration_ms`, `network_phase` |
| `app_backgrounded` | app | none |
| `app_foregrounded` | app | none |
| `app_started` | app | none |
| `auth_code_requested` | platform | none |
| `auth_code_sent` | platform | none |
| `auth_restore` | platform | `outcome`: `verified`, `unverified`, `expired`, `signed_out`, `unresolved` |
| `auth_sign_in_started` | platform | `method`: `code`, `link` |
| `auth_signed_in` | platform | none |
| `auth_signed_out` | platform | none |
| `client_error` | platform | `operation`, `failure_kind` and the failure's allowed properties |
| `client_update_required` | app, platform | `state`: `shown` with `status`: `426`; or `action`: `dismiss`, `keep`, `update`, with `outcome`: `failed` when the update link cannot open |
| `gym_action` | gym | `screen`, `action` and `outcome` from the table below; an action that asks first sends `state`: `shown` without an outcome when its question opens |
| `gym_ask_outcome` | gym | Signed in: `outcome`: `answered`, `refused`, `capped`, `failed`, `fresh`, `absent`, `cancelled`; `duration_ms`; `cap`: `daily`, `ceiling`, `allowance`; `failure_kind`; `status`. Signed out: `state`: `anonymous`; `outcome`: `answered`, `refused`, `capped`, `failed`, `cancelled`; `duration_ms`; `cap`: `allowance` |
| `gym_ask_started` | gym | none signed in; `state`: `anonymous` signed out |
| `gym_bodyweight_saved` | gym | none |
| `gym_coach_import` | gym | `outcome`: `started`, `committed`, `replayed`, `refused`, `failed` |
| `gym_coach_routine_confirm` | gym | `outcome`: `started`, `saved`, `refused`, `failed` |
| `gym_import_recovery` | gym | `action`: `inspect`, `keep`, `retry`, `fix`, `discard`; `state`: `opened`, `started`, `shown`, `date_opened`, `time_opened`, `date_confirmed`, `time_confirmed`, `date_cancelled`, `time_cancelled`, `marked_finished`, `link_changed`, `set_opened`, `set_staged`, `set_removed`; `outcome`: `ok`, `completed`, `refused`, `failed`, `cancelled` |
| `gym_note_moved` | gym | none |
| `gym_proposal_missing` | gym | none. Counts only answers this visit of the Coach room waited for; a proposal deleted before the visit, as on a reopened thread, draws the line and sends nothing. A proposal named by such an answer has no row on the phone, live or dead, 10 s after its own first miss and once the phone, caught up at or after that miss, has read further into the account or a pull sent after the wait ended has landed caught up (the wait's end asks for one); once per proposal while the room stays composed |
| `gym_proposal_outcome` | gym | `action`: `apply`, `dismiss`; `outcome`: `decided`, `moved`, `gone`, `settled`, `failed` |
| `gym_proposal_receipt_shown` | gym | `outcome`: `applied` |
| `gym_routine_saved` | gym | `action`: `create`, `update` |
| `gym_screen_viewed` | gym | `screen`: `routines`, `log`, `coach`, `workout`, `workout_fix`, `proposal`, `finish`, `routine_editor`, `routine`, `session`, `movement`, `threads`, `thread`, `connections`, `notes`, `note_editor`, `bodyweight`, `on_this_phone`, `workout_inspect` |
| `gym_session_finished` | gym | none |
| `gym_session_started` | gym | none |
| `gym_set_logged` | gym | none |
| `gym_setup_step` | gym | `screen`: `coach`; `action`: `shown`, `screenshot`, `build_manually`, `photo_selected`, `photo_removed`, `sign_in` |
| `gym_sign_in_decision` | gym, app | `state`: `shown`, `discard_confirmation`; `action`: `add`, `discard`, `cancel`; `outcome`: `completed`, `cancelled`, `changed` or the engine's error code |
| `gym_sign_out` | gym | `state`: `shown`; `action`: `keep`, `discard`, `cancel`; `outcome`: `completed`, `failed` |
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
| `coach` | `choose` | `ok` | |
| `coach` | `continue_draft` | `ok` | |
| `coach` | `copy` | `ok`, `failed` | |
| `coach` | `draft_restored` | `ok` | |
| `coach` | `fresh_entry` | `ok` | |
| `coach` | `history_open` | `ok` | |
| `coach` | `jump_latest` | `ok` | |
| `coach` | `read_sources` | `ok` | |
| `coach` | `reply_open` | `ok` | |
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
| `session` | `share` | `ok`, `failed` | |
| `threads` | `delete` | `ok`, `refused`, `failed`, `cancelled` | yes |
| `tile` | `open` | `ok`, `failed` | |
| `tile` | `routines` | `ok`, `failed` | |
| `workout` | `fix` | `ok`, `refused`, `failed` | |
| `workout` | `hide` | `ok`, `refused` | |
| `workout` | `movement_switch` | `ok` | |
| `workout` | `open_workout` | `ok` | |
| `workout` | `picker_add` | `ok`, `refused` | |
| `workout` | `picker_cancel` | `ok` | |
| `workout` | `picker_open` | `ok` | |
| `workout` | `remove` | `ok`, `refused` | |
| `workout` | `reorder` | `ok` | |
| `workout` | `show_notification` | `ok`, `refused` | |
| `workout_bar` | `open` | `ok`, `refused` | |

## Adding a failure or an event

- **A failure operation:** add a row to the failures table.
- **An event:** add a row to the events table.
- **A bounded event:** register its schema in its module (`GymEvents.schemas` for gym), and list
  every allowed value in its row.
- **A gym_action label:** add it to `GymActions`, then add or extend its row in the gym_action
  table.

`ObservabilityDocTests` fails until the row exists.
