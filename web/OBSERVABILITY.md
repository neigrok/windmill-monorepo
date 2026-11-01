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
`empty` with `newStep`, and `complete` with `share` or `newStep`. A state showing emits nothing. The switch, the tabs, the rail, Show all and the states exist only while the Board's development gate
(`products/roadmap/board/gate.js`) is open, which it never is in production. Reading the gate's
storage flag fails closed and reports nothing. A render failure inside the Board reports the static Sentry operation `roadmap-board`,
drops the Board until that roadmap is opened again and shows the Graph. Loading a roadmap reports to Sentry whatever the
gate: `HttpTreeRepository` reports the static operation `roadmap-tree-load` when the server answers 5xx or the request
is lost while the browser believes it is online, and stays silent on a refusal (4xx) or a request lost offline. Any
other failure that stops the load, except a tree neither the server nor this device has, reports `roadmap-load`. No
tree, step, title, identifier, status text or exception message is reported.
