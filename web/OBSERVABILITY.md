# Web observability

The browser engine injects telemetry through `syncTelemetry`. Its defaults send events through
`src/telemetry/beacon.js` and technical failures through `src/telemetry/sentry.js`. A telemetry failure
cannot stop synchronization. The beacon adapter encodes the spec's hyphenated event labels with
underscores because `/v1/events` accepts snake_case names. Each engine instance permits at most 30 reports per rolling minute;
injected limits are capped at 100. No raw exception, stack, body, field value, ID, scope reference,
account, email or token is forwarded.

Only a deployed build reports as `environment: production`. `scripts/test.mjs` drops the build's DSN, so a test run never reaches
Sentry, though a branch that predates that rule can still report from CI as `development`: read production's failures under
`environment:production`.

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

The shell's reporter, `reportError` in `src/telemetry/beacon.js`, takes window errors and unhandled
rejections from `main.jsx`, render crashes from an `ErrorBoundary` with no `onCrash`, and failed paste
shapes. Each emits one `client_error` with only `kind` (`window`, `promise`, `render` or `shape`),
`failure_kind` (the error's constructor name: `Error`, `TypeError`, `RangeError`, `ReferenceError`,
`SyntaxError`, `URIError`, `EvalError`, `AggregateError` or `DOMException`) and `route`, the family of
the current address: `/`, `/app`, `/app/roadmap`, `/app/gym`, `/app/journal`, `/app/settings`,
`/app/connect`, `/t`, `/demo`, `/browse`, `/gym/shared`, `/auth`, `/oauth/authorize`, `/showcase`,
`/roadmap`, `/gym` or `/journal`. Anything these sets do not name reads `other`, including product error
classes and thrown non-errors. No exception message, stack, identifier, token, date or query enters the
event. The same failure reports to Sentry under the static message `client-error`, with `kind` as its
type and tag, `failure_kind` as a tag, `route` as its request URL, and its stack frames (file, line,
column and function name only). The exception message reaches neither: the stack's head line, where V8
repeats it, is cut before the frames are read, frames are only the last unbroken run of frame lines,
and share addresses, `token=` and `code=` values are struck out of them. A rejected non-error has no
frames. A failed paste shape adds the Sentry tags `reason` (`unavailable`, `unreachable`, `failed`,
`no-first-word` or `stopped-mid-plan`) and `size` (`under-1kb`, `1-8kb` or `over-8kb`), and no text,
status or count. Sentry collapses a repeat of one kind, operation, route, tags and crashing frame
within ten seconds.

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

## Roadmap

The Board is the only path into a roadmap and nothing stands in front of it: every event and Sentry operation below fires
in production for whichever reader and band reach its step. Properties are allowlisted, bounded labels: no title, step or
roadmap id, kind name, search text, email or server sentence enters them. Two rows are the exceptions, and neither carries
what a person wrote: `demo_open`'s `treeId` is the one constant the bundle ships, and `birth`'s `quest` is an authored id.

`test/products/roadmap/observability.test.mjs` reads the code's syntax tree. It fails when a roadmap event name or Sentry
operation in the code is missing from these tables or a name in the tables is missing from the code, when an event's props
fit no row of its event or a value reads a content field such as a title or an email, when a count goes around `countBucket`,
and when a report's operation is not a literal or its error message is built at run time.

### Events

Each row is one exact shape: `key: a/b/c` allows those values, `key?:` may be absent, and — means no properties. A count
goes through `countBucket`: `0/1/2-5/6-20/21+`.

| Step | Event | Allowlisted props |
|---|---|---|
| Open a roadmap, first resolved view of the visit | `roadmap_view_open` | `view: board/graph`, `band: phone/tablet/desktop`, `role: owner/reader/demo`, `door: saved/default/link/empty/born` |
| Switch Board and Graph | `roadmap_view_switch` | `view: board/graph` |
| Phone column tab | `roadmap_board_column` | `column: locked/upNext/done` |
| Tablet rail's Show | `roadmap_board_rail` | `column: locked/done` |
| Done's Show all | `roadmap_board_done_expand` | `band: phone/tablet/desktop` |
| Commit a search (Enter, or leaving the field) | `roadmap_board_search` | — |
| Clear a search or filter | `roadmap_board_clear` | `what: search/kinds/both`, `from: field/empty/sheet` |
| Search on the Graph hands off to the Board | `roadmap_graph_find` | `step: handoff` |
| Change the kinds | `roadmap_board_filter` | `count: 0/1/2/3/4/5/6` |
| Change the order | `roadmap_board_sort` | `sort: roadmap/newest/oldest` |
| Open the sort menu or a phone sheet | `roadmap_board_menu` | `menu: sort/filter` |
| Branch scope's title or × | `roadmap_board_branch` | `action: anchor/clear` |
| A state's action | `roadmap_board_state_action` | `state: error`, `action: retry` |
| A state's action | `roadmap_board_state_action` | `state: empty`, `action: newStep` |
| A state's action | `roadmap_board_state_action` | `state: complete`, `action: share/newStep` |
| Open a step | `roadmap_board_step_open` | `surface: modal/page`, `column: locked/upNext/done`, `door: card/graph/activity/step/link` |
| Step page or modal action | `roadmap_board_step_action` | `surface: modal/page`, `action: complete/completeFromSubtasks/reset/undo/openInGraph/viewBranch/delete/edit/editNote` |
| Step section | `roadmap_board_step_action` | `surface: modal/page`, `action: section`, `section: overview/workspace/history` |
| Copy a step's link | `roadmap_board_step_action` | `surface: modal/page`, `action: copyLink`, `outcome: ok/failed` |
| Reset from the Graph's dock or tablet panel | `roadmap_board_step_action` | `surface: dock/panel`, `action: reset` |
| Complete by swipe, C, the dock, the tablet panel or the demo's coach | `roadmap_board_complete` | `door: swipe/key/dock/panel/coach` |
| Complete from the Graph's selection bar | `roadmap_board_complete` | `door: bulk`, `count: 0/1/2-5/6-20/21+` |
| Board toast's Undo; ⌘Z and ⇧⌘Z pressed | `roadmap_board_undo` | `act: complete/create/delete/recolor/graft/undoKey/redoKey` |
| Tap a completion or creation toast's text | `roadmap_board_toast_reveal` | `act: complete/create`, `view?: graph` |
| Graph toast shown or undone | `roadmap_graph_toast` | `act: complete/create/delete/recolor/rename/add/link_add/link_remove/graft`, `step: shown/undo` |
| Undo on an Ask AI answer | `roadmap_graph_toast` | `act: tend`, `step: undo` |
| Reader's Share copied its link | `roadmap_graph_toast` | `act: link`, `step: shown` |
| Reader's Share refused by the clipboard | `roadmap_graph_toast` | `act: link`, `outcome: failed` |
| Open the composer | `roadmap_board_create` | `step: open`, `door: verbs/band/empty/complete`, `view: board/graph` |
| Pasted plan opens its composer | `roadmap_board_create` | `step: open`, `door: paste`, `view: board/graph` |
| Create saved | `roadmap_board_create` | `step: saved`, `column: locked/upNext`, `filterCleared: true/false` |
| Create on the canvas, the tablet panel or the empty Graph | `roadmap_board_create` | `step: saved`, `door: canvas/empty`, `view: graph` |
| Add a pasted plan to the roadmap | `roadmap_board_create` | `step: saved`, `door: paste`, `view: board/graph`, `count: 0/1/2-5/6-20/21+` |
| Composer's other outcomes | `roadmap_board_create` | `step: failed/retry/discard/cancel` |
| Planting a new roadmap failed | `roadmap_board_create` | `step: failed`, `door: blank/import/quest` |
| Edit saved in the composer | `roadmap_board_edit` | `step: saved`, `name: true/false`, `description: true/false`, `kind: true/false`, `prerequisites: true/false` |
| Edit composer's other outcomes | `roadmap_board_edit` | `step: failed/retry/discard/cancel/unchanged` |
| Rename, recolor, link, unlink, reconnect or reorder on the Graph | `roadmap_board_edit` | `step: saved`, `view: graph`, `name: true/false`, `description: true/false`, `kind: true/false`, `prerequisites: true/false`, `order: true/false` |
| Change a kind in the Graph's legend | `roadmap_board_edit` | `step: saved`, `view: graph`, `legend: rename/describe/add/remove/recolor` |
| Prerequisite picker | `roadmap_board_picker` | `step: open/cancel/more/revalidated`, `mode: create/edit` |
| Picker applied | `roadmap_board_picker` | `step: apply`, `mode: create/edit`, `count: 0/1/2-5/6-20/21+` |
| Delete's confirmation | `roadmap_board_delete` | `step: confirm/cancel`, `view: board/graph` |
| Delete held for nine seconds | `roadmap_board_delete` | `step: held`, `door: menu/key/bulk`, `view: board/graph` |
| Held delete released | `roadmap_board_delete` | `step: sent`, `via: timer/replaced/left`, `view: board/graph` |
| A delete that could not land, at its start or at its release | `roadmap_board_delete` | `step: failed`, `outcome: not_ready/error`, `view: board/graph` |
| Retry on that delete's toast | `roadmap_board_delete` | `step: retry`, `view: board/graph` |
| Delete from the dock, the tablet panel or the canvas | `roadmap_board_delete` | `step: sent`, `via: direct`, `view: graph` |
| Phone selection starts | `roadmap_board_select` | `step: start` |
| Phone selection ends | `roadmap_board_select` | `step: end`, `via: done/back/acted/emptied/left` |
| Graph multi-select starts or ends | `roadmap_board_select` | `step: start/end`, `view: graph` |
| Reveal the bulk bar's kinds | `roadmap_board_bulk` | `step: kinds` |
| Bulk act on the Board | `roadmap_board_bulk` | `step: recolor/delete`, `count: 0/1/2-5/6-20/21+` |
| Bulk act on the Graph | `roadmap_board_bulk` | `step: recolor/delete`, `count: 0/1/2-5/6-20/21+`, `view: graph` |
| Workspace in the step page or modal | `roadmap_board_workspace` | `action: subtaskAdd/subtaskToggle/subtaskDelete/linkAdd/linkDelete/noteSave/noteDiscard/undo` |
| Workspace in the Graph's dock | `roadmap_board_workspace` | `action: subtaskAdd/subtaskToggle/subtaskEdit/subtaskDelete/linkAdd/linkDelete/noteSave`, `surface: dock` |
| A verb on the identity row | `roadmap_verb` | `verb: askAI/share/newStep/fork/find/next/more`, `door: row`, `view: board/graph`, `band: tablet/desktop` |
| A verb in More | `roadmap_verb` | `verb: askAI/share/activity/export/settings/shortcuts`, `door: more`, `view: board/graph`, `band: tablet/desktop` |
| A verb in the roadmap sheet | `roadmap_verb` | `verb: askAI/share/activity/export/settings`, `door: sheet`, `view: board/graph`, `band: phone` |
| A and ⌘K | `roadmap_verb` | `verb: activity/askAI`, `door: key`, `view: board/graph`, `band: tablet/desktop` |
| A row in the desktop Activity feed | `roadmap_verb` | `verb: activity`, `door: feed`, `view: graph`, `band: desktop` |
| Phone reader Board's Fork offer | `roadmap_verb` | `verb: fork`, `door: offer`, `view: board`, `band: phone` |
| Phone Graph's Fork, on the bar or the pill | `roadmap_verb` | `verb: fork`, `door: bar/pill`, `view: graph`, `band: phone` |
| Fork from the read-only notice | `roadmap_verb` | `verb: fork`, `door: notice`, `view: board/graph`, `band: phone/tablet/desktop` |
| Share from a milestone's ceremony | `roadmap_verb` | `verb: share`, `door: ceremony`, `view: graph`, `band: phone/tablet/desktop` |
| Ask AI sent, or its Why? opened | `roadmap_verb` | `verb: askAI`, `step: send/why` |
| Ask AI answered | `roadmap_verb` | `verb: askAI`, `step: answer`, `outcome: receipt/failed/rate/out/long/off` |
| Share dialog publishes or makes private | `roadmap_verb` | `verb: share`, `step: publish/private`, `outcome: ok/failed` |
| Share dialog's copy refused | `roadmap_verb` | `verb: share`, `step: copy`, `outcome: failed` |
| A link copied | `link_copy` | — |
| Roadmap sheet | `roadmap_sheet` | `step: open/switch/search/browse` |
| Roadmap sheet's New roadmap | `roadmap_sheet` | `step: new`, `door?: search` |
| Roadmap sheet closed | `roadmap_sheet` | `step: close`, `via: close/escape/scrim` |
| Tablet and desktop roadmap switcher; a rename or a delete once the request succeeded | `roadmap_sheet` | `step: open/switch/new/browse/rename/delete`, `door: switcher` |
| The switcher's rename or delete failed | `roadmap_sheet` | `step: rename/delete`, `door: switcher`, `outcome: failed` |
| What's next | `roadmap_whats_next` | `step: open/pick/close`, `count: 0/1/2-5/6-20/21+` |
| Export this roadmap | `roadmap_export` | `outcome: done/failed`, `door: more/sheet` |
| Settings' Export all | `roadmap_export` | `outcome: done/partial/failed`, `door: settings` |
| Shortcut help | `roadmap_shortcuts_open` | `view: board/graph` |
| Fork submitted | `fork_attempt` | `mode: email/instant/browse` |
| Fork's email answered with a refusal or a failure | `fork_attempt` | `mode: email`, `outcome: invalid/rate_limited/failed` |
| Instant Fork failed | `fork_attempt` | `mode: instant`, `outcome: unauthenticated/failed` |
| Gallery Fork failed | `fork_attempt` | `mode: browse`, `outcome: unauthenticated/failed` |
| Fork landed | `fork_claim` | `mode: email/instant/browse` |
| Sync status: offline episode | `roadmap_sync_offline` | `step: shown/cleared`, `pending: 0/1/2-5/6-20/21+` |
| Refusal shown, retried or discarded | `roadmap_sync_refused` | `step: shown/retry/discard`, `lane: structure/progress`, `code: tree-too-large/bad-frame/no-such-tree/server-error/other` |
| Device line shown | `roadmap_device_line` | `step: shown`, `line: anonymous/lapsed`, `place: row/shell` |
| Device line's phone row tapped | `roadmap_device_line` | `step: sign_in`, `line: anonymous/lapsed`, `place: row` |
| The demo's roadmap opened | `demo_open` | `treeId: t_9e407a96b5330ebe` |
| WebGL2 unavailable | `webgl_init_fail` | — |
| A roadmap planted from a quest | `birth` | `quest: <authored quest id>`, `steps: 0/1/2-5/6-20/21+`, `local?: true` |
| A roadmap planted blank or from an import | `birth` | `import?: true`, `steps?: 0/1/2-5/6-20/21+`, `local?: true` |
| Device roadmaps claimed at sign-in | `claim` | `treeCount: 0/1/2-5/6-20/21+` |
| Roadmap landing opened | `land` | `signedIn: true/false` |

`demo_open` fires alongside `roadmap_view_open`. `fork_claim` with `mode: email` comes from `shell/auth/AuthLanding.jsx`, once
the magic link lands.

### When an event stays silent

A step is a thing a reader did or was told. These emit nothing:

- The column a Board opens on, or moves to because a step was selected elsewhere; a rail swapped or Done unfolded to reveal a
  selected step; a state showing.
- Dismissing a menu, a sheet, Fork or Ask AI; re-picking the order or the shared kind in force; a recolor the session refused;
  a clean Save, which writes nothing and emits `unchanged` from the edit composer alone.
- Moving back to a step already open in the visit, closing a step, and system Back or a remote change dropping a note draft.
- The Prerequisites row with no candidates.
- A Delete key on a selection that takes every root a roadmap has left, on either view: Delete is not offered, so nothing
  happened.
- A rebaseline's pending records, an online discard, Saving and Saved. Refusal counts stay local.
- The camera, the minimap, the legend's highlight and folding, selecting one step, hovering and focus moves.

`roadmap_sync_refused` `shown` fires once for the refused frame, across re-flushes, and `discard` only after the session
confirms it. `roadmap_sync_offline` fires once per offline episode. `roadmap_device_line` `shown` fires once per visit.

### Technical failures

Every operation is a static name, reported through `telemetry/sentry.js` with stack frames only: file, line, column and
function. A report's `route` is a family (`#/app`, `#/settings`), never an address.

| Operation | What failed | What the reader gets |
|---|---|---|
| `roadmap-board` | The Board's render | The Graph, focus on the switch; choosing Board tries again |
| `roadmap-identity` | The identity row's render | `ViewSwitch` at the row's position |
| `roadmap-board-step` | The step page or modal's render | The step closes |
| `roadmap-board-composer` | The composer's render | The composer closes |
| `roadmap-board-create` | A create exception, its toast's Undo failing, or no session on an editable surface | The draft and its Retry stay; the failed Undo's toast closes |
| `roadmap-board-edit` | An edit exception, or no session on an editable surface | The draft and its Retry stay |
| `roadmap-board-recolor` | A recolor exception, its Undo failing, or no session | Selection stays |
| `roadmap-board-delete` | An unexpected held-delete release | The step returns, and its toast says *Couldn't delete* with Retry |
| `roadmap-step-restore` | A completion's Undo: a Board or Graph toast, or the step page's inline offer | The offer leaves |
| `roadmap-graph-undo` | A Graph toast's Undo, or the Board's Undo of a pasted plan, reverting its receipt | The toast closes |
| `roadmap-tend-undo` | Undo on an Ask AI answer | The toast closes |
| `roadmap-export` | Building or downloading an export | `roadmap_export` `failed`, no file |
| `roadmap-export-load` | Settings' Export all reading a roadmap or its marks, by the rules of `roadmap-tree-load` | *Exported 1 of 2 roadmaps.*, or the export's error when none could be read |
| `roadmap-tree-load` | The server answering 5xx or 200 with no tree, or a request lost while visible, online and still wanted | The load error |
| `roadmap-progress-load` | A server tree's marks, by the rules of `roadmap-tree-load`, or a 200 that is not JSON | The load error and Try again, never a false count |
| `roadmap-activity-load` | A server tree's activity, by the rules of `roadmap-tree-load`, or a 200 that is not JSON | The room opens with an empty feed |
| `roadmap-load` | Anything else stopping a load, except a tree neither the server nor this device has | The load error |
| `roadmap-fork` | Fork, from a roadmap or the gallery: a server failure, or a request lost while visible and online | Fork's own error |
| `roadmap-share` | Publishing or making private: a server failure, or a request lost while visible and online | The dialog's own error |
| `roadmap-switcher-rename` | The switcher's rename: a server failure, a request lost while visible and online, or an exception | The old name returns |
| `roadmap-switcher-delete` | The switcher's delete: a server failure, a request lost while visible and online, or an exception | The row stays |
| `roadmap-plant` | Planting a roadmap, blank, pasted or from a quest: a server failure, a request lost while visible and online, or an exception | The door's own error, or a device roadmap when the server can't be reached |
| `roadmap-tend` | Ask AI's reads and its send: a server failure, a request lost while visible and online, or a 200 that is not JSON | Ask AI's `failed` answer |
| `roadmap-sync-notify` | Notifying after a local write, a server frame, an epoch change or a discard projection | The write's receipt stays |
| `roadmap-sync-persist` | Storing a local write or mark on a database that opened | The receipt stays; durability is at risk |
| `roadmap-sync-send` | Sending a local write, including the IndexedDB epoch check on a database that opened | The pending bank stays and the refused card says so; durability is at risk |
| `roadmap-sync-restore` | A stored lane or record that cannot be read, once per session | That lane stays out until the server's graft fills it |
| `roadmap-sync-socket` | A socket with no inbound frame for ten seconds while online and in view, once per session | The Shell's sync status; reconnects keep trying |
| `roadmap-sync-frame` | A server frame that cannot be parsed or joined, once per session | The frame is dropped; a lane frame resubscribes |
| `roadmap-sync-discard` | An unexpected discard failure | The refusal stays |
| `roadmap-sync-refused` | An unexpected refusal, once per bounded code per session, with `code` as a tag | The refusal notice |
| `auth-session` | An unexpected account refresh failure | The session's existing path |

Expected answers are not Issues: a null receipt, a not-ready session on create or delete, a capacity or missing-tree
refusal, a refused clipboard, a browser refusing storage (one `[sync]` console warning per document, and writes still reach
the server), a socket unanswered while offline or hidden, a 4xx, a load aborted because the roadmap was left, a request lost offline or behind a hidden
page. Session expiry, including the 20-second account poll, keeps device work and reaches the lapsed line.

A render failure with no boundary of its own, an uncaught error and an unhandled rejection go through `reportError`, which
sends the labels and frames the shell's reporter above describes and no exception text.

`scripts/smoke-roadmap.mjs` sends nothing: it blocks the intake and Sentry at the network layer. Any Sentry attempt or
`client_error` beacon it blocks fails its walk.
