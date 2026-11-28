# Web observability

The browser engine injects telemetry through `syncTelemetry`. Its defaults send events through
`src/telemetry/beacon.js` and technical failures through `src/telemetry/sentry.js`. A telemetry failure
cannot stop synchronization. The beacon adapter encodes the spec's hyphenated event labels with
underscores because `/v1/events` accepts snake_case names. Each engine instance gives failures, step events
and `sync-writer` timings separate allowances per minute, so a burst of writes crowds out neither a failure
nor a step: at most 30 failures and 30 step events, and the timings of the first 10 writes that change
the store, each minute; injected limits are capped at 100. No raw exception, stack, body, field value, ID, scope reference,
account, email or token is forwarded.

The beacon sends what it has queued in batches of at most 50: as keepalive requests once 20 events wait, five
seconds after the first and on reconnect, and through `navigator.sendBeacon` when the page hides (a keepalive
request where the browser refuses the beacon). Both outlive the page, so a batch sent before or as the page
leaves still lands when it navigates, reloads or closes (`test/telemetry/beacon.browser.test.js` and
`test/sw-browser.test.mjs` prove it in Chromium and WebKit). Where the browser takes service worker routes
(Chromium), `public/sw.js` routes `/v1/` straight to the network: the worker's fetch handler would hand a
request sent as the page hides back to the network only after the page was gone. While the browser is offline
it keeps up to 200 newest queued events in memory and sends them on reconnect. It adds no content or
properties and stores no queue on disk, keeping best-effort delivery independent of browser storage and
leaving no behavioral history on a possibly shared device. Reloading or closing the page while offline loses
that queue; failed attempted sends remain fire-and-forget.

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
| `sync-start`, `sync-commit`, `sync-release`, `sync-undo` | Local engine and gesture steps. A commit or an act a sign-in or a sign-out overtook before it landed, in this tab or another, one the back/forward cache held among them, writes nothing and tells its `sync-commit` `not-writable` |
| `sync-inverse` | An Undo or Redo of a journaled act (engine.md §7.3 Undo of an act). When requested: `ok` when cancelled in place or already settled, `pending` while its slots wait or travel, `unavailable` for an act it cannot invert, `failed` when the transaction did not commit. When a pending request settles: `settled`, with its `applied` and `skipped` operation counts. At the first tab's engine start, while requests still wait: `pending`, with how many are `waiting` and the oldest one's `ageMs` |
| `sync-signin`, `sync-signout` | Lineage decisions and authentication transitions |
| `sync-auth-paused` | The active replica's sync stopping for its credential, told once by the transaction that makes the change: `paused` (a `401`, an answer or frame served as another principal, or the shell reading that the browser no longer holds the account's credential), `released` (a sign-in, a sign-out, the shell reading that the browser holds no credential, or a credential deletion that leaves none) |
| `sync-upgrade` | Sync stopping for an upgrade: `paused` at a `426` or a hello's `minSchema` above the registry; `superseded` when a bundle of a newer store version opens the device store, closing it under this tab (engine.md §7.8), which releases its locks at once (`sync-leader` `released` when it led); `reloaded` as that tab reloads itself, only when that loses nothing on its screen |
| `sync-persist`, `sync-leader` | Persistence request result and lock ownership |
| `sync-refused`, `sync-push-malformed` | Terminal refusals, and malformed push responses or receipts: a 400, or a `200` whose receipt or inverse outcomes the replica cannot read, which still acknowledges its entry |
| `sync-writer` | Transaction enqueue-to-durability latency and initial queue/read latency, sampled: the first 10 writes of each minute that change the store |
| `sync-digest-mismatch` | Confirmed scope digest disagreed with the server |
| `sync-store-cleared` | The browser cleared the device's store, as the backend reported it (web-device-parity.md §7 Cleared): an account read whose `syncReplica`, the replica its session last pushed for, is none of the replica ids this store holds or let go of lately, while the store keeps the device past the page and the active replica is bound to that account, at the read or at the sign-in that binds it after a question. Once per clear, by the write that marks the store with the account, in one tab; a reload, another tab and the next read find the mark. No property |

Properties are restricted to `scopeKind` (`product`, `tree`, `overlay`, `device`), a nonnegative safe
integer `seq`, `durationMs` and `queueMs` (capped at 60,000), `applied`, `skipped` and `waiting` (capped at
1,000), `ageMs` (capped at 30 days), and `outcome` (`ok`, `denied`, `unavailable`, `pending`, `settled`,
`paused`, `failed`, `acquired`, `released`, `superseded`, `reloaded`, `not-writable`). No id or value of an act, request or record enters them.
Failures reach Sentry with kind `sync`, route `/sync` and no stack, under these static operations only:

| Failure | When |
|---|---|
| `sync-storage` | The device store did not open, commit or read; an engine step no caller hears (a release, a cleanup, a peer's refresh) failed; a persisted restore failed. A store a newer store version's upgrade closed reports nothing: that is `sync-upgrade` `superseded`, and a write the tab tries afterwards reaches its caller as a `CommitError` of kind `store` |
| `sync-transport` | A hello, push or pull failed or answered what the engine cannot read, while the replica could sync; a store failure on the way is `sync-storage` alone |
| `sync-live` | The live socket ended or failed while it was wanted |
| `sync-leadership` | The tab lock or the channel between tabs failed |
| `sync-observer` | A listener of the engine, of a scope's observation or of its events threw |
| `sync-auth` | A sign-in whose hello did not answer as the account signing in, or that threw (a sign-out still open is no failure); a credential deletion the session owner's `clear` could not make |

Storage denial is explicit; no volatile fallback replaces durable work. A write
the device's store cannot commit reports `storage` once and reaches its caller as a `CommitError` of
kind `store`; an error a caller's read-and-commit function throws passes through unreported. The engine
asks no one whose credential the browser holds: the shell tells it what each read of `/v1/me` finds (its
20-second poll among them), and that read is what releases a paused anon replica. Each read also tells it whether the
server answered (an answer under 500), so a signed-out page, whose engine sends nothing of its own, reads `unreachable`
when the server is out of reach while the browser reports itself online, and journal search's first use of meaning there
is `needs_connection`, no Issue. After each read for an account the shell tells the engine the read's `syncReplica`, which
it keeps until the seat is bound to that account: a store the browser cleared emits `sync-store-cleared`, whose mark a
write that fails leaves for the next read or sign-in, reported as `sync-storage`; no replica id, session or account enters
either. A page in the back/forward cache reports nothing new: its rooms stand, and a write it
holds until the restore lands then, under the binding it was issued under, or fails as the `store` failure the restore already
reported. One whose seat another tab moved meanwhile writes nothing, reports no failure and tells its `sync-commit`
`not-writable`. Once a restore has failed, a write issued before the page is shown again fails at once, a `CommitError` of
kind `store` reported as `sync-storage` as any write the store did not commit, so nothing waiting on it hangs.

The shell reports session transition failures as `auth-session`, a refused auth-hint storage write as
`auth-hint-storage` and a read of `/v1/me` the engine could not take as `auth-credential-held`, each with
kind `auth`; a cookie cleanup that fails is the engine's `sync-auth`. Opening and warming the offline shell reports `offline-shell` to Sentry.
The read of `/v1/me` that lapses the seat clears the browser's cookie once a lapse ([CLAUDE.md](CLAUDE.md), Offline rooms
and browser replicas) and emits `auth_session_cleared` with `outcome`: `cleared` (the logout answered), `kept` (the read
under the cookie lock found a session another tab signed in meanwhile, and nothing was sent) or `failed` (the read had no
answer, the lock did not come within 10 s, or the logout failed, which reports `auth-session-clear` with its stack frames);
a failed clear leaves the seat lapsed and tells nothing more on that page. A lapse already cleared, by another tab or an
earlier page, emits nothing, and neither does a browser signed out all along.
The update-required reload emits `sync_upgrade` with `pending`, `ok` or `failed`; a failed
shell update reports the static `offline-shell-update` operation. A persisted page restore
reports storage failures and keeps its local records available for a retry.
Add/Discard and sign-out emit `sync_signin`/`sync_signout` with `outcome: pending`; the engine reports
completed transitions. A product that words its own question (`sync.signInWords`, `sync.signOutWords`) tells its steps
through the words' `onStep` (roadmap's `roadmap_signin` and `roadmap_signout` below), and so does one whose count a sign-in
question in the shell's words carries (`sync.signInWork`, gym's `gym_signin_decision` below); the shell adds none of its
own. A product's hook into a question that throws (`adoptionAnswer`, `adoptionCount`, `signInWork`, `signInWords`,
`signOutWords`, the words' `onStep`, `signOutNotice`, `signOutBegins`, `signOutForgets`) reports `auth-product-words`, and
the shell asks as it would of a product that says nothing. A
product's hook before the seat changes (`sync.seatWillChange`) that throws or outlasts its five seconds reports
`auth-seat-will-change`, and the seat changes without it. Escape
on such a sign-in question cancels the sign-in: one write drops the pending sign-in and records the cookie's cleanup, a
cancel that fails reports `auth-session` and keeps the question, and the cookie is let go as a finished sign-out's is. Revoking this session uses the sign-out question before clearing its cookie.
Account closure persists its account and current session before the server request and discards local
account data after it succeeds. The request names the confirmed account; `account-mismatch` retains
its local data and reports the auth-session failure. A failed local discard reports the same failure; reload and
retry reconcile that session before recovering the discard. A new session keeps its cookie, including
one that reopens the same account. Closure refuses an unavailable session identity before deleting.
The device holder restored after a lapse uses the bound replica’s existing durable account metadata; it is
not an authentication answer or an event property. Sign-in recovery uses the existing sync transition
events. Pending product cleanup is recorded with the replica transition and retried after reload; a failure
reports `auth-session` and retains the cleanup marker. A different confirmed account synchronously replaces
the previous holder's room with the shell's loading state until cleanup and binding complete. A failure keeps
the room blocked and uses the existing auth-session failure report and sync transition events.
Automatic retries compare the account with the owner
the read actually used, so ordinary signed-in cold loads do not repeat a read or its failure report. An
expected unavailable tree or offline transport failure is not a Sentry Issue.
Offline copy identifies the REST features that need a connection.
No account identifier or decision content is included.

The accepted-navigation coordinator reports technical failures to Sentry with kind `navigation`,
route `/app`, and only `navigation-commit`, `navigation-guard`, `navigation-restore`,
`navigation-traverse`, `navigation-retain`, `navigation-observer` or `navigation-reconcile`. No URL, history state, key, token, exception text or draft
is included. Admission creates no product events: existing room and sign-out events occur inside the
admitted action. A late asynchronous action failure still reports `navigation-commit` after native
fallback or disposal has revoked its navigation capability; each action reports that failure once and
cannot revive parked writes. Applied history remains owned until reconciliation or a handoff to newer
navigation; an error does not drop that responsibility. Admission context carries only the frozen `navigation` or
`sign-out` kind and is not a telemetry payload. Roadmap registers its shared-field draft blocker and reports its bounded decisions below.

The shell's reporter, `reportError` in `src/telemetry/beacon.js`, takes window errors and unhandled
rejections from `main.jsx` and render crashes from an `ErrorBoundary` with no `onCrash`. Each emits
one `client_error` with only `kind` (`window`, `promise` or `render`), `failure_kind` (the error's
constructor name: `Error`, `TypeError`, `RangeError`, `ReferenceError`,
`SyntaxError`, `URIError`, `EvalError`, `AggregateError` or `DOMException`) and `route`, the family of
the current address: `/`, `/app`, `/app/roadmap`, `/app/gym`, `/app/journal`, `/app/settings`,
`/app/connect`, `/t`, `/demo`, `/browse`, `/gym/shared`, `/auth`, `/oauth/authorize`, `/showcase`,
`/roadmap`, `/gym` or `/journal`. Anything these sets do not name reads `other`, including product error
classes and thrown non-errors. No exception message, stack, identifier, token, date or query enters the
event. The same failure reports to Sentry under the static message `client-error`, with `kind` as its
type and tag, `failure_kind` as a tag, `route` as its request URL, and its stack frames (file, line,
column and function name only), parsing both V8's `at fn (url:line:col)` and Safari/Firefox's
`fn@url:line:col`. The exception message reaches neither: the stack's head line, where V8
repeats it, is cut before the frames are read, frames are only the last unbroken run of frame lines,
and share addresses, `token=` and `code=` values are struck out of them. A rejected non-error has no
frames. Sentry collapses a repeat of one kind, operation, route, tags and crashing frame
within ten seconds.

A message the translator cannot show reports its first failure to Sentry, once per key per page load
whichever catalog tier reads it, under the static operation `i18n-missing-message`, with `i18n` as its
type and `kind` tag, the route family as its request URL and two more tags: `key` (a code identifier such
as `gym.log.emptyTitle`) and `reason`, what broke — `key` (its owner's catalog lacks the key), `argument`
(the call did not pass an argument the message shows), `syntax` (the message does not parse) or `count`
(a plural's count is not a number). A production build renders the key for the first three and, for
`count`, the message's `other` branch with the value as given. No message text or argument value is
reported. Outside production the translator throws instead.

Journal reports durable save, pending-claim reconciliation, invitation retirement and REST transport failures using
static `journal-*` Sentry operation names. Claim/save, first-run retirements and the carry's acts use the engine's
gesture events. Domain refusals retain the complete input in a local editor draft and keep the
editor's unsaved status; failed reconciliation emits a bounded `sync_commit` failure outcome.
Post-commit notice-cleanup failures use `journal-notice-cleanup` and preserve the successful save
outcome; it, `journal-save`, `journal-invitation` and `journal-claim-reconcile` carry the error's stack, its message struck.
A save, a retirement or a claim's reconcile a sign-in or a sign-out overtook, in this tab or another, the one binding the
signed-out replica in place included, is refused (`ReplicaChanged`), lands in no seat and is no Issue: it tells
`sync_commit` `not-writable`, and a save's words stay on the screen, unsaved.
The carry of what the journal's bundle before the engine kept in this browser's storage (`carry.js`) emits
`journal_carry` with `seat` (`anon` or `account`, whose pages they are; `unclaimed` for those returned), `outcome` and
`pages`, a count through `countBucket` (`0/1/2-5/6-20/21+`): `carried`, the pages a run wrote into the replica as claims
or drafts to recover; `cleared`, pages that left the stores while nothing was written, by a run (every page already
recorded in the ledger, or only the account's own copies), before the seat changed (`settleSeat`, the pages the
replica's ledger records) or at the account's closure (`forgetClosedAccount`, every page of its seat); `failed`, a run an act's write failed, and `refused`, a run an act the domain refused, each
after the `carried` of the acts before it, the pages it left owed in their stores; `returned`, the unattributed pages the
journal's first bundle on the engine had kept in the device's metadata, back in the browser's storage, once. A run that
writes and deletes nothing emits nothing, so a browser whose stores hold nothing is silent, and a run a sign-in or a
sign-out overtakes ends quietly, the pages it had not carried left in their stores. A refusal is an event, never an Issue.
Sentry hears `journal-migration` with the error's stack and `stage`: `read` (the browser refused its storage, or an
entry does not read as a page, which stays where it is; once a page load, no stack for an entry), `write` (an act
failed; its pages and those after it stay in their stores), `clear` (a store would not change; its carried pages leave
it at the next run or before the seat changes; once a page load from a run; a closed account's store stays) or `leftovers` (the return of the first
bundle's metadata failed; it is tried again at the next run). Settings' unsent pages emit `journal_unclaimed` with
`action` (`restore` or `discard`), `outcome` (`ok`; `none` where no page waited any longer; for a restore,
`replica_changed` where the account changed before or while it wrote and `refused` where the domain refused an act,
either leaving the pages not yet written where they were; or `failed`) and `pages` through `countBucket`. Every finished
sign-out, Keep or Discard, forgets them (`forgetUnclaimedPages`, the journal's `forgetDevice`) and emits
`journal_unclaimed` with `action` `forget`: `outcome` `ok` with the pages it deleted, counted as Settings lists them and
with any the device's metadata still held, or `failed` with `pages` `0` where the browser refused its storage or the
metadata's write failed, the stores before the refusal gone and the rest
tried again at the next sign-out; a sign-out that finds none emits nothing. Only `failed` also reports
`journal-restore`, `journal-discard` or `journal-forget` with the error's stack. No day, page body, scale, claim
identifier, store key or account is reported.
Settings' export emits `journal_export` once a press with `seat` (`signed_out` where the replica it reads is the browser's
own, `signed_in` where it is an account's) and `outcome`: `ok`, `empty` (the replica held no written page, so no file was
handed over), `first_pull_timeout` (a bound replica's first pull of the journal did not end within 30 seconds),
`replica_changed` (the account changed while it waited), `no_replica` (the browser holds no open replica) or `failed`, any
other error, which alone also reports `journal-export` with the error's stack and `step`: `pages` (reading the pages),
`file` (writing them as Markdown) or `download` (handing the file to the browser). The section's count of those pages
before any press reports `journal-export` with `step: count` once where it cannot read them, and no event; the export
stays offered.
Search by meaning emits `journal_search_meaning` once for each opening of search, as its model comes up or does not,
however often the pages change while it is open: `outcome` `ready`; `needs_connection` (the engine says the browser is
offline or the server unreachable, and search by meaning never came up in this browser, so the search says it needs a
connection the first time); `unkept` (offline, in a browser where it came up before and that keeps it no longer, so the
search answers in words); or `failed` (it did not come up with a connection), which alone also reports
`journal-search-meaning` with the error's stack and `step`: `worker` (the model's worker did not start) or `model` (the
model did not load in it). A model that came up and then could not index the pages reports `journal-search-meaning` with
`step: index` and no event. `cache_refused` is told at most once an opening, when the service worker says the browser
would not keep the weights it served (`public/sw.js` posts `model-not-kept` to the pages it controls). No page body,
scales, date, claim identifier, search text or account is reported.

Journal Talk emits `journal_talk_refused` each time the sheet says why Talk refused, with `code`, `reason` and
`moment`. `code` is the allowance or voice route's code (`subject_exhausted`, `free_month_exhausted`,
`free_day_exhausted`, `concurrency_exhausted`, `funding_required`, `device_bound`, `debt_outstanding`, `unconfigured`,
`ai_accounting_unavailable`, `voice_busy`, `voice_unavailable`, `voice_ration_spent`), `other` for a code outside
that set, `status_<n>` where the answer carried none, or `unreachable` where nothing answered. `reason` is
`allowance_exhausted`, `request_exceeds_remaining`, `held` (a spent allowance a request in progress still holds),
`unavailable` or `none`. `moment` is `take` (a take's answer), `before_take` (the allowance read refused before the
microphone opened) or `remembered` (a press reopened a refusal the tab holds until its date). The event is sent once,
when a sheet first shows the face: an answer that lands while the journal room is away is told when the room shows it.
`journal_talk_take` carries `action`: `written` (a take's words went into today), `download` (from the sheet or the
sign-out question), `close` (the sheet closed on a kept take), `discard`, `undo`, `retry` or `sign_in`.
`journal_talk_retry` carries `outcome`: `written`, `refused` or `unreachable`. Sentry hears, under static
operations, a transcribe (`journal-talk-transcribe`), allowance read (`journal-talk-allowance`) or subscription read
(`journal-talk-subscription`) that got no answer (`failure`: `unreachable` or `timeout`), a success whose body is not
what it should carry (`failure: unreadable` and its `status`) or a 5xx the server did not explain (`failure: status` and
its `status`), a take the browser cannot decode for its waveform (`journal-talk-levels`) and a playback it refuses
(`journal-talk-playback`). A refusal the server explains is not an Issue. No audio, transcript, duration, date,
filename or allowance amount is reported.

Gym engine writes emit `gym_action` through the first-party events intake with only `operation`
and `outcome`, and for `refused` a `code`: `not-writable` or `domain`. Operations are routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete, Undo, refusal and `workout-adopt`, the hook before the seat changes saving each signed-out workout for adoption in
an act of its own, told once when it saved something (`saved-local`) and once for each workout refused or failed. Outcomes are `saved-local`, `unchanged` (a clean draft or a rename to the
name the store holds writes nothing), `failed`, `held`, `undone`, `closed` and `refused`.
Settings' Default rest and Rest sound (WD10) tell `gym_preference_changed` in its place, once per change, through
`preferenceStep` in `gymRuntime.js`: `setting` (`rest_default` or `rest_sound`) and `outcome`, `saved` once the copy holds it,
`not_stored` when the copy could not keep it, `refused` when the gym refused the value or the replica moved under the save,
and `failed` for any other failure, which alone also reports `gym-rest-save` with the error's stack frames; never the value.
A store failure there is the engine's to report.
A sign-in question in gym's count (WD9) tells `gym_signin_decision` with `step` (`shown` as it is asked, then `add`,
`discard` or `cancel`) and `count_bucket` (`0/1/2-5/6-20/21+`), what it counted: the browser's workouts, routines,
weigh-ins, movements and settings, or its changes where it holds none of them. How a copy In this browser
holds ended, a signed-out workout the account could not take or a start that lost a race, is one `gym_recovery` with
`outcome` (`saved` as a lost race's sets are saved from its notice, `kept`, `retried` or `discarded` as the person answered
it, `refused` or `failed` when the answer did not land) and `reason`, the review's bounded label (`session-open`,
`session-overlap`, `id-taken`, `bad-instant`, `too-many-sets`, `invalid-set`, `unknown-exercise`, `session-finished`,
`unsent`, `other`). An answer that fails, a save of a refused start that fails, and a proposal a copy held that the account
refuses to issue again report `gym-workout-recover` with the error's stack frames; settling the copies the account took
(`watchBrowserCopies`) reports the same name. A local save
records durability, not server admission. Unexpected product boundary failures use static
`gym-<operation>` Sentry names with the error's stack frames, never its message; projection failures use `gym-projection`. A malformed frozen plan
reports that static operation at read and write boundaries and is omitted from the display; the
workout's facts, set corrections and deletion remain available, and its stored plan is preserved.
Workout drafts stay in account-scoped device rows while admission is pending or refused; the
refusal step offers the retained editor without reporting its contents. A gym refusal and a store
failure report no `gym-<operation>`: engine telemetry owns transport, storage, authentication and
admission failures. A write whose replica changed under the room, a sign-in or a sign-out having moved the engine before
it or while it waited (the engine's `ReplicaChanged`), is such a refusal: `gym_action` with `refused` and `code: not-writable`,
and no Issue; every other refusal, the gym's rules on
this device or the server's notice of one, carries `code: domain`. The room drawing before the account answers
adds no event and no failure of its own. No workout or note content, identifiers, field values, refusal details or raw
exception messages are reported.

A workout on the web tells its steps under the iPhone's event names, through `workoutStep` in `gymRuntime.js`, whose
properties are each one of a closed set of labels and never a name or an id of a workout, a routine or a movement, nor
any load, rep or duration: `gym_session_started` (`screen: workout`, `door`: `routine` or `empty`), `gym_set_logged`
(`screen: workout`; a second tap on an offer another tab already logged tells nothing), `gym_session_finished` (`screen:
workout`), `gym_workout_plan_changed` (one per kind of edit a save makes, `action`: `retarget`, `add_set`, `remove_set`,
`swap`, `add_movement`, `remove_movement` or `rest`, and `door: workout`), `gym_workout_adjusted` (`screen: workout`,
`field`: `weight` or `reps`, for a load or a count typed or stepped) and `gym_workout_movement_chosen` (`screen: workout`, the
movement in hand changed from the index, the arrows, the dots, a swipe or Next), each with `outcome` `ok`, `refused` with
`code` (`not-writable` or `domain`) and, for a plan another tab or device changed first, `reason: stale`, or `failed`. The
page tells `gym_rest_target_reached` (`screen: workout`) once per rest, from the tab the sync engine leads from (a tab on
screen whenever one is) when it draws the workout, as the rest comes to its target or, for a rest the tab drew short of its
target, as a new default rest puts the target behind it; the tone and the buzz it plays while Rest sound is on are not
reported; `gym_hidden_workout` (`action: hide` as the page is left with the
workout open, `action: open` with `door: bar` from the bar over the tab rail); `gym_workout_popped_out` (`screen: workout`,
`outcome` `ok` or `failed`) as Pop out opens its window or the browser refuses it; and the receipt's
`gym_receipt_plan_saved` (`outcome`) when Done saves the plan's changes to the routine. An unexpected failure of a workout's
write reports to Sentry under a static `gym-workout-start`, `gym-rack-settle` (each failed settle, which the page tries
again), `gym-rack-turn`, `gym-set-log`, `gym-plan-revise` or `gym-workout-finish` with the error's stack frames, and a
pop-out window the browser would not open reports `gym-pop-out` with its stack; a refusal and a store failure report none,
as above. A set's correction and a finished workout's discard keep their `gym_action` (`set-correct`, `delete`). Nothing
the tab's title, favicon or pop-out window shows is reported.

Proposal decisions run through the gym domain. Removal snapshots persist in the account replica
until their outcome is visible; acknowledging one emits `gym_action` with `proposal-apply` and
`closed`. Failed acknowledgment uses `gym-proposal-apply`; a storage failure remains engine-owned.

Gym's Coach runs its turn in the browser (`products/gym/coach/`: `CoachTurns`, `GymTurnHost`, `GymTurnTelemetry`). Each
send that opens a turn emits `gym_ask_started` (`screen: coach`), and each send ends in one `gym_ask_outcome` with `screen:
coach`, `outcome` (`answered`, `cancelled`, `refused`, `failed`, `interrupted` when the seat changed under it, `gone` when
its conversation was deleted elsewhere, `capped` for the allowance or the shared capacity, `offline`, `absent` for a server
without Coach) and, for a turn that ran, `duration_ms`. A picture chosen for a question emits `coach_picture` (`outcome`:
`attached` or `failed`), and a conversation deleted from History `coach_conversation_delete` (`outcome`: `deleted`,
`answering` when its turn runs on this page and it stays, `refused`, `failed`). The engine's port emits one
`coach_turn` per turn (`state`, `seat`, `code` from a closed list or `other`, `rounds`, `ability_calls`, `refusals`,
`answer_bytes`, `duration_ms`) and one `coach_ability` per call, the turn's opening context reads included (`name`, a
catalog/3 ability or `other`, and `outcome`, `ok` or a known refusal code). A turn recovered on return emits its
`coach_turn` and no `gym_ask_outcome`. Failures report to Sentry with the error's stack, its message struck out: the
engine's `agent-host` for a fault of the host inside a turn, which then ends `failed` as `host-fault`; `gym-coach-turn`
tagged `failure_kind` `storage` (a write of the turn's own, or a conversation's delete, that failed outside the engine; a
write refused because the account changed under it is not one), `share` (the Share door answering 5xx or unreadable; a
4xx, a lost connection and a door silent for 15 s are the model's `refused`, with no Issue), `refusal` (a picture sweep
held by a message this build cannot read), `settle` (the room's own reading of a turn's end failed) or `picture` (the
browser failed to prepare a picture it could read); and the AI client's own `ai-call` and `ai-pass`, with the error the
client caught. A report names its error's kind only from a closed list, else `other`. A pass door
that answered, whatever its body, is never read as a lost connection: the room says Coach did not answer. A conversation
deleted on another device under a running turn, and a turn ended by a sign-out, are expected and report nothing. No
question, answer, picture, call input or result, id, pass or call id enters an event or a report.

Coach during a workout (WD7) tells its steps under the iPhone's names through `coachStep` in `gymRuntime.js`, each property
one of a closed set of labels and never a name or an id of a workout, a routine, a movement or a proposal, nor Coach's words.
`gym_action` (`screen: coach`, `action: new_chat`, `door: workout`, `outcome: ok`) comes from the gesture that starts a fresh
chat over the workout alone: the rail's Coach tab the first time the page shows it, or the phone's Coach button when the sheet
holds no conversation with a turn running or a change to this workout waiting; a flip of the tabs or a resize tells nothing.
`gym_proposal_outcome` (`screen: coach`, `target`: `workout` or `routine`, `action`: `apply` or `reject`) is told once for
each decision on a proposal's card in Coach or in the routines review, by the page that made it and as the log answers it:
`outcome: decided` once the log took it, or `failed` with `reason` once the log refused it: `replaced`, `workout-changed`,
`workout-moved` (a movement logged since, also the log's `plan-logged`), `workout-finished` (also the log's `session-finished`
for a change that reached it after the workout finished, the decision folded into that refusal), `routine-changed`, `settled`
(decided on another device first), `invalid` (a load under a movement's floor), `gone` (the proposal or its workout deleted)
or `other`. A decision that finds the proposal standing as asked writes nothing and is `decided` at once, unless another
page's decision on it waits on the log and tells it. One this copy's rules refuse is told at once: `refused` for a value
they hold invalid, such as a load under a movement's floor, `failed` with its `reason` otherwise; one that broke is `failed`
with no reason; and a routine's decision the log has not answered in 15 s is told `stalled` once besides. A reload, a remount or another tab tells nothing of a
decision, and a page that closes before the log answers tells nothing of it either. A workout proposal's decision that fails
unexpectedly reports `gym-workout-proposal-apply` or `gym-workout-proposal-dismiss` with the error's stack frames; a refusal,
the copy's or the log's, is the card's sentence and no Issue. A decision on a workout proposal the log refused is the card's
to say, so the room voices no notice and tells no `refusal` step for it.

## Front page, product landings and the pricing page

The brand root (`/`, `src/shell/marketing/BrandLanding.jsx`) and each product's landing (`/roadmap`, `/journal`, `/gym`,
`src/shell/marketing/ProductLanding.jsx` drawing the page its product supplies) wear one chrome
(`src/shell/marketing/SiteChrome.jsx`) and tell one event for each link and control a person uses, through `track` in
`src/telemetry/beacon.js`. Every event carries `page`: `front` for the brand root, the product's registry id for its
landing. Properties are allowlisted, bounded labels: no address, link text, account or email enters them. `product` is a
product's registry id. One use of a link tells one event: the second click of a double click tells nothing. Nothing inside a
picture frame is a control; a picture tells `front_picture` once a mouse or pen has rested on it for a second, drawn and
in view, with the page still. `test/shell/marketing/BrandLanding.test.js` and `test/shell/marketing/ProductLanding.test.js`
drive every link and control, signed out, signed in and with a link already sent, and hold the events to this table;
`ProductLanding.test.js` also holds every picture's name to the `front_picture` row, and
`test/shell/marketing/pictureMotion.browser.test.js` holds when it is told.

The pricing page (`public/pricing.html`), a static page in the same look, and the support page (`public/support.html`), in
the family look, tell the same events as `page: pricing` and `page: support` through `/events.js`
(`scripts/staticEvents.js`); the build makes every static page in the instrument look link it, and any page that links it
name a page it knows on `<html data-page>`. The support page's switch is the family look's Light · Dark in its header, told as `front_control`
`appearance` like the footer's. It sends each event as it happens, one beacon each, or one keepalive request
where the browser refuses the beacon; a failed send is dropped and never tried again. It reads the session key `beacon.js`
keeps, minting it there when none is stored, and is muted on localhost as `beacon.js` is. A link tells `front_link` from
the `data-to` and `data-product` it carries and the `data-area` around it, each checked against the file's fixed lists; a
link without them, the skip link, tells nothing. The page's links are links, not controls: Sign in (`sign_in`, the brand
root's door), the account seat (`settings`) and Feedback (`feedback`, the mail address) each tell `front_link`. The
switch tells `front_control` when `/appearance.js` announces a pick that moves the check. `test/scripts/staticEvents.test.mjs`
drives the emitted file, and `test/shell/pricing.test.mjs` holds every link on the page to the labels it tells.

| Step | Event | Allowlisted props |
|---|---|---|
| The page opened, once per mount, at its first paint without waiting on the network (on the pricing page, once per load); the intake tells a signed-in person from a stranger by the session the beacon carries | `front_open` | `page: front/roadmap/journal/gym/pricing/support` |
| A link followed. `area` is where it stands: the header, the brand root's three tools, a room's section on the brand root, "Your AI, or ours.", the footer's sitemap, or on a landing its first screen (`first`), a section's own link (`section`), a feature's link (`feature`) or the closing. `to` is what it opens: the page's own top (`home`, the mark), a product's landing or room, the live demo, a section of the same page (`section`: Gym's Where it runs, Journal's echoes), the app (`app`, the pill: `/app` signed out, the last room signed in) or a named page. On the static pages `area` is also pricing's three ways (`ways`), support's body (`content`) or the footer (`footer`), and `to` also the sign-in door, account settings or the feedback address | `front_link` | `page: front/roadmap/journal/gym/pricing/support`, `area: header/tools/room/ai/sitemap/first/section/feature/closing/ways/content/footer`, `to: home/landing/room/demo/section/app/pricing/connect/changelog/gallery/support/privacy/terms/refunds/sign_in/settings/feedback`, `product?: roadmap/journal/gym` |
| A control used: Sign in, the Link sent reminder that reopens the door, Feedback, the footer's Auto · Light · Dark switch (a segment already in use tells nothing), and the account seat's Settings and Sign out. Only `appearance` carries `choice` | `front_control` | `page: front/roadmap/journal/gym/pricing/support`, `control: sign_in/link_sent/feedback/appearance/settings/sign_out`, `choice?: auto/light/dark` |
| A picture looked at: a mouse or pen, on a device whose primary pointer hovers, rested 1000ms on the drawn picture while at least 60% of it stood in view (or it covered 60% of the view's height) and the page did not scroll, once per picture per page load. Entering, leaving, a scroll or the picture leaving view starts the second over; a pass across it, a scroll past it, a sliver of it, a frame whose picture never drew, a finger, or a picture whose motion failed tells nothing. `picture` is the fixed name its declaration carries | `front_picture` | `page: front/roadmap/journal/gym`, `product: roadmap/journal/gym`, `picture: root/hero/unlock/paths/step/fork/night/search/write/look_back/logger/connect/remembered/strength/routine` |

A product's picture whose chunk fails leaves the page whole and its frame at its height, and reports `front-picture-roadmap`,
`front-picture-journal` or `front-picture-gym`, with kind `render`, no stack and the page's path as its route, once per page
load for each page and picture, however often the page mounts (`BrandLanding.browser.test.js`,
`ProductLanding.browser.test.js`). A failure in the code that moves a picture, under a pointer or on a phone as it comes
into view (`src/shell/marketing/pictureMotion.js`), leaves that picture wholly still, never pointed again and telling no
`front_picture`, and reports `front-picture-motion` with kind `render`, the error's stack frames, the page's path as its
route and the tags `product` and `picture`, once per page load for each page (`pictureMotion.browser.test.js`). A landing whose own code cannot load (its chunk, its page's words, a stylesheet, or a
session provider above it) keeps the first HTML the document arrived with, its whole page and links, and reports
`landing-front`, `landing-roadmap`, `landing-journal` or `landing-gym` once, with kind `render`, no stack and the page's
path as its route (`src/shell/arrival.jsx`). Any other render crash reaches `client_error` under the page's route family. The sign-in door and the feedback dialog it opens tell
and report their own sends:

| Step | Event | Allowlisted props |
|---|---|---|
| A sign-in link asked for at the shared door, on any page | `sign_in_link` | `outcome: sent/refused/failed`, `reason?: invalid_email/rate_limited` when refused, `network/server/request` when failed |
| Continue with Google chosen at the shared door, as the browser leaves for Google's consent; the sign-in that follows arrives as a new page | `sign_in_google` | `outcome: started` |
| Feedback sent from the shared dialog | `feedback_send` | `outcome: sent/refused/failed`, `reason?: refused` (a 400 or 429), `network/server/request` when failed |

A failed send, not a refusal, also reports to Sentry with no stack: `auth-magic-link` (kind `auth`) and `feedback-send`
(kind `feedback`), each tagged with its `reason`. Neither carries the address, the message or the server's words.

## Roadmap

The Board is the only path into a roadmap and nothing stands in front of it: every event and Sentry operation below fires
in production for whichever reader and band reach its step. Properties are allowlisted, bounded labels: no title, step or
roadmap id, kind name, search text, email or server sentence enters them. Two rows are the exceptions, and neither carries
what a person wrote: `demo_open`'s `treeId` is the one constant the bundle ships, and `birth`'s `quest` is an authored id.

`test/products/roadmap/observability.test.mjs` reads the code's syntax tree. It fails when a roadmap event name or Sentry
operation in the code is missing from these tables or a name in the tables is missing from the code, when an event's props
fit no row of its event or a value reads a content field such as a title or an email, when a count goes around `countBucket`,
when a report's operation is not a literal or its error message is built at run time, and when a row lists other values than
the code gives a prop only running code knows: the doors into a step's tree, what an owner's room knows of its trees, why a
room cannot show its roadmap (`UNSHOWN`) and why a birth planted nothing (`BirthFailure`), with the reasons `roadmap-plant`
reports under.

### Events

Each row is one exact shape: `key: a/b/c` allows those values, `key?:` may be absent, and — means no properties. A count
goes through `countBucket`: `0/1/2-5/6-20/21+`.

| Step | Event | Allowlisted props |
|---|---|---|
| Open a roadmap, first resolved view of the visit. `tree` is a tree gone into through a step and `back` the roadmap come back to, each once: a reload of that entry opens by the other doors. An owner's room adds what it knows of the trees its steps open: `none` opens one, every one was `read`, or one stands `unread` | `roadmap_view_open` | `view: board/graph`, `band: phone/tablet/desktop`, `role: owner/reader/demo`, `door: saved/default/link/empty/born/no_graph/tree/back`, `trees?: none/read/unread` |
| A build whose room reads the device's copy: the room shows its load error instead of a roadmap, once a visit, and why: `unkept` where the browser's copy could not open, as in a browser that keeps nothing (which is not supported, so such a reader cannot be shown a roadmap), `unopened` where it did not open within ten seconds, `missing` where the device, having its answer, holds no roadmap the person may read at the address (one that is not there, a private one a stranger opens, a hidden subtree), and `unanswered` where the server went ten seconds without an answer before the device held a whole copy of the roadmap, or cannot be reached and the device holds no whole copy of it. A reading a sign-in or Try again runs in the same visit tells nothing more. The bare `#/app` door tells it too, `unkept` or `unopened`, where the copy cannot open and the door stays, unable to say which roadmap is the person's newest | `roadmap_load` | `outcome: unkept/unopened/missing/unanswered` |
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
| Go into another tree of the holder's. Down into the tree a step opens: the card's pill, the swipe's Open, the toast a C raises, the shared step document or a Graph naming panel. Up into a tree above: its name over its guide in the guide's note. `place` is where the room's holder acts: `account` on a tree the server keeps, `device` on one that lives only on this device, signed in or not, as for every `place` below | `roadmap_tree_open` | `door: pill/swipe/toast/step/dock/panel/bar/guide`, `view: board/graph`, `band: phone/tablet/desktop`, `place: device/account` |
| Come back to the roadmap a tree was gone into from, by the Back chip or the browser's Back, once per going in. A return after going Forward into the tree again is an ordinary visit: no `roadmap_tree_back`, the view opens by its usual door, and a step open on that entry is counted as reached by a link | `roadmap_tree_back` | `band: phone/tablet/desktop`, `place: device/account` |
| Go into the subtree a step owns, by the same surfaces a tree is gone into by but the guide's names: the card's pill, the swipe's Open, the toast a C raises, the shared nonmodal step document or the Graph's remaining tree controls. Its owner and anyone who reads the roadmap, on a share's address too; `role` says which | `roadmap_subtree_open` | `door: pill/swipe/toast/step/dock/panel/bar`, `view: board/graph`, `band: phone/tablet/desktop`, `role: owner/reader` |
| Come back up from a subtree to the roadmap its owning step stands in, once per going in: by the Back chip or the browser's Back where the person came down that step, or by the chip from a subtree reached any other way, which opens the owning step there | `roadmap_subtree_back` | `band: phone/tablet/desktop`, `role: owner/reader` |
| Open the tree picker from a step's Tree section: the + on a step that opens no tree, or Change tree under the section's ⋯. Fork tree pressed on a roadmap the person can only read | `roadmap_tree_attach` | `step: open/fork`, `band: phone/tablet/desktop`, `view: board/graph`, `place: device/account` |
| A roadmap address in Find a tree came to one of the person's own roadmaps, one they can only read, or none they can read: once for each roadmap the field named while the picker stood open. Only this app's `/t/<id>` and `/#/app/<id>` addresses and a bare tree id are addresses, read when pasted or once the field has been still for 300 ms. On a tree that lives only on this device, an address of a tree of this device's is `own` and any other `unreadable`, with no request made | `roadmap_tree_attach` | `step: paste`, `outcome: own/readable/unreadable`, `band: phone/tablet/desktop`, `view: board/graph`, `place: device/account` |
| A tree attached to a step that opened none, changed for another, or detached, and whether a hand's mark on the step was set aside or returned. `refused` when the session took no write, and `failed` when the write threw; either keeps the picker's choice and says *Couldn’t change the tree. Try again.* A step that already opens the tree chosen, as when a peer set it meanwhile, emits nothing | `roadmap_tree_attach` | `step: attach/change/detach`, `mark: kept/none`, `outcome?: refused/failed`, `band: phone/tablet/desktop`, `view: board/graph`, `place: device/account` |
| Undo on the toast of an attach, a change or a detach. ⌘Z and ⇧⌘Z after one are `roadmap_board_undo` (`undoKey`, `redoKey`), not this | `roadmap_tree_attach` | `step: undo`, `band: phone/tablet/desktop`, `view: board/graph`, `place: device/account` |
| Try again on the tree picker's line for a list that could not be read, or for an address whose read failed | `roadmap_tree_attach` | `step: retry`, `read: list/paste`, `band: phone/tablet/desktop`, `view: board/graph`, `place: device/account` |
| Open a step | `roadmap_board_step_open` | `surface: document`, `column: locked/upNext/done`, `door: card/graph/activity/step/link` |
| Shared step document action; completion, reset and Undo require current owner authority. A retained Undo after demotion writes and emits nothing | `roadmap_board_step_action` | `surface: document`, `action: complete/completeFromSubtasks/reset/undo/openInGraph/viewBranch/delete/edit/editNote/select/addStep/connect/expandCoach/collapseCoach` |
| Scroll to a step section | `roadmap_board_step_action` | `surface: document`, `action: section`, `section: workspace/history` |
| Copy a step's current shareable link, once per clipboard attempt, including retries and results that arrive after the step has closed. A stale result shows no notice or recovery | `roadmap_board_step_action` | `surface: document`, `action: copyLink`, `outcome: ok/failed` |
| Recover a failed step-link copy: the card appears once, retries writing the same current link, reveals its full read-only field, selects its entire value, or is dismissed with Close or Escape. Only these bounded labels leave; no link, step id, title or exception text | `roadmap_board_step_action` | `surface: document`, `action: copyLinkRecovery`, `step: shown/retry/reveal/select/dismiss` |
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
| Planting a new roadmap failed; where the room reads the device's copy, why nothing was planted: the browser's copy could not open (`unkept`), did not open within ten seconds (`unopened`), or the domain refused the plan, as a name past 200 characters or two kinds of one hue (`refused`) | `roadmap_board_create` | `step: failed`, `door: blank/import/quest`, `reason?: unkept/unopened/refused` |
| Shared field saved in the step document | `roadmap_board_edit` | `step: saved`, `name: true/false`, `description: true/false`, `kind: true/false`, `prerequisites: true/false` |
| Shared-field editor actions and outcomes | `roadmap_step_edit` | `step: open/change/guard/keep/discard/cancel/saved/unchanged/invalid/failed/retry/conflict/load_latest/selection_updated/unavailable`, `field: label/description/color/prerequisites` |
| Retained one-field draft and read-only recovery | `roadmap_step_draft` | `step: retained/view/close/copy/copied/copy_failed/return/return_failed/adopted/unavailable/collision/signout_prompt/discard_prompt/keep/discard/select` |
| Rename, recolor, link, unlink, reconnect or reorder on the Graph | `roadmap_board_edit` | `step: saved`, `view: graph`, `name: true/false`, `description: true/false`, `kind: true/false`, `prerequisites: true/false`, `order: true/false` |
| Change a kind in the Graph's legend | `roadmap_board_edit` | `step: saved`, `view: graph`, `legend: rename/describe/add/remove/recolor` |
| Prerequisite picker | `roadmap_board_picker` | `step: open/cancel/more/revalidated`, `mode: create` |
| Picker applied | `roadmap_board_picker` | `step: apply`, `mode: create`, `count: 0/1/2-5/6-20/21+` |
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
| Attempt phone bulk Delete with every root selected; nudge the reason | `roadmap_board_bulk` | `step: delete_refused`, `reason: last_root` |
| Bulk act on the Board | `roadmap_board_bulk` | `step: recolor/delete`, `count: 0/1/2-5/6-20/21+` |
| Bulk act on the Graph | `roadmap_board_bulk` | `step: recolor/delete`, `count: 0/1/2-5/6-20/21+`, `view: graph` |
| Workspace in the shared step document | `roadmap_board_workspace` | `action: subtaskAdd/subtaskToggle/subtaskDelete/linkAdd/linkDelete/noteSave/noteDiscard/undo` |
| Workspace in the Graph's blank-step naming dock | `roadmap_board_workspace` | `action: subtaskAdd/subtaskToggle/subtaskEdit/subtaskDelete/linkAdd/linkDelete/noteSave`, `surface: dock` |
| A verb on the identity row | `roadmap_verb` | `verb: askAI/share/newStep/fork/find/next/more`, `door: row`, `view: board/graph`, `band: tablet/desktop` |
| A verb in More | `roadmap_verb` | `verb: askAI/share/activity/export/settings/shortcuts`, `door: more`, `view: board/graph`, `band: tablet/desktop` |
| A verb in the roadmap sheet | `roadmap_verb` | `verb: askAI/share/activity/export/settings`, `door: sheet`, `view: board/graph`, `band: phone` |
| A and ⌘K | `roadmap_verb` | `verb: activity/askAI`, `door: key`, `view: board/graph`, `band: tablet/desktop` |
| A row in the desktop Activity feed | `roadmap_verb` | `verb: activity`, `door: feed`, `view: graph`, `band: desktop` |
| Phone reader Board's Fork offer | `roadmap_verb` | `verb: fork`, `door: offer`, `view: board`, `band: phone` |
| Phone Graph's Fork pill | `roadmap_verb` | `verb: fork`, `door: pill`, `view: graph`, `band: phone` |
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
| Tablet Board load-error recovery switcher | `roadmap_recovery` | `step: open/close/search/expand/collapse/switch/new/browse/retry`, `place: account/device` |
| Recovery list result; no roadmap IDs, titles, query or counts | `roadmap_recovery` | `step: list`, `place: account/device`, `outcome: available/empty/failed` |
| Tablet and desktop roadmap switcher; a rename once the request succeeded | `roadmap_sheet` | `step: open/switch/new/browse/rename`, `door: switcher` |
| The person's roadmaps on the device's copy, once each visit as the list first reads | `roadmap_your_roadmaps` | `step: shown`, `count: 0/1/2-5/6-20/21+` |
| The person's roadmaps on the device's copy: a row pressed | `roadmap_your_roadmaps` | `step: open` |
| A roadmap's deletion held on the device's copy, its Undo shown on the person's roadmaps | `roadmap_deletion` | `step: held` |
| That Undo pressed: `cancelled` within the hold, `released` once the hold had ended and nothing came back | `roadmap_deletion` | `step: undo`, `outcome: cancelled/released` |
| The switcher's delete once the request succeeded, or for a tree that lives only on this device once the device let it go, and whether its confirmation said that steps in the person's other trees open the tree: `some`, or `none`, as for a row from a server that sends no `openers` or one whose device read failed. `place` is where the deleted tree lived | `roadmap_sheet` | `step: delete`, `door: switcher`, `openers: none/some`, `place: device/account` |
| The switcher's rename failed | `roadmap_sheet` | `step: rename`, `door: switcher`, `outcome: failed` |
| The switcher's delete failed, a device tree's refused among them where the device could not read its trees | `roadmap_sheet` | `step: delete`, `door: switcher`, `outcome: failed`, `place: device/account` |
| What's next opened, a card picked, or closed by toggle, outside pointer, genuine focus departure, Escape or context change | `roadmap_whats_next` | `step: open/pick/close`, `count: 0/1/2-5/6-20/21+` |
| Open the guide's note from its entry on the tree: the identity row from 744px, the owner’s Roadmap sheet on phones, or the phone reader’s row below the head, and what the entry knew of the guides above at the press: `none`, `some`, or `unread` while their read has not answered or after it failed, a 200 that is not the contract's shape among the failures | `roadmap_guide` | `step: open`, `door: row/sheet`, `view: board/graph`, `role: owner/reader`, `above: none/some/unread` |
| Start writing the guide: a click or a tap on its text, Enter, its pencil, or Add guide | `roadmap_guide` | `step: edit`, `via: click/tap/key/pencil/add` |
| Leave an unchanged Guide edit through Cancel, Close, Escape or the backdrop | `roadmap_guide` | `step: cancel` |
| Save the guide, its length in code points as a bucket | `roadmap_guide` | `step: save`, `outcome: saved/cleared/unchanged`, `length: 0/1-500/501-2000/2001-4500/4501-5000` |
| A guide save no door took, and why: `offline` when the request never arrived and the browser reports no connection; `refused` for a 4xx that trying again cannot change or text a door would not admit; `not-owner` for the owner guard before any write door; `server` for the server's failure, a 408 or 429, or a request lost while the browser reports a connection; `device` for this device's store or session | `roadmap_guide` | `step: save`, `outcome: failed`, `length: 0/1-500/501-2000/2001-4500/4501-5000`, `reason: offline/refused/not-owner/server/device` |
| Try again on the line a failed guide save left, by its button or by ⌘↩ while Try again stands: the same save runs again, and its own `save` row follows. A held key is one press, so its repeats emit nothing | `roadmap_guide` | `step: retry`, `reason: offline/server/device` |
| Each Copy draft attempt after a server or local ownership refusal, including retries: the current whole draft reached the clipboard, or copying failed. Every attempt emits once when it settles, even if editing, Load latest, leaving or a newer attempt made its UI result stale | `roadmap_guide` | `step: copy`, `outcome: copied/failed` |
| A guide save that replaced a guide changed elsewhere since its writing began | `roadmap_guide` | `step: conflict` |
| Discard a changed guide draft, by choice or because the room closed the note over it (the tree changed or the guide stopped being shown), or take the guide saved elsewhere with Load latest | `roadmap_guide` | `step: discard/loadLatest` |
| Export this roadmap | `roadmap_export` | `outcome: done/failed`, `door: more/sheet` |
| Settings' Export all: `done` where the zip holds every roadmap of the list (a list with none among them), `partial` where it holds some, `failed` where it holds none of several, and `unopened` where the device's copy did not open in time to read the list | `roadmap_export` | `outcome: done/partial/failed/unopened`, `door: settings` |
| Shortcut help | `roadmap_shortcuts_open` | `view: board/graph` |
| Fork submitted | `fork_attempt` | `mode: email/instant/browse` |
| Fork's email answered with a refusal or a failure | `fork_attempt` | `mode: email`, `outcome: invalid/rate_limited/failed` |
| Instant Fork failed | `fork_attempt` | `mode: instant`, `outcome: unauthenticated/failed` |
| Gallery Fork failed | `fork_attempt` | `mode: browse`, `outcome: unauthenticated/failed` |
| Gallery initial read and each page result, once while still wanted; no identifiers, counts, titles or cursors | `roadmap_gallery` | `step: load/page`, `outcome: available/empty/failed` |
| Gallery Show more or Try again pressed; a page retry emits only its retry press | `roadmap_gallery` | `step: more/retry`, `read: initial/page` |
| Fork landed | `fork_claim` | `mode: email/instant/browse` |
| Sync status: offline episode | `roadmap_sync_offline` | `step: shown/cleared`, `pending: 0/1/2-5/6-20/21+` |
| The server retired this build: the socket's path or a roadmap write route answered `410` `client-update-required`, once per page load, by the door that said it first | `roadmap_sync_retired` | `step: detected`, `door: socket/write` |
| The retired build's reload: `deferred` when no room was open, or the page was in view or held something open, as the build was retired; `ran` as the page reloads; `suppressed` when this tab already reloaded for it within ten minutes (tried again as the ten minutes end), cannot keep that mark, or a save did not reach a store kept on the device, and the page stays offline | `roadmap_sync_retired` | `step: reload`, `door: socket/write`, `outcome: ran/deferred/suppressed` |
| Refusal shown, retried or discarded from Board, Graph or the owner step document | `roadmap_sync_refused` | `step: shown/retry/discard`, `lane: structure/progress`, `code: tree-too-large/bad-frame/no-such-tree/server-error/other` |
| A room on the device's copy: a landing line (§6, flow 48) shown for the first time this visit, under its step's card on a Board that stands uncovered or on the step's page, once per line; the device then clears it from its note. `cameBack` where the person's edit brought the step back, `follows` where a step they made or linked now follows past a step deleted elsewhere. A later opening is quiet | `roadmap_landing` | `rule: cameBack/follows`, `place: board/step` |
| A build whose room reads the device's copy: a change of the person's that cannot land (§6), one notice of roadmap's that the one list holds or one record the carry-over set aside in its ledger (§8.2), told once per notice or record, however often the engine republishes them: once a page load, and once on this browser where it keeps storage (`localStorage` keeps the ids of the told notices the engine still holds, never their content, and sign-out clears them; a browser that refuses storage tells each again on its next page load), whether or not the list shows it yet | `roadmap_write_cannot_land` | `reason: roadmapDeleted/capFilled/accessEnded/noteTooLong/pastBound` |
| The one list of what cannot land (flow 49) opened from the account menu's Kept here, with how many changes it shows | `roadmap_kept` | `step: open`, `count: 0/1/2-5/6-20/21+` |
| A kept change's Copy: its text reached the clipboard, or the clipboard refused it or failed | `roadmap_kept` | `step: copy`, `reason: roadmapDeleted/capFilled/accessEnded/noteTooLong`, `outcome: copied/failed` |
| Select text, after a kept change's copy failed | `roadmap_kept` | `step: select`, `reason: roadmapDeleted/capFilled/accessEnded/noteTooLong` |
| A kept change discarded: asked once, and the engine dismissed its notice, or the carry-over's ledger let go of its record. One the engine or the ledger no longer holds, discarded in another tab, closes quietly and emits nothing | `roadmap_kept` | `step: discard`, `reason: roadmapDeleted/capFilled/accessEnded/noteTooLong` |
| A room on the device's copy: what an Undo or a Redo of the room's own stack came to, once the engine knows; one the server still settles is told when it has. `applied` where it changed what the device holds, `skipped` where it changed nothing, a write the device had not seen standing in its way, `unavailable` where there was nothing to take back (the gesture wrote nothing, or its Undo had nothing) or the domain refused the Undo before anything was written, a check its act named failing over what stands (a kind brought back onto a hue another kind has come to wear). No text and no id leave; the person is shown nothing of a skip or a refusal | `roadmap_undo` | `action: undo/redo`, `outcome: applied/skipped/unavailable` |
| A room on the device's copy: a write the domain refused, decided before anything was written (or, rarely, at its commit); a roadmap at its cap and a link that would close a loop are said in the words of the room with the switch off, and any other shows what that room shows for that gesture's failure. No success is shown or emitted for it: a gesture's success toast and `saved` event wait until its write has landed | `roadmap_write_refused` | `write: mark/title/guide/visibility/workspace/note/landing/CreateNode/RenameNode/DescribeNode/SetNodeColor/EditNode/SetNodeOrder/AddEdge/RemoveEdge/ReconnectEdge/DeleteNode/BulkDelete/BulkRecolor/ImportSubgraph/SetNodeTree/AddKind/RenameKind/DescribeKind/RecolorKind/RemoveKind/deleteRoadmap`, `refusal: invalid/gone/taken/tooLarge/full/roadmapGone/unreachable/notARoot/stepOpensARoadmap/depthLimit/other` |
| Undo of one of Roadmap Coach's direct writes by its receipt (`coach/toolHost.js`), told once the engine has settled it, which waits for the server where the server settles it: `undone` where it took the write back, `skipped` where a later write the person made of the same field, a change of a subtask it added, or a mark they set on the step since, stood in its way, `unavailable` where the room no longer holds the write (⌘Z took it back first). The room tells the same Undo as `roadmap_undo`. Nothing offers the Undo yet, so production emits none of it | `roadmap_coach_write_undone` | `ability: set_progress/update_node/create_node/connect`, `outcome: undone/skipped/unavailable` |
| Device line shown | `roadmap_device_line` | `step: shown`, `line: anonymous/lapsed`, `place: row/shell` |
| Device line's phone row tapped | `roadmap_device_line` | `step: sign_in`, `line: anonymous/lapsed`, `place: row` |
| The demo's roadmap opened | `demo_open` | `treeId: t_9e407a96b5330ebe` |
| WebGL2 unavailable, once per room visit | `webgl_init_fail` | `band: phone/tablet/desktop` |
| Press the unavailable Graph option | `roadmap_graph_unavailable` | `band: phone/tablet/desktop` |
| A roadmap planted from a quest. `local` where it was planted on this browser signed out: in the browser's anon replica where the room reads the device's copy, which a sign-in adds to the account, else in this device's index for a claim | `birth` | `quest: <authored quest id>`, `steps: 0/1/2-5/6-20/21+`, `local?: true` |
| A roadmap planted blank or from an import, `local` as a quest's | `birth` | `import?: true`, `steps?: 0/1/2-5/6-20/21+`, `local?: true` |
| A build whose room reads the device's copy: a run of the carry-over (§8.2), on a load, again as another replica becomes active or the active one is bound to another account, and again as the connection returns to a run that left roadmaps waiting, found what roadmap's old bundle kept in this browser, as counts: the roadmaps made signed out, the server's roadmaps holding changes it had not sent, and the roadmaps with a workspace or with marks left undrained. Emitted with each run that tells something below; a run that writes nothing, deletes nothing and leaves waiting the roadmaps the last run left (a digest of their ids in `localStorage` says which) emits nothing, so old stores that wait on the same thing are told once, not on every load. A browser whose old stores hold nothing emits nothing | `roadmap_carry` | `stage: found`, `roadmaps: 0/1/2-5/6-20/21+`, `changed: 0/1/2-5/6-20/21+`, `workspaces: 0/1/2-5/6-20/21+`, `marks: 0/1/2-5/6-20/21+` |
| What that run wrote into the replica through the domain's actions, as counts: the roadmaps it created, those of them under a fresh id, the changes, marks and workspace items it wrote, the records it set aside for the one list, and the Coach conversations it wrote again from the notice of a creation the server refused, once it placed that roadmap again | `roadmap_carry` | `stage: carried`, `roadmaps: 0/1/2-5/6-20/21+`, `moved: 0/1/2-5/6-20/21+`, `changes: 0/1/2-5/6-20/21+`, `marks: 0/1/2-5/6-20/21+`, `items: 0/1/2-5/6-20/21+`, `kept: 0/1/2-5/6-20/21+`, `conversations: 0/1/2-5/6-20/21+` |
| The roadmaps that run left in the old stores, where they are others than the last run left: waiting on the account's list or a roadmap's first pull, on the server's answer to whether an id exists, on the server taking a roadmap the carry-over created (the anon replica sends nothing, so one carried there waits until a sign-in adds it to an account), on the replica they belong to (the anon replica's while an account is signed in, an account's while another is active or nobody is), on a load after an index row found with no record, or after a write that failed. A run that its replica's change ended (a sign-in or a sign-out under it) tells no waiting: the next replica's run does | `roadmap_carry` | `stage: waiting`, `roadmaps: 0/1/2-5/6-20/21+` |
| A Discard answered on roadmap's own question, or an account's closure, took old roadmaps uncarried: a sign-in's Discard, once the sign-in completed with the work it counted gone, the old roadmaps the carry-over had carried into that work; an account's sign-out Discard, through the account's sweep, the old roadmaps that question named; each while its entries held what its question saw. For a closure, every old roadmap whose index row names the account | `roadmap_carry` | `stage: discarded`, `roadmaps: 0/1/2-5/6-20/21+` |
| The old stores' entries that run deleted once the ledger showed them carried (INV-4), and the server had taken a roadmap the carry-over created, or an index row a load before it found with no record | `roadmap_carry` | `stage: cleared`, `stores: 0/1/2-5/6-20/21+` |
| Device roadmaps claimed at sign-in, where the room reads roadmap's own sync (the switch off) | `claim` | `treeCount: 0/1/2-5/6-20/21+` |
| A build whose room reads the device's copy: the sign-in question for the browser's signed-out roadmaps where the account already holds roadmaps (flow 50.01, 50.03, or Roadmap Coach 10.4 where the work holds Coach's conversations), shown, then answered Add or Discard, or cancelled by Escape, which signs the account out and leaves the roadmaps and conversations on the browser unsent. `roadmaps` counts the browser's own roadmaps. Flow 50 names each of them, and by their changes the roadmaps of others the work changes, which its Discard takes too. 10.4 names none: it counts the browser's own roadmaps, the conversations and the changes to others' roadmaps in one sentence, and its Discard takes all of it. `conversations` counts the Coach conversations the work made that still stand; with none, the question is flow 50's. An account that holds none takes them without a question, and so does one whose signed-out work changes no roadmap of the browser's own, its conversations with it: nothing is emitted here, and the engine's `sync-signin` says the sign-in completed | `roadmap_signin` | `step: shown/add/discard/cancel`, `roadmaps: 0/1/2-5/6-20/21+`, `conversations: 0/1/2-5/6-20/21+` |
| A build whose room reads the device's copy: the sign-out question where every unsent change is roadmap's (flow 50.02, 50.04), shown, then answered Keep or Discard, or cancelled by Escape, which stays signed in. `changes` counts the unsent changes, one an act of the person's (a gesture), however many entries it commits, and the changes of the account's roadmaps waiting in the old stores (§8.2), which it names and its Discard takes; it is asked where only those wait. A sign-out with nothing unsent and nothing waiting, or with another product's work or notice, asks in the shell's words and emits nothing here | `roadmap_signout` | `step: shown/keep/discard/cancel`, `changes: 0/1/2-5/6-20/21+` |

Roadmap Coach's tool host tells nothing of a call and reports nothing of one: the platform's turn engine tells each call it
runs, through its telemetry port, as `roadmap_coach_ability` (the ability and its outcome or refusal code), and reports
whatever throws out of a call (the ability, the standing roadmap it reads, or the room's door) once, as `agent-host`,
ending the turn `failed` with `host-fault`, as it does for gym's Coach. That event is a direct write's one product event:
the room's gesture events (`roadmap_board_*`, `roadmap_graph_*`) count the person's own gestures, and a Coach write adds
to none of them, so `roadmap_board_complete`'s `door: coach` stays the demo's coach. No roadmap turn runs on the engine
yet, so production emits and reports neither.

A guide's `saved` and `cleared` mean the session or this device's store took the write: durability on this device, not the
server's admission, as a gym save's `saved-local` is. What the server then does with it is the structure lane's to say, through
the sync events and the refused card.

`demo_open` fires alongside `roadmap_view_open`. `fork_claim` with `mode: email` comes from `shell/auth/AuthLanding.jsx`, once
the magic link lands.

### When an event stays silent

A step is a thing a reader did or was told. These emit nothing:

- The column a Board opens on, or moves to because a step was selected elsewhere; a rail swapped or Done unfolded to reveal a
  selected step; a state showing.
- A C on a card that opens a tree and the toast it raises: nothing was completed. The toast's Open tree is `roadmap_tree_open`.
- A tree visit with no holder at the room (on a tree the server keeps: a lapsed session, its copy on a device with nobody
  signed in, a page that started with no connection; and a reader): no `roadmap_tree_open`, no `roadmap_tree_back` and
  no `tree` or `back` door. A step that opens the tree it stands in has no door, so nothing. A reader goes into a subtree
  and back up, so `roadmap_subtree_open` and `roadmap_subtree_back` are theirs too; an owner with no holder (a lapsed
  session, a start with no connection) has neither.
- A pointer the server refused on a step that owns a subtree (`subgraphAck.refused`, `owns-a-subtree`): the step's
  register goes back to what the server confirmed, with no event and no Sentry report, as the web never writes one.
- A step that was open on the roadmap come back to from a tree: it opens as one reached by going back, with no
  `roadmap_board_step_open`.
- A mark set aside because its step opens a tree: nothing is sent, counted or refused while the pointer stands.
- The tree picker's Cancel, its search, a row chosen, a read that failed, an address read again from what the picker
  already holds, and the Tree section's ⋯ opened or closed. A fork made from the picker is `fork_attempt` and `fork_claim`, as from any Fork. Nobody but the tree's
  holder has the +, the ⋯ or the picker, so a reader, and a lapsed session on a tree the server keeps, emit none of these;
  on a tree that lives only on this device the person at it holds it through a lapse.
- The read that follows a pointer set or changed while the roadmap is open, when it succeeds or is cut off at its
  ten-second limit: a read cut off reports nothing and leaves the step with nothing said of its tree until a reload.
- Dismissing a menu, a sheet, Fork or Ask AI; re-picking the order or the shared kind in force; a recolor the session refused;
  a clean Save, which writes nothing and emits `unchanged` from the inline field editor and the guide alone.
- Moving back to a step already open in the visit, closing a step, and system Back or a remote change dropping a note draft.
- The Prerequisites row with no candidates.
- The unavailable Graph option's reason opening on hover or focus.
- A Delete key on a selection that takes every root a roadmap has left, on either view. Activating the phone Board's
  disabled Delete button separately emits `delete_refused` when it nudges the reason.
- A rebaseline's pending records, an online discard, Saving and Saved. Refusal counts stay local.
- The camera, the minimap, the legend's highlight and folding, selecting one step, hovering and focus moves.
- Closing the guide, reading it, its counter appearing and a guide set elsewhere arriving.
- What the browser kept beside the roadmaps a sign-in's Discard took, swept once the sign-in completes: `roadmap_signin`'s
  `discard` is the step, and a storage that refuses holds nothing to sweep.
- The read of the guides above a tree: asked, answered, aborted as the room leaves the tree, or refused with a 4xx. A
  reader, a shared or demo route, a signed-out device, a tree that lives only on this device and a lapsed session make
  no such read.

`roadmap_sync_refused` `shown` fires once for the refused frame, across re-flushes, and `discard` only after the session
confirms it. Moving the notice into the step document emits no extra event; it uses the room's existing callbacks.
A pending Discard retains its notice until the callback settles, and failed replacement emits no successful discard.
A progress-lane rebaseline disables progress controls until its baseline arrives. Refused Complete, Reset and Undo
change no optimistic marks or ledger and emit no success event; a structure-only rebaseline keeps progress available.
The existing `roadmap-sync-discard` boundary reports unexpected replacement failures; readers receive no owner
recovery controls. `roadmap_sync_offline` fires once per offline episode. `roadmap_device_line` `shown` fires once per visit.
A retired build emits `roadmap_sync_retired` `detected` once per page load, then one reload outcome, or `deferred` followed by
`ran` or `suppressed`; a page suppressed by the window emits its outcome again as the window ends. A write door it no longer
sends through fails as a lost request does, with no Issue.

### Technical failures

Every operation is a static name, reported through `telemetry/sentry.js` with stack frames only: file, line, column and
function. A report's `route` is a family (`#/app`, `#/settings`), never an address.

| Operation | What failed | What the reader gets |
|---|---|---|
| `roadmap-board` | The Board's render | The Graph, focus on the switch; choosing Board tries again |
| `roadmap-identity` | The identity row's render | `ViewSwitch` at the row's position |
| `roadmap-board-step` | The shared step document's render | The step closes |
| `roadmap-board-composer` | The composer's render | The composer closes |
| `roadmap-board-create` | A create exception, its toast's Undo failing, or no session on an editable surface of a room that reads roadmap's own sync (a room on the replica has none to find) | The draft and its Retry stay; the failed Undo's toast closes |
| `roadmap-board-edit` | An edit exception, or no session on an editable surface | The draft and its Retry stay |
| `roadmap-step-draft-copy` | An unexpected clipboard exception; browser permission and security refusals emit only the failed attempt | The draft stays selectable with Select text and Try again |
| `roadmap-step-draft-return` | Navigation or matching-editor adoption failed | The retained draft stays available with Try again; nothing is saved |
| `roadmap-board-recolor` | A recolor exception, its Undo failing, or no session in a room that reads roadmap's own sync | Selection stays |
| `roadmap-board-delete` | An unexpected held-delete release | The step returns, and its toast says *Couldn't delete* with Retry |
| `roadmap-step-copy` | An unexpected clipboard exception. Browser permission and security refusals (`NotAllowedError`, `SecurityError`) emit the failed attempt without an Issue; other failures report only the static operation and sanitized stack | *Couldn’t copy link*, Try again and Show link; a failed retry keeps the card, and success uses *Link copied*. Copy and Try again stay disabled while a write is pending, including across step navigation. A newer interaction keeps its focus when failure arrives; nested modal boundaries cover the recovery. A step or link change, dismissal or unmount makes a late result silent |
| `roadmap-step-restore` | A completion's Undo: a Board or Graph toast, or the step document's inline offer | The offer leaves |
| `roadmap-graph-undo` | A Graph toast's Undo, or the Board's Undo of a pasted plan, reverting its receipt | The toast closes |
| `roadmap-tend-undo` | Undo on an Ask AI answer | The toast closes |
| `roadmap-export` | Building or downloading an export | `roadmap_export` `failed`, no file |
| `roadmap-export-load` | Settings' Export all reading a roadmap or its marks, by the rules of `roadmap-tree-load`; where it reads the device's copy, a roadmap whose read through the domain threw. A roadmap the device has not read and could not read within ten seconds, and a copy that did not open within them, are no Issue, as they are none for the room's load of the device's copy; the sync engine reports its own failures, and `roadmap_export` tells a copy that did not open as `unopened` | *Exported 1 of 2 roadmaps.*, or the export's error when none could be read or the copy did not open |
| `roadmap-tree-load` | The server answering 5xx or a 200 with no tree or one that does not say where the tree sits (`root`, `parent`, `path`, `depth`), or a request lost while visible, online and still wanted (a refused connection), on the load or on the read that follows a pointer set while the roadmap is open | The load error. On the later read: the step keeps the tree's mark with nothing said of it until a reload |
| `roadmap-opens-load` | The server could not follow the trees an owner's steps open (`503 opens-unavailable`), on the load or on the read that follows a pointer set while the roadmap is open | On the load: this device's copy of the roadmap, each such step shown as opening a tree with nothing said of it, or the load error where the device holds none. On the later read: the step keeps the tree's mark with nothing said of it until a reload |
| `roadmap-progress-load` | A server tree's marks, by the rules of `roadmap-tree-load`, or a 200 that is not JSON. Where the room reads the device's copy, a reader's read of the owner's marks (`GET /v1/trees/{id}/progress`), by the same rules, once a visit | The load error and Try again, never a false count. Where the room reads the device's copy, the reader's room opens on the steps' seeds, and the demo on its staged marks |
| `roadmap-activity-load` | A server tree's activity, by the rules of `roadmap-tree-load`, or a 200 that is not JSON; where the room reads the device's copy, once a visit, for a roadmap the server holds: a reader's, or one of the account's. A browser's own roadmap signed out, which the server never held, asks for none | The room opens with an empty feed |
| `roadmap-load` | Anything else stopping a load, except a tree its reading does not find: neither the server nor this device has it, or the replica holds none the person may read | The load error |
| `roadmap-tree-picker-load` | The tree picker's reads, tagged `read: list` (the person's roadmaps, `GET /v1/trees`) or `read: paste` (the roadmap an address names, `GET /v1/trees/{id}`) and `reason`: `server` for a 5xx, `network` for a request lost while visible and online, `shape` for a 200 that is not a list or a roadmap. Where the room reads the device's copy both reads are the copy's, an address read by a reading of its own, and `network` is a list read before the copy opened, or an address whose copy did not open or got no answer within `FIRST_COPY_MS`, while visible. At most once per read and reason for each opening of the picker, through `reportUnexpectedFailure` as the guides' read is (`shape` through `reportRoadmapFailure`). None while offline or hidden, for a 403 or another 4xx, or for a 401, which is the room's lapse (the picker tells the room as a refused write does, and the controls go with the session) | For the list, *Couldn’t load your trees* with Try again, never the empty list; for an address, *Couldn’t load this roadmap* with Try again in its place, the rest of the picker standing. No Try again after a 401 |
| `roadmap-tree-attach` | Attaching, changing or detaching a step's tree throwing before the write applied, or its toast's Undo throwing | The act: *Couldn’t change the tree. Try again.*, the step as it was and the picker open. The Undo: the toast closes |
| `roadmap-recovery-list` | Tablet Board recovery account/index list read failed; static operation and bounded `place: account/device`, `reason: auth/network/shape/server/read/index`. No IDs, bodies, titles, queries or raw error messages. Device database and corrupt-record failures already judged by `roadmap-device-opens-read` are not reported twice, nor, where the room reads the device's copy, a list it cannot read before the copy opens, which `roadmap_load` has told | The list says *Couldn’t load your roadmaps.* and keeps Retry list; no failed account list is combined with device rows. A failed eligibility read shows no device switcher |
| `roadmap-device-opens-read` | A read of the trees that live only on this device, under one tag, `name`: the browser's name for what failed (`QuotaExceededError`, `AbortError`, `UnknownError`, …), `corrupt` for a stored record that does not join, or `other`; never a message. A record that does not join reports once per read and stands unread while the rest are read. A device that cannot read its trees at all (its database will not open, or a record cannot be read) reports once per read: as a device tree's room opens or one of its pointers changes, for the tree picker's list there, for the switcher's list, or as a device tree is deleted. The picker's own `roadmap-tree-picker-load` and the switcher's `roadmap-switcher-delete` do not report it again | A corrupt record: its tree is left out of the picker, a pointer at it is unread, and it is neither counted nor taken from by a delete. A device that cannot read at all: each step that opens a tree keeps the tree's mark and Open tree with nothing said of it until a pointer changes or a reload; the picker says *Couldn’t load your trees* with Try again; the switcher's delete asks its question alone, and pressing Delete removes nothing (`roadmap_sheet` `outcome: failed`), the row standing to try again |
| `roadmap-device-cascade` | Removing a tree that lives only on this device: the write that takes the steps opening it from one of the other trees here, read, joined or saved, the tree this tab has open included, once per removal however many trees failed, under one tag, `name`, as `roadmap-device-opens-read` has it | The tree is gone and the other trees' steps with it. A tree whose write failed keeps its steps on disk, each now opening a tree that is not found and following its mark; on the tree this tab has open they vanish at once and come back after a reload, to detach or delete by hand |
| `roadmap-fork` | Fork, from a roadmap or the gallery: a server failure, or a request lost while visible and online | Fork's own error |
| `roadmap-gallery-load` | A still-wanted initial gallery read or page failed, tagged `read: initial/page` and `reason: server/network/shape`. Server failures and transport loss, including an interrupted body after successful headers, report through `reportUnexpectedFailure`; 4xx and offline or hidden transport loss do not. A fully read successful response whose JSON parse or entry projection throws reports as `shape` through `reportRoadmapFailure`. Only static labels leave; no bodies, cursors, URLs, names or raw messages | The gallery's existing error and Try again; a failed page retains its cards, count and cursor for retry |
| `roadmap-share` | Publishing or making private: a server failure, or a request lost while visible and online; on the device's copy, a write the door below reported is not reported again (`BoundaryFailure`) | The dialog's own error |
| `roadmap-replica-landing` | A room on the device's copy: reading what the device tells of the owner's own changes (§6) threw, once per visit | The room tells no landing line this visit and reads on; the device's note keeps what it holds for the next opening |
| `roadmap-replica-write` | A room on the device's copy: a write its store did not take, or an Undo, Redo or release of one that threw, its one report (the share dialog and the switcher pass such a failure on unreported), tagged `write` with what it wrote (`mark/title/guide/visibility/workspace/note/landing`, a gesture's kind such as `CreateNode` or `BulkDelete`, or `deleteRoadmap/undeleteRoadmap/undo/redo/release`). A write a sign-in or a sign-out overtook (`ReplicaChanged`, one the back/forward cache held while another tab moved the seat among them) reports nothing, here or at any roadmap door: the engine told its `sync-commit` `not-writable` | Nothing of that write is drawn: the room shows what the device holds, and a switcher's rename puts the old name back |
| `roadmap-kept` | The one list's render | The list closes; the account menu still offers it, and opening it again renders it afresh |
| `roadmap-kept-copy` | A kept change's Copy throwing anything but the browser's refusal (`NotAllowedError`, `SecurityError`) or a missing clipboard, which emit only the failed attempt; only the static operation and sanitized stack frames, never the change's words | Below 1024px *Copy failed. Select the text to copy it.* with Select text; from 1024px nothing is said yet (the board draws no such state) and the text stays selectable |
| `roadmap-kept-discard` | The engine's dismiss of a kept change's notice throwing, once a Discard; a dismiss the engine answers `false`, the notice no longer held, is no failure and closes the change quietly | The change stays in the list, back on its page with Discard; nothing is said yet (the board draws no such state) |
| `roadmap-carry-read` | A read of the carry-over that failed, tagged `store` and `name`, as `roadmap-device-opens-read` has it (`corrupt` for a record that does not join): an entry of the old bundle's stores (§8.2) it could not read (`sync`, `index` for the whole index or one row of it, `workspace` or `marks`), once on this browser per entry, a digest of the store and its roadmap kept in `localStorage` so a later load that still cannot read it reports nothing (a browser that refuses storage reports it once a page load); the server's answer to whether an id exists (`server`); or a run that stopped (`replica`). Never a message, an id or a roadmap's words | An unread entry stays where it is, neither carried nor deleted, and every later load tries it again; a roadmap whose record or index row cannot be read is left out whole, and every other row is read. A roadmap whose question failed waits for a later run. A run that stopped stops there: what it carried before stays carried, the ledger showing it, every roadmap after it waits for the next load, and no old store is deleted that the ledger does not show carried |
| `roadmap-carry-write` | A write of the carry-over that failed, tagged `stage` and `name` as above: `carry`, the act that carries one roadmap, refused by the store, or a roadmap's own creation refused; `clear`, deleting an old store's entry; `coach`, writing again, in the act that carries the roadmap, the Coach records the notice of a creation the server refused holds: refused by the domain and tagged `refusal` with its kind, throwing where the act without them does not and tagged `name`, or the notice holding Coach records of another roadmap that only it holds, tagged `refusal: otherRoadmap`; `notice`, dismissing the notice of a creation the server refused once the roadmap is carried again with the Coach records it holds; `discard`, a sign-in's Discard taking the old roadmaps carried into the work it counted, or the account's sweep taking the old roadmaps its sign-out's Discard named | `carry`: nothing of that roadmap is written, the act being all or nothing, so its old stores stay whole for the next load, which carries it again. `clear`: the entry stays, and the next load deletes it, its ledger showing it carried. `coach`: the roadmap is carried without them; the notice stays, holding the records, and no list shows it. `notice`: the refused creation stays in the engine as a notice no list shows. `discard`: the old roadmaps stay; a sign-out's wait for the account's next sign-in, and a sign-in's are carried again into the next anon replica |
| `roadmap-kept-unexpected` | A notice of roadmap's that no rule of the one list names (the domain's `unexpected`), but the refusals the carry-over settles (a creation it made, refused as taken or spent, or a refusal its ledger names), each notice once as `roadmap_write_cannot_land` tells a kept change, and at most once per code a page load, tagged `code` (`other` where the code is not one a refusal spells) | Nothing: the list does not show it, and the engine keeps it |
| `roadmap-switcher-rename` | The switcher's rename: a server failure, a request lost while visible and online, or an exception; on the device's copy, a write the door below reported is not reported again (`BoundaryFailure`) | The old name returns |
| `roadmap-switcher-delete` | The switcher's delete: a server failure, a request lost while visible and online, or an exception; on the device's copy, a write the door below reported is not reported again (`BoundaryFailure`) | The row stays |
| `roadmap-guide` | The render of the guide's entry on the tree or of its open note | A failed entry is not drawn; a failed note closes |
| `roadmap-guides-load` | The read of the guides above a tree for its holder (`GET /v1/trees/{id}/guides`), once per read, under the tag `reason`: `unavailable` (`503 guides-unavailable`), `server` (any other 5xx), `network` (a request lost while visible and online) or `shape` (a 200 that is not JSON, holds no array `guides`, or holds an entry without a tree id or a text). A room on the device's copy reads none: its guides above come with its roadmap | From 744px the entry and viewer keep parent status unknown while retaining the own guide; phones keep the own guide standing. Under `shape` the well-formed guides above still show. What a read brought is dropped when the room leaves the tree or its holder goes, so nothing read earlier stands after a failure |
| `roadmap-guide-save` | A guide save the session could not take, written to this device's store or through `PATCH /v1/trees/{id}`: a server failure, a request lost while visible and online, or an exception | The draft stays open under one line that says why, with Try again, or Copy draft for a refusal; a guide the session takes reports as any structure write does, under `roadmap-sync-*` |
| `roadmap-guide-copy` | An unexpected clipboard exception; `NotAllowedError`, `SecurityError` and unavailable clipboard support are expected and report no Issue. Only the static operation and sanitized stack frames reach Sentry, with no draft, identifiers or raw message | The draft stays open with the copy-failure line and Copy draft; stale results leave the current UI unchanged |
| `roadmap-plant` | Planting a roadmap, blank, pasted or from a quest: a server failure, a request lost while visible and online, or an exception. Where the room reads the device's copy, under the tag `reason: unopened/marks`: a copy that did not open within ten seconds, or a roadmap born whose done steps could not be marked, refused or failed after its creation committed. A browser that keeps nothing and a plan the domain refused are answers, which `roadmap_board_create` tells with its `reason`, and report nothing | The door's own error, or a device roadmap when the server can't be reached; under `marks`, the roadmap opens without the marks its plan brought |
| `roadmap-tend` | Ask AI's reads and its send: a server failure, a request lost while visible and online, or a 200 that is not JSON | Ask AI's `failed` answer; the bar reopens with its sentence unless explicitly dismissed during the run, and announces the same failure copy when opened |
| `roadmap-sync-notify` | Notifying after a local write, a server frame, an epoch change or a discard projection | The write's receipt stays |
| `roadmap-sync-persist` | Storing a local write or mark on a database that opened | The receipt stays; durability is at risk |
| `roadmap-sync-send` | Sending a local write or heartbeat, or checking its IndexedDB epoch on a database that opened | Writes stay pending; socket failures reconnect, and failed epoch checks stand the refused card |
| `roadmap-sync-progress-mark` | Each invalid progress row skipped while reading server frames, stored records or legacy residue, with only `lane: progress`; shared Sentry deduplication and rate limits apply | Valid marks remain available and sync; invalid rows stay off the wire |
| `roadmap-sync-restore` | A stored lane or record that cannot be read, once per session | That lane stays out until the server's graft fills it |
| `roadmap-sync-socket` | A socket with no inbound frame for ten seconds while online and in view, once per session | The Shell's sync status; reconnects keep trying |
| `roadmap-sync-retire` | A session that throws as the build is retired, reported by the door that said so; the other sessions are retired and the reload is still arranged | That session's room may not stand offline until it is left |
| `roadmap-sync-probe` | The plain read of the socket's path that follows a socket that never opened, failing for any reason but a lost connection or its ten-second limit. At most one read a minute for the page, none offline | The socket keeps reconnecting, and the next probe waits its minute |
| `roadmap-sync-dropped` | A write reply or heartbeat pong proves an earlier frame unanswered, once per session, tagged with the first affected `lane: structure/progress` | The write stays pending and is sent again |
| `roadmap-sync-unlandable` | The socket closed five times running with the lane's first structure frame unanswered, and that frame is heavier than 64 KiB: one the path drops the connection for, as the server does a message past its size limit. A lighter frame is never judged. Once per session, tagged `lane: structure` and the frame's `size` bucket (`under-128k`, `under-256k`, `under-1m`, `over-1m`) | The refused card of a write this browser cannot send; that frame's writes, and the other parts of the acts it carries, stay unsent until Retry, and other writes go on |
| `roadmap-sync-frame` | A server frame that cannot be parsed or joined, a subscribe answer among them whose `subtrees` holds an entry with no step or no id, or a `subtree` frame that names no step or no subtree, or a step the tree has never held; once per session | The frame is dropped; a lane frame resubscribes. A `subtree` frame's seq is taken and the subtree kept nowhere, until a subscribe answer says which steps own one |
| `roadmap-sync-discard` | An unexpected discard failure | The refusal stays |
| `roadmap-sync-refused` | An unexpected refusal, once per bounded code per session, with `code` as a tag | The refusal notice |
| `auth-session` | An unexpected account refresh failure | The session's existing path |
| `auth-session-clear` | The logout that clears the cookie of a lapsed session failed: a network error, its 10-second limit, or an answer other than 2xx; stack frames only | The seat lapses as it would have, and nothing marks the lapse cleared: the next page whose read lapses the seat tries again, unless a sign-in replaces the cookie first |
| `auth-credential-held` | Telling the engine whose credential a read of `/v1/me` found threw, its store having failed or closed underneath it (a store failure the engine reports as `sync-storage` too); once a page, stack frames only | The read goes on: the shell settles the account it read, and the engine hears the next read, 20 seconds on at most |
| `auth-seat-will-change` | A product's hook before the seat changes (`sync.seatWillChange`, before a sign-in binds the device and before a sign-out finishes) threw (`outcome: failed`, its stack frames) or outlasted its five seconds (`outcome: timeout`), tagged `product`, the route table's id. Never a record, a count or an account | The seat changes without it: the next product's hook runs, then the sign-in or the sign-out; a write the late hook makes afterwards is refused by the binding it was issued under and writes nothing (gym's one act, `not-writable`) |
| `auth-product-words` | A product's hook into an account-change question threw, tagged `question`: `adoption` (`adoptionAnswer`, the product's own answer to a sign-in question), `signin` (`signInWords`, `signInWork` or `adoptionCount`, the sign-in question's words or its count of the product's records), `signout` (`signOutWords`), `step` (the words' `onStep`, a step of the question told to the product), `begin` (`signOutBegins`, what the product does as a sign-out begins, before the engine sends what the device holds), `forget` (`signOutForgets`, the device rows the product's finished sign-out takes) or `notice` (`signOutNotice`, the product's line on what signing out discards from this tab). Stack frames only: never the product's words, a count or an account | The shell asks as it would of a product that says nothing: the person answers the sign-in question, in the shell's words with the engine's count, and the sign-out question in the next product's words or the shell's, without that product's line or its step event, so signing in and out go on |
| `billing-subscription` | The subscription read (`GET /v1/subscription`), kind `billing`, under the tag `reason`: `server` for a 5xx, `shape` for a 200 that is not a SubscriptionResponse. A request lost and a 4xx report nothing | The page reads as holding no Windmill One until the next read, at the next focus |

Expected answers are not Issues: a null receipt, a not-ready session on create or delete, a capacity or missing-tree
refusal, a refused clipboard, a browser refusing storage (one `[sync]` console warning per document, and writes still reach
the server), a socket unanswered while offline or hidden, a 4xx, a load aborted because the roadmap was left, a request lost offline or behind a hidden
page, a write a retired build no longer sends. Session expiry, including the 20-second account poll, keeps device work and reaches the lapsed line.

A render failure with no boundary of its own, an uncaught error and an unhandled rejection go through `reportError`, which
sends the labels and frames the shell's reporter above describes and no exception text.

`scripts/smoke-roadmap.mjs` sends nothing: it blocks the intake and Sentry at the network layer. Any Sentry attempt or
`client_error` beacon it blocks fails its walk.

Roadmap's one-field recovery reports unexpected clipboard failures as `roadmap-step-draft-copy` and failed
return/adoption as `roadmap-step-draft-return`, through the existing sanitized Roadmap reporter. Expected
clipboard permission refusals emit only `roadmap_step_draft` with `step: copy_failed`. Scope-invalidated or
superseded callbacks cannot expose content, change recovery state or restore focus. Draft values, field contents,
step and tree identifiers, account identifiers, URLs and raw exception messages are absent from these events.
Auth reports each throwing product session invalidator as `auth-document-data-invalidate` with a static auth
operation and no exception stack or message. One invalidator cannot stop the scope fence or the remaining cleanup callbacks.

## Device Coach libraries

The product-neutral Coach engine and AI client run gym's Coach (above). The engine's injected telemetry port emits one
turn outcome (state, seat kind, code, counts, answer byte count and duration) and each ability's bounded name and
outcome; gym's adapter names the events. `AiClient` reports defects and unreadable answers through `telemetry/sentry.js`
under static `ai-call`, and pass-door defects under `ai-pass`. Expected actionable refusals return as outcomes.
Transport loss, unvalidated HTTP error envelopes or status/code pairs, temporary pass unavailability, a missing host
record at the seat barrier, and recovery `call_unknown` are quiet. A pass-door answer whose body is no refusal it knows
is quiet too, and reads as the door not answering, never as a lost connection. A live `call_unknown` and malformed
successful protocol replies remain defects; retrying cannot erase admission evidence. Sign-in
refused while sign-out is pending does not report an auth failure. Stop during preparation or a
repeated request's headers/error body reports the stopped turn outcome without a technical failure.
Unexpected host failures report `agent-host` once per turn, with the error the host raised. A seat-barrier write failure
reports before the barrier rejects, without waiting for an in-flight provider to finish.
No telemetry includes seat keys, call IDs, credentials, prompts, questions, answers or tool results.
