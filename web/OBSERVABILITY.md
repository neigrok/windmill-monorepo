# Web sync observability

The browser engine injects telemetry through `syncTelemetry`. Its defaults send events through
`src/telemetry/beacon.js` and technical failures through `src/telemetry/sentry.js`. A telemetry failure
cannot stop synchronization. The beacon adapter encodes the spec's hyphenated event labels with
underscores because `/v1/events` accepts snake_case names. Each engine instance permits at most 30 reports per rolling minute;
injected limits are capped at 100. No raw exception, stack, body, field value, ID, scope reference,
account, email or token is forwarded.

Gym load validation accepts finite normalized values without a fixed kg cap; explicit zero remains
distinct from an absent target. An unrepresentable derived metric is unavailable data, rendered in
existing unavailable slots, and creates no technical failure or event. Existing set, target, fix and
import actions retain their bounded outcome events and storage/transport failure reporters. Fresh
sender hellos use the existing sync diagnostics. Loads, numeric buffers, metric values and raw
refusal text never enter telemetry properties.

| Events | Meaning |
|---|---|
| `sync-start`, `sync-commit`, `sync-release`, `sync-undo` | Local engine and gesture steps |
| `sync-signin`, `sync-signout`, `sync-auth-paused` | Lineage decisions and authentication transitions |
| `sync-upgrade`, `sync-persist`, `sync-leader` | Upgrade stop, persistence request result and lock ownership |
| `sync-refused`, `sync-push-malformed` | Terminal refusals and malformed push responses |
| `sync-writer` | Transaction enqueue-to-durability latency and initial queue/read latency |
| `sync-digest-mismatch` | Confirmed scope digest disagreed with the server |

Properties are restricted to `scopeKind` (`product`, `tree`, `overlay`, `device`), a nonnegative safe
integer `seq`, `durationMs` and `queueMs` (capped at 60,000), and `outcome` (`ok`, `denied`, `unavailable`, `pending`, `paused`, `failed`, `acquired`,
`released`). Failures use only the static operations `storage`, `transport`, `live`, `leadership`,
`observer` and `auth`. Storage denial is explicit; no volatile fallback replaces durable work. A write
the device's store cannot commit reports `storage` once and reaches its caller as a `CommitError` of
kind `store`; an error a caller's read-and-commit function throws passes through unreported.

The shell reports cookie cleanup, session transition and auth-hint storage failures under static
`auth` operations. Opening and warming the offline shell reports `offline-shell` to Sentry.
The update-required reload emits `sync_upgrade` with `pending`, `ok` or `failed`; a failed
shell update reports the static `offline-shell-update` operation. A persisted page restore
reports storage failures and keeps its local records available for a retry.
Add/Discard and sign-out emit `sync_signin`/`sync_signout` with `outcome: pending`; the engine reports
completed transitions. Revoking this session uses the sign-out question before clearing its cookie.
Account closure persists its account and current session before the server request and discards local
account data after it succeeds. The request names the confirmed account; `account-mismatch` retains
its local data and reports the auth-session failure. A failed local discard reports the same failure; reload and
retry reconcile that session before recovering the discard. A new session keeps its cookie, including
one that reopens the same account. Closure refuses an unavailable session identity before deleting.
Offline copy identifies the REST features that need a connection.
No account identifier or decision content is included.

Journal reports migration, durable save, pending-claim reconciliation, invitation retirement and
REST transport failures using static `journal-*` Sentry operation names. Migration and recovery
emit `sync_commit` with bounded outcome labels; claim/save and first-run retirements use the engine's
gesture events. Domain refusals retain the complete input in a local editor draft and keep the
editor's unsaved status; failed reconciliation emits a bounded `sync_commit` failure outcome.
Post-commit notice-cleanup failures use `journal-notice-cleanup` and preserve the successful save
outcome. Unreadable legacy data uses `journal-migration`, retains its source, and allows startup.
No page body, scales, date, claim identifier or account is reported.

Gym engine writes emit `gym_action` through the first-party events intake with only `operation`
and `outcome`. Operations are routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete, Undo and refusal. Outcomes are `saved-local`, `unchanged` (a clean draft or a rename to the
name the store holds writes nothing), `failed`, `held`, `undone`, `closed` and `refused`. A local save
records durability, not server admission. Unexpected product boundary failures use static
`gym-<operation>` Sentry names; projection failures use `gym-projection`. A malformed frozen plan
reports that static operation at read and write boundaries and is omitted from the display; the
workout's facts, set corrections and deletion remain available, and its stored plan is preserved.
Workout drafts stay in account-scoped device rows while admission is pending or refused; the
refusal step offers the retained editor without reporting its contents. A gym refusal and a store
failure report no `gym-<operation>`: engine telemetry owns transport, storage, authentication and
admission failures. No workout or note content, identifiers, field values, refusal details or raw
exception messages are reported.

Proposal decisions run through the gym domain. Removal snapshots persist in the account replica
until their outcome is visible; acknowledging one emits `gym_action` with `proposal-apply` and
`closed`. Failed acknowledgment uses `gym-proposal-apply`; a storage failure remains engine-owned.

Coach routine confirmation emits `gym_coach_routine_confirm` with only `outcome`: `started` when Save routine
sends, `saved` once the server confirms the draft (emitted even when the room has unmounted), `refused` when the
server answers 4xx (400, 401, 404, 409, 422) and `failed` on a 5xx, a network loss or a reply naming another draft.
Only `failed` reports to Sentry, under the static operation `gym-coach-routine-confirm`. No routine name, movement,
conversation, question, identifier or server text is reported.

Roadmap's Board/Graph switch emits `roadmap_view_switch` with only `view` (`board` or `graph`) when a reader
switches; the view a tree opens on emits nothing. Below 744px the Board's column tabs emit `roadmap_board_column`
with only `column` (`locked`, `upNext` or `done`) when a reader picks another column; the column a Board opens on, or
moves to because a step was selected elsewhere, emits nothing. From 744px to 1023px Show on the Board's rail emits
`roadmap_board_rail` with only `column` (`locked` or `done`, the column the reader stands) when a reader presses it;
a rail swapped because a selected step sat in it emits nothing. Show all on a folded Done emits `roadmap_board_done_expand`
with only `band` (`phone`, `tablet` or `desktop`) when a reader presses it; Done unfolding to reveal a selected step emits
nothing. A press on an action of the Board's states emits
`roadmap_board_state_action` with only `state` and `action`: `error` with `retry` (Try again after a failed load),
`empty` with `newStep`, and `complete` with `share` or `newStep`. A state showing emits nothing. The Board's controls
emit only what a reader changes: `roadmap_board_sort` with only `sort` (`roadmap`, `newest` or `oldest`) when another
order is picked from the menu or a phone's order chip is removed; `roadmap_board_filter` with only `count` (the kinds now
on, 0–6) when a kind swatch, All or a phone's kind chip changes the kinds; `roadmap_board_search` with no properties when
a search is committed (Enter, or leaving the field with a new search), never the text; `roadmap_board_clear` with only
`what` (`search`, `kinds` or `both`) and `from` (`field` for × or Escape in *Find a step*, `empty` for an emptied column's
way out, `sheet` for the filter sheet's Clear filters); `roadmap_board_branch` with only `action` (`anchor` when the
branch scope's title returns to its step, `clear` for its ×); and `roadmap_board_menu` with only `menu` (`sort` or
`filter`) when the sort menu or a phone sheet opens. Dismissing a menu, a sheet or a re-pick of the order in force emits
nothing, and no kind name, step, title or search text is reported. Opening a step from the Board emits `roadmap_board_step_open` with only `surface` (`modal` or `page`), `column` (`locked`, `upNext` or `done`) and
`door` (`card`, `step` for a row inside another step, or `link` for a step link the page arrived at, including Back or Forward into a roadmap whose address names a step);
moving back to a step already open within the same visit emits nothing. An action in the step's page or modal emits `roadmap_board_step_action` with only `surface`
and `action`: `complete`, `completeFromSubtasks` (All subtasks done · Complete step), `reset`, `undo`, `openInGraph`
(which also emits `roadmap_view_switch`), `viewBranch`, `delete`, `edit`, `editNote`, and `copyLink` with `outcome` `ok` or `failed`; a refused clipboard
write is an expected refusal and reports nothing to Sentry. A render failure inside the step's page or modal reports the
static Sentry operation `roadmap-board-step` with its stack frames and closes it.

Board completion emits `roadmap_board_complete` with `door` (`swipe` or `key`), and toast Undo emits
`roadmap_board_undo` with `act` (`complete`, `create`, `delete` or `recolor`). Tapping completion or creation toast text emits
`roadmap_board_toast_reveal` with `act` (`complete` or `create`). Delete emits `roadmap_board_delete` with `step`
(`confirm`, `cancel`, `held` or `sent`); `held` carries `door` (`menu`, `key` or `bulk`), and `sent` occurs only when release returns a dispatch receipt and also carries `via`
(`timer`, `replaced` or `left`). The step-menu `delete` action continues to mean that its menu item was pressed.
Opening the composer emits `roadmap_board_create` with `step: open` and `door` (`verbs`, `band`, `empty` or
`complete`) and `view` (`board` or `graph`); the identity row's New step button uses `door: verbs`. A successful create emits
`step: saved`, `column` (`locked` or `upNext`) and boolean `filterCleared`.
The composer also emits `roadmap_board_create` with `step` (`failed`, `retry`, `discard` or `cancel`). The picker
emits `roadmap_board_picker` with `mode` (`create` or `edit`) and `step` (`open`, `apply`, `cancel`, `more` or `revalidated`); only `apply` carries `count`, bucketed
as `0`, `1`, `2-5`, `6-20` or `21+`. With zero candidates the Prerequisites row opens no picker and
emits no event. These events carry no step ids, names, descriptions, queries or kinds.
Phone selection emits `roadmap_board_select` with `step: start`, or `step: end` and `via`
(`done`, `back`, `acted`, `emptied` or `left`). Revealing its kinds emits `roadmap_board_bulk` with
`step: kinds`; an applied bulk act carries `step` (`recolor` or `delete`) and `count` in the same
buckets as the picker. Re-picking the shared kind closes only the kinds row, retains selection,
writes nothing and emits no bulk act, toast or selection-end event. A refused recolor also keeps
selection open and emits no acted selection end; null receipts remain expected, not Issues.
Edit emits `roadmap_board_edit` with `step` (`failed`, `retry`, `discard`, `cancel` or `unchanged`);
a saved edit emits `step: saved` and booleans `name`, `description`, `kind` and `prerequisites` for
changed fields. Opening the workspace note editor emits the step action `editNote`, including Add note.
Workspace emits `roadmap_board_workspace` with only `action`: `subtaskAdd`, `subtaskToggle`,
`subtaskDelete`, `linkAdd`, `linkDelete`, `noteSave` for a changed note saved through workspace actions,
`noteDiscard` for confirming Discard draft, and `undo` for the phone checked toast. Saving an unchanged
note writes nothing and emits no `noteSave`. System Back or remote detail closure silently drops the
draft and emits no `noteDiscard`. These local workspace paths add no Sentry operation: render failures
reach `roadmap-board-step`, composer render failures reach `roadmap-board-composer`, and edit-save
exceptions reach `roadmap-board-edit`.
Opening shortcut help while the gate is open emits `roadmap_shortcuts_open` with only `view`
(`board` or `graph`). These events never carry note text, subtask labels, link URLs, ids or hues.
A recolor or edit dispatch exception, or a missing session on an editable owner Board, reports
`roadmap-board-recolor` or `roadmap-board-edit`, respectively. Null receipts are expected no-ops,
not Issues. Edit has no toast; recolor Undo reverts its receipt and regroups quietly.
A create exception or missing session on an editable owner surface reports `roadmap-board-create`; a not-ready
session is an expected failed-create event, not an Issue. An unexpected held delete release exception
restores the projected step silently and reports `roadmap-board-delete`. A null receipt (already absent or not ready)
is an expected no-op and reports no Issue. A composer render crash reports
`roadmap-board-composer`. Reports use static operation names and stack frames only. Board structural writes also
contain post-apply notification, storage and transport exceptions under `roadmap-sync-notify`,
`roadmap-sync-persist` and `roadmap-sync-send`, respectively. Those writes retain their receipt because their lattice
change has already applied; persistence or transport failure marks durability at risk.

The gated identity row emits `roadmap_verb` with only `verb` (`askAI`, `share`, `newStep`, `export`,
`settings`, `shortcuts`, `fork`, `more`, `next` or folded-icon `find`), `door` (`row`, `more` or
`sheet`), `view` (`board` or `graph`) and `band` (`phone`, `tablet` or `desktop`). The roadmap
sheet emits `roadmap_sheet` with `step` (`open`, `switch`, `new` or `browse`), or `step: close`
and `via` (`close`, `escape` or `scrim`). What's next emits `roadmap_whats_next` with `step`
(`open`, `pick` or `close`) and `count` in `countBucket`'s `0`, `1`, `2-5`, `6-20` or `21+` buckets.
Export emits `roadmap_export` with `outcome` (`done` or `failed`) and `door` (`more` or `sheet`).
A Graph search handing off to the Board emits `roadmap_graph_find` with `step: handoff`.
Graph toast outcomes emit `roadmap_graph_toast` with `act` (`complete`, `create` or `link`) and
`step` (`shown` or `undo`). Gated reader Share extends `link_copy` with `outcome` (`done` or
`failed`); clipboard refusal is expected and creates no Issue. Identity render failures report
`roadmap-identity`; unexpected export build/download failures report `roadmap-export`. Both use
static operation names and stack frames. Restore and revert failures retain their existing
operations. None of these events carries titles, ids, search text or roadmap names. State-word
copy and focus-ring changes emit no new events.

The switch, the tabs, the rail, Show all, the controls, the states, the step’s page and modal, and the
composer and picker exist only while the Board’s development gate
(`products/roadmap/board/gate.js`) is open, which it never is in production. Reading the gate's
storage flag fails closed and reports nothing. A render failure inside the Board reports the static Sentry operation `roadmap-board` with its stack frames (file, line, column and function name only),
drops the Board until that roadmap is opened again and shows the Graph. Loading a roadmap reports to Sentry whatever the
gate: `HttpTreeRepository` reports the static operation `roadmap-tree-load` when the server answers 5xx, answers 200
with something that is not a tree (an app shell a proxy served, say), or the request is lost while the page is visible,
the browser believes it is online and the roadmap is still wanted. It stays silent on a refusal (4xx), a request lost
offline or behind a hidden page, and a load aborted because the roadmap was left. Any other failure that stops the load,
except a tree neither the server nor this device has, reports `roadmap-load` with its stack frames (file, line, column
and function name only). Settings' Export all reads each server roadmap through the same repository under its own static
operation, `roadmap-export-load`, by the same rules. No tree, step, title, identifier, status text or exception message
is reported.
