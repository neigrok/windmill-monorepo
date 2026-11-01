# Backend observability

`SENTRY_DSN` enables Sentry Issues for uncaught request exceptions and handled failures reported
through `FailureReporter`. `SENTRY_ENVIRONMENT` identifies the deployment and `SENTRY_RELEASE`
identifies its build. Unexpected request exceptions carry their compiled exception type and matched
route, excluding their raw messages. Audited application `LOG_*` messages are forwarded separately as
structured Sentry Logs; a log at error level does not by itself create an Issue. Every composition
root installs a privacy-safe exception handler before forwarding. It preserves the server JSON 500
response and the standalone host's framework error response. Framework, vendor and unknown-source
log bodies become a fixed diagnostic; only a bounded filename and line number remain.

Coach history's optional `answerPreview` is response content, never a diagnostic property. Its
owner-scoped bounded read adds no mutation or product event. Unexpected projection failures use the
existing privacy-safe request exception boundary with the matched `/v1/gym/threads` route; no
question, answer, thread identity, SQL or raw database exception enters that report.

Each write boundary emits one `write {…}` completion record with static `operation`, bounded
`product` and `door`, `outcome`, numeric `duration_ms` rounded to 0.01 ms, and an internally generated
`request_id`. Exactly one successful outer door completion is INFO per request; nested successful
admissions, commands, publication, server calls and MCP transport use DEBUG. MCP write tools own the
INFO completion instead of their transport. Refusals use WARN and failures ERROR at every boundary.
`WINDMILL_LOG_LEVEL` controls emitted levels and `SENTRY_LOG_LEVEL` independently controls forwarding;
both default to INFO. Use DEBUG for inner outcomes and timings. Background runs emit a completion only
after a committed write or failure. Session refresh emits only for a matched UPDATE or failure; its
successful housekeeping completion always uses DEBUG, including authenticated read requests.
HTTP response codes, engine codes and tool outcomes are read without modifying wire objects.
Refusals without a machine code use `http_NNN` or `refused`. Expected refusals — unavailable
configuration, a busy gym engine, rate limits, invalid tool arguments and every 4xx, a retired path's
410 included — never create Issues.
AI allowance, funding, pricing and closed-checkout 503 refusals keep their bounded codes on the
matching HTTP routes. Accounting failures and unknown 503 responses remain Issues.
The access log writes one `http …` line per request at the same split: INFO for traffic, WARN for every
4xx and for a 5xx the write boundary reads as an expected refusal (`writeHttpOutcome`), ERROR for every
other 5xx.
Unexpected exceptions and unclassified 5xx create Issues grouped by static operation and compiled
exception type; the Issue's `tags.request_id` matches its completion. Nested boundaries share the
request state and report its first unexpected failure once. Admission, command and postcommit
publication are separate completions: a failed watcher leaves the committed admission successful.

`WriteRoutes` registers all HTTP handlers, automatically wrapping mutating verbs and explicitly
marking GET authentication/OAuth writes. The early advice finds declared write routes before rate
limiting. Its callback and `observedHttpCallback` carry the request state across asynchronous work.
Recoverable account closure uses `platform.DELETE.v1.me`; receipt reads use
`auth.account.closure.read`. Their completions carry only bounded outcomes. Storage failures report
under the same static operations even when the client receives `pending`; expected malformed,
account-mismatch, clock-ahead, unauthenticated and unavailable results create no Issue. Receipt
retention is counted in `platform.retention`. No account/operation id, proof, digest or deadline
enters these observations. OAuth admission races return the existing `login_required` or
`invalid_grant` refusal on their existing route completion, without an Issue.
`WriteRoutes::retire` registers the 20 retired gym write paths listed in `products/gym/routes.cpp`:
each answers 410 `client-update-required` before authentication with nothing behind it and emits one
WARN completion with outcome `client-update-required`, without an Issue, and the rate limiter skips
it (`retiredRoute`). MCP's `CompositeToolHost`, Coach's `AskTools` and roadmap's `ScopedToolHost`
dispatch by their access declarations. Sync admission instruments every intent and catalog command;
it validates labels against its sealed registry, and a product refusal code (gym's `plan-logged` and `session-finished`
on a workout plan write, `proposal-superseded` on a workout proposal out of date) completes at WARN under that
code with no Issue; the movement and the reason stay in the result detail, off the log. `Heartbeat` and `MailSweep` cover scheduled work
and mail slots. Standalone stdio MCP writes its structured logs to stderr and keeps protocol stdout
untouched. Every composition root stops its heartbeat, worker and vendor producers before draining logs and
envelopes. `ObservabilityLifetime` preserves producer dependencies, stops producers in reverse order,
then closes and joins the writer, including stdio EOF and exception exits. Sentry shutdown cancels its
timer, waits for pending envelopes and releases its HTTP client before stopping its loop.

Stdout/stderr output uses one joinable asynchronous writer and a queue of at most 1,024 records, each
at most 8,192 bytes. Request threads never write or flush the output stream. The writer uses
nonblocking `write(2)` and `poll`, without a stdio lock. This bounds pipe/socket/terminal
backpressure; a kernel filesystem stall can delay regular-file writes. A full queue or oversized record is dropped
and counted; overflow reports occur at most once every five seconds and once for a remaining count
on shutdown. Sentry receives these counts independently of the output sink. Its own log buffer is
bounded and accounts for overflow separately. Shutdown stops acceptance and allows two seconds to
drain, then joins after preserving pending records and loss counts in a private emergency file.
The file defaults to `/tmp/windmill-<pid>.emergency.log`; `WINDMILL_LOG_EMERGENCY_FILE` overrides it.
The emergency sink must be a regular file, opened without following symlinks and with mode 0600.
After producer shutdown, framework and Sentry delivery cleanup diagnostics are suppressed.
Only sanitized, preformatted records enter this file. Its `log_queue_loss` summary includes attempted,
written, recovered, dropped and unrecovered (`lost`) counts. SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE
and SIGTRAP use a signal-safe path over the committed queue slots and preopened file, then re-raise
the signal. Fatal delivery may leave a partial primary record; the emergency record carries the same
request id. Queue overflow cannot recover an unqueued record and reports its count. If the emergency
file cannot be opened, recoverable output and Sentry still receive shutdown counts; a fatal signal
cannot send a network report. Admission keeps ordered feed publication inside the scope mutex and
emits publication/digest completions after releasing the transaction and mutex.

No completion or Issue contains request/response bodies, names, journal text, training notes,
questions/answers, email addresses, cookies, tokens, raw exception messages, digest values, cursors,
replica ids or caller-supplied deduplication ids. Existing authentication/access diagnostics use
account UUIDs; new completion records use no account identifier. Access paths are matched templates
or `unmatched`. Machine-code allowlists discard arbitrary body strings. Exception messages remain
available only to existing application responses/storage where those contracts require them.

Coach's shared `ask.run` observation spans admission, model execution and conversation persistence;
`ask.stop` covers recovery and stop persistence. Each offered write ability has its own completion.
Provider/model failures use fixed diagnostics. Fuse denials are classified per invocation; prior
denials do not suppress later transport or malformed-response Issues. Usage-ledger writes have
their own `ai.usage.record` observation, including private-loop callbacks without request context. An absent vendor key leaves the Coach POST route
unmounted; its declaration coverage is still tested with injected fakes.

The `/v1/events` endpoint accepts anonymous or authenticated client batches:

```json
{
  "sessionKey": "client-session-uuid",
  "platform": "android",
  "events": [
    {
      "id": "event-uuid",
      "name": "gym_ask_outcome",
      "clientMs": 1789550000000,
      "props": {"outcome": "failed", "failure_kind": "timeout"}
    }
  ]
}
```

`platform` is optional and accepts `android`, `ios` or `web`. When present it overrides
`props.platform` for each event and becomes Amplitude's platform field. Without it, existing event
properties are preserved. The user comes exclusively from the Bearer session or session cookie.
Names must be lowercase snake case; properties must be flat JSON within 1 KB, including the
platform. Batches accept at most 50 valid events and sessions are limited to 2,000 events per day.
Clients own their event/property allowlists and must exclude user content and credentials.

An event's optional `id` uses the same bounded alphabet as `sessionKey`: 1–64 letters, digits,
hyphens or underscores. It gives Amplitude the stable insert ID `sessionKey:id`, including when a
client retries events in a different batch. An event without an `id` keeps its timestamp/name/index key.

`202 {"accepted":N}` means the accepted events reached Postgres. It does not confirm delivery to
Amplitude. `AMPLITUDE_API_KEY` enables forwarding and `AMPLITUDE_HOST` chooses the region
(`api2.amplitude.com` by default, `api.eu.amplitude.com` for EU). Transport errors, 429 and 5xx get
up to three attempts with the same payload, waiting one then two seconds between retries. A numeric
`Retry-After` overrides that wait, capped at 30 seconds; other errors are terminal. Exhausted network/5xx
failures create an Issue at `amplitude.forward`; 4xx/429 are logged refusals. Storage and dispatch exceptions
are also reported, using fixed diagnostics without event properties or API keys.

Forwarding is held in memory, has no durable outbox and stops on process exit. Postgres keeps the
accepted rows, but no automatic replay to Amplitude runs. Repeated accepted client batches can
create duplicate Postgres rows; the stable event ID deduplicates the Amplitude mirror. An unset
Amplitude key intentionally disables forwarding.

The inventory has 93 HTTP write registrations: REST platform 27, roadmap 13, gym 33 (20 of them
retired paths), journal 11, probe 2; sync 3; MCP transport 4. Excluding the two dev routes and two
standalone transport duplicates leaves 89 production HTTP operations. MCP has 37 write declarations
(roadmap 23, gym 14); compatibility aliases share their canonical operation. Coach has 29 operations
(ask 2, gym abilities 6, scoped roadmap abilities 21). The catalogs have eleven production commands
(gym 9, journal 2), plus four probe commands. Background coverage includes 23 scheduled/stage
operations plus sync publication, Amplitude forwarding and the AI usage ledger (26 background
operations). Server-origin entry points include the gym door, ServerCall metadata, session refresh,
signup fork and the erasure of an account a sign-in finds past its grace. The roadmap socket has two write frame kinds plus rate refusal.

The HTTP coverage test enumerates every source registration, rejects alternate registration APIs,
and requires the shared registrar, including handlers in headers and computed method lists; a second
case requires the registered retired paths to equal the Retire rows of gym's route ledger. MCP,
Coach and command tests enumerate the real catalogs and exercise each write through the dispatcher
or admission. Failure, refusal, asynchronous correlation, exact JSON preservation and callback
exception cases use capture sinks. Every test source is listed in `CMakeLists.txt`. Process-level
`log_lifecycle` regressions run `windmill_mcp` through 500 rejected MCP writes at EOF and SIGABRT
with unread stderr, and through shutdown with a permanently full stderr pipe.
Queue, heartbeat, session and dispatcher tests cover bounded shutdown/loss accounting, idle ticks,
actual writes, one INFO completion per request id and two-decimal duration serialization.

Client scope digest mismatches, doubts and scheduled re-pulls are local client transitions. The
server receives only a scope and cursor, so it cannot label a request as an actual client mismatch
or doubt. It logs each scope pull/reset and intent/call digest disagreement. Scope digests are
maintained transactionally; admission/pull do not perform a new full-table digest scan.

In the table, **completion** means all six fields above; **unexpected** means a correlated Issue
with static operation and compiled type, excluding expected refusals. Export/download reads are
listed separately because their only server writes are authentication refresh or lazy settlement.

| Path / boundary | Operation | Logged | Sentry Issues |
| --- | --- | --- | --- |
| Restore epoch tool (platform; tool) | `sync.epoch.rotate` | completion: `ok`, `already-applied`, argument/configuration refusal, `epoch-mismatch` or failure; no epochs | unexpected |
| `PATCH /v1/journal/nudge` (journal; rest) | `journal.PATCH.v1.journal.nudge` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/nudge/pause` (journal; rest) | `journal.POST.v1.journal.nudge.pause` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/nudge/unsubscribe` (journal; rest) | `journal.POST.v1.journal.nudge.unsubscribe` | completion; bounded refusal or result | unexpected |
| `POST /v1/admin/journal/nudge/sweep` (journal; rest) | `journal.POST.v1.admin.journal.nudge.sweep` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/echoes/{triggerDay}/offer/dismiss` (journal; rest) | `journal.POST.v1.journal.echoes.triggerday.offer.dismiss` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/echoes/{triggerDay}/dismiss` (journal; rest) | `journal.POST.v1.journal.echoes.triggerday.dismiss` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/dismiss` (journal; rest) | `journal.POST.v1.journal.echoes.triggerday.matchday.dismiss` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/useful` (journal; rest) | `journal.POST.v1.journal.echoes.triggerday.matchday.useful` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/echoes/{triggerDay}/{matchDay}/opened` (journal; rest) | `journal.POST.v1.journal.echoes.triggerday.matchday.opened` | completion; bounded refusal or result | unexpected |
| `POST /v1/admin/journal/echo/sweep` (journal; rest) | `journal.POST.v1.admin.journal.echo.sweep` | completion; bounded refusal or result | unexpected |
| `POST /v1/journal/transcribe` (journal; rest) | `journal.POST.v1.journal.transcribe` | completion; bounded refusal or result | unexpected |
| `POST /v1/trees` (roadmap; rest) | `roadmap.POST.v1.trees` | completion; bounded refusal or result | unexpected |
| `PATCH /v1/trees/{id}` (roadmap; rest) | `roadmap.PATCH.v1.trees.id` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/trees/{id}` (roadmap; rest) | `roadmap.DELETE.v1.trees.id` | completion; bounded refusal or result | unexpected |
| `PUT /v1/trees/{id}` (roadmap; rest) | `roadmap.PUT.v1.trees.id` | completion; bounded refusal or result | unexpected |
| `POST /v1/trees/{id}/fork` (roadmap; rest) | `roadmap.POST.v1.trees.id.fork` | completion; bounded refusal or result | unexpected |
| `PUT /v1/trees/{id}/og-image` (roadmap; rest) | `roadmap.PUT.v1.trees.id.og.image` | completion; bounded refusal or result | unexpected |
| `PUT /v1/trees/{id}/og-video` (roadmap; rest) | `roadmap.PUT.v1.trees.id.og.video` | completion; bounded refusal or result | unexpected |
| `POST /v1/trees/{id}/tend` (roadmap; rest) | `roadmap.POST.v1.trees.id.tend` | completion; bounded refusal or result | unexpected |
| `PATCH /v1/reminders` (roadmap; rest) | `roadmap.PATCH.v1.reminders` | completion; bounded refusal or result | unexpected |
| `POST /v1/reminders/pause` (roadmap; rest) | `roadmap.POST.v1.reminders.pause` | completion; bounded refusal or result | unexpected |
| `POST /v1/reminders/unsubscribe` (roadmap; rest) | `roadmap.POST.v1.reminders.unsubscribe` | completion; bounded refusal or result | unexpected |
| `POST /v1/admin/reminders/sweep` (roadmap; rest) | `roadmap.POST.v1.admin.reminders.sweep` | completion; bounded refusal or result | unexpected |
| `POST /v1/compose` (roadmap; rest) | `roadmap.POST.v1.compose` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/exercises` (gym; rest; retired) | `gym.POST.v1.gym.exercises` | completion; `client-update-required` | none: expected refusal |
| `PATCH /v1/gym/exercises/{id}` (gym; rest; retired) | `gym.PATCH.v1.gym.exercises.id` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/sessions` (gym; rest; retired) | `gym.POST.v1.gym.sessions` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/sessions/import` (gym; rest) | `gym.POST.v1.gym.sessions.import` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/sessions/{id}/sets` (gym; rest; retired) | `gym.POST.v1.gym.sessions.id.sets` | completion; `client-update-required` | none: expected refusal |
| `PATCH /v1/gym/sessions/{id}/sets/{setId}` (gym; rest; retired) | `gym.PATCH.v1.gym.sessions.id.sets.setid` | completion; `client-update-required` | none: expected refusal |
| `DELETE /v1/gym/sessions/{id}/sets/{setId}` (gym; rest; retired) | `gym.DELETE.v1.gym.sessions.id.sets.setid` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/sessions/{id}/finish` (gym; rest; retired) | `gym.POST.v1.gym.sessions.id.finish` | completion; `client-update-required` | none: expected refusal |
| `DELETE /v1/gym/sessions/{id}` (gym; rest; retired) | `gym.DELETE.v1.gym.sessions.id` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/routines` (gym; rest; retired) | `gym.POST.v1.gym.routines` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/routines/{id}` (gym; rest; retired) | `gym.PUT.v1.gym.routines.id` | completion; `client-update-required` | none: expected refusal |
| `DELETE /v1/gym/routines/{id}` (gym; rest; retired) | `gym.DELETE.v1.gym.routines.id` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/proposals/{id}/apply` (gym; rest; retired) | `gym.POST.v1.gym.proposals.id.apply` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/proposals/{id}/dismiss` (gym; rest; retired) | `gym.POST.v1.gym.proposals.id.dismiss` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/preferences` (gym; rest; retired) | `gym.PUT.v1.gym.preferences` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/notes` (gym; rest; retired) | `gym.PUT.v1.gym.notes` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/notes/{id}` (gym; rest; retired) | `gym.PUT.v1.gym.notes.id` | completion; `client-update-required` | none: expected refusal |
| `DELETE /v1/gym/notes/{id}` (gym; rest; retired) | `gym.DELETE.v1.gym.notes.id` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/bodyweight/{dateLocal}` (gym; rest; retired) | `gym.PUT.v1.gym.bodyweight.datelocal` | completion; `client-update-required` | none: expected refusal |
| `DELETE /v1/gym/bodyweight/{dateLocal}` (gym; rest; retired) | `gym.DELETE.v1.gym.bodyweight.datelocal` | completion; `client-update-required` | none: expected refusal |
| `PUT /v1/gym/threads/{thread}/attachments/{id}` (gym; rest) | `gym.PUT.v1.gym.threads.thread.attachments.id` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/threads/{thread}/generations/{request}/stop` (gym; rest) | `gym.POST.v1.gym.threads.thread.generations.request.stop` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/gym/threads/{id}` (gym; rest) | `gym.DELETE.v1.gym.threads.id` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/sessions/{id}/share` (gym; rest) | `gym.POST.v1.gym.sessions.id.share` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/gym/sessions/{id}/share` (gym; rest) | `gym.DELETE.v1.gym.sessions.id.share` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/sessions/{id}/corrections` (gym; rest; retired) | `gym.POST.v1.gym.sessions.id.corrections` | completion; `client-update-required` | none: expected refusal |
| `POST /v1/gym/log-shares` (gym; rest) | `gym.POST.v1.gym.log.shares` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/gym/log-shares/{id}` (gym; rest) | `gym.DELETE.v1.gym.log.shares.id` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/ask` (gym; rest) | `gym.POST.v1.gym.ask` | completion; bounded refusal or result | unexpected |
| `POST /v1/gym/coach/turns` (gym; rest) | `gym.coach.turn.open` | completion; bounded refusal before the stream (`coach-*`, `anonymous_ai_unavailable` and every allowance code log as the code), or the stream | unexpected; `coach-vendor-error` and `ai_accounting_unavailable` are failures |
| `POST /v1/gym/coach/turns/{turnId}/results` (gym; rest) | `gym.coach.turn.results` | completion; bounded refusal (`coach-bad-request`, `coach-turn-unknown`, `coach-turn-order`) or result | unexpected |
| `POST /v1/gym/coach/turns/{turnId}/stop` (gym; rest) | `gym.coach.turn.stop` | completion; bounded refusal or result | unexpected |
| `POST /v1/dev/sign-in` (probe; rest) | `probe.POST.v1.dev.sign.in` | completion; bounded refusal or result | unexpected |
| `POST /v1/dev/sync/epoch` (probe; rest) | `probe.POST.v1.dev.sync.epoch` | completion; bounded refusal or result | unexpected |
| `POST /mcp (MCP_PATH)` (platform; mcp) | `mcp.transport` | completion; bounded refusal or result | unexpected |
| `DELETE /mcp (MCP_PATH)` (platform; mcp) | `mcp.session.delete` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/magic-link` (platform; rest) | `platform.POST.v1.auth.magic.link` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/verify` (platform; rest) | `platform.POST.v1.auth.verify` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/verify-code` (platform; rest) | `platform.POST.v1.auth.verify.code` | completion; bounded refusal or result | unexpected |
| `POST /v1/paddle/webhook` (platform; rest) | `platform.POST.v1.paddle.webhook` | completion; bounded refusal or result | unexpected |
| `POST /v1/billing/checkout` (platform; rest) | `platform.POST.v1.billing.checkout` | completion; bounded refusal or result | unexpected |
| `GET /v1/auth/google/start` (platform; rest) | `auth.google.start` | completion; bounded refusal or result | unexpected |
| `GET /v1/auth/google/callback` (platform; rest) | `auth.google.callback` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/apple` (platform; rest) | `platform.POST.v1.auth.apple` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/apple/create` (platform; rest) | `platform.POST.v1.auth.apple.create` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/me/sign-in-methods/apple` (platform; rest) | `platform.DELETE.v1.me.sign.in.methods.apple` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/apple/native` (platform; rest) | `platform.POST.v1.auth.apple.native` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/link` (platform; rest) | `platform.POST.v1.auth.link` | completion; bounded refusal or result | unexpected |
| `POST /v1/auth/logout` (platform; rest) | `platform.POST.v1.auth.logout` | completion; bounded refusal or result | unexpected |
| `PATCH /v1/me` (platform; rest) | `platform.PATCH.v1.me` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/me` (platform; rest) | `platform.DELETE.v1.me` | completion; bounded refusal or result | unexpected |
| `POST /v1/account-deletion/result` (platform; rest) | `auth.account.closure.read` | completion; bounded receipt availability only | unexpected |
| `DELETE /v1/sessions` (platform; rest) | `platform.DELETE.v1.sessions` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/sessions/{id}` (platform; rest) | `platform.DELETE.v1.sessions.id` | completion; bounded refusal or result | unexpected |
| `POST /v1/mcp-keys` (platform; rest) | `platform.POST.v1.mcp.keys` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/mcp-keys/{id}` (platform; rest) | `platform.DELETE.v1.mcp.keys.id` | completion; bounded refusal or result | unexpected |
| `POST /oauth/register` (platform; rest) | `platform.POST.oauth.register` | completion; bounded refusal or result | unexpected |
| `GET /oauth/authorize` (platform; rest) | `oauth.authorize` | completion; bounded refusal or result | unexpected |
| `POST /oauth/token` (platform; rest) | `platform.POST.oauth.token` | completion; bounded refusal or result | unexpected |
| `POST /v1/oauth/decision` (platform; rest) | `platform.POST.v1.oauth.decision` | completion; bounded refusal or result | unexpected |
| `DELETE /v1/oauth/grants/{clientId}` (platform; rest) | `platform.DELETE.v1.oauth.grants.clientid` | completion; bounded refusal or result | unexpected |
| `POST /v1/events` (platform; rest) | `platform.POST.v1.events` | completion; bounded refusal or result | unexpected |
| `POST /v1/feedback` (platform; rest) | `platform.POST.v1.feedback` | completion; bounded refusal or result | unexpected |
| `POST /mcp (MCP_PATH)` (platform; mcp) | `mcp.transport` | completion; bounded refusal or result | unexpected |
| `DELETE /mcp (MCP_PATH)` (platform; mcp) | `mcp.session.delete` | completion; bounded refusal or result | unexpected |
| `POST /v1/resend/webhook` (platform; rest) | `platform.POST.v1.resend.webhook` | completion; bounded refusal or result | unexpected |
| `GET /v1/sync/hello` (platform; sync) | `sync.hello` | completion; bounded refusal or result | unexpected |
| `POST /v1/sync/push` (platform; sync) | `sync.push` | completion; bounded refusal or result | unexpected |
| `POST /v1/sync/pull` (platform; sync) | `sync.pull` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_create_tree` (and unambiguous `create_tree` alias) | `mcp.roadmap_create_tree` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_delete_tree` (and unambiguous `delete_tree` alias) | `mcp.roadmap_delete_tree` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_create_node` (and unambiguous `create_node` alias) | `mcp.roadmap_create_node` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_annotate_node` (and unambiguous `annotate_node` alias) | `mcp.roadmap_annotate_node` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_rename_node` (and unambiguous `rename_node` alias) | `mcp.roadmap_rename_node` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_set_node_color` (and unambiguous `set_node_color` alias) | `mcp.roadmap_set_node_color` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_move_node` (and unambiguous `move_node` alias) | `mcp.roadmap_move_node` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_connect` (and unambiguous `connect` alias) | `mcp.roadmap_connect` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_disconnect` (and unambiguous `disconnect` alias) | `mcp.roadmap_disconnect` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_reconnect` (and unambiguous `reconnect` alias) | `mcp.roadmap_reconnect` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_delete_node` (and unambiguous `delete_node` alias) | `mcp.roadmap_delete_node` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_tidy` (and unambiguous `tidy` alias) | `mcp.roadmap_tidy` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_add_kind` (and unambiguous `add_kind` alias) | `mcp.roadmap_add_kind` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_rename_kind` (and unambiguous `rename_kind` alias) | `mcp.roadmap_rename_kind` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_describe_kind` (and unambiguous `describe_kind` alias) | `mcp.roadmap_describe_kind` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_remove_kind` (and unambiguous `remove_kind` alias) | `mcp.roadmap_remove_kind` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_reorder_kinds` (and unambiguous `reorder_kinds` alias) | `mcp.roadmap_reorder_kinds` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_recolor_kind` (and unambiguous `recolor_kind` alias) | `mcp.roadmap_recolor_kind` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_set_progress` (and unambiguous `set_progress` alias) | `mcp.roadmap_set_progress` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_import_subgraph` (and unambiguous `import_subgraph` alias) | `mcp.roadmap_import_subgraph` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_prune` (and unambiguous `prune` alias) | `mcp.roadmap_prune` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_patch_nodes` (and unambiguous `patch_nodes` alias) | `mcp.roadmap_patch_nodes` | completion; bounded refusal or result | unexpected |
| `MCP roadmap_change_edges` (and unambiguous `change_edges` alias) | `mcp.roadmap_change_edges` | completion; bounded refusal or result | unexpected |
| `MCP gym_save_note` (and unambiguous `save_note` alias) | `mcp.gym_save_note` | completion; bounded refusal or result | unexpected |
| `MCP gym_start_session` (and unambiguous `start_session` alias) | `mcp.gym_start_session` | completion; bounded refusal or result | unexpected |
| `MCP gym_log_set` (and unambiguous `log_set` alias) | `mcp.gym_log_set` | completion; bounded refusal or result | unexpected |
| `MCP gym_finish_session` (and unambiguous `finish_session` alias) | `mcp.gym_finish_session` | completion; bounded refusal or result | unexpected |
| `MCP gym_create_routine` (and unambiguous `create_routine` alias) | `mcp.gym_create_routine` | completion; bounded refusal or result | unexpected |
| `MCP gym_propose_routine_change` (and unambiguous `propose_routine_change` alias) | `mcp.gym_propose_routine_change` | completion; bounded refusal or result | unexpected |
| `MCP gym_update_exercise` (and unambiguous `update_exercise` alias) | `mcp.gym_update_exercise` | completion; bounded refusal or result | unexpected |
| `MCP gym_create_exercise` (and unambiguous `create_exercise` alias) | `mcp.gym_create_exercise` | completion; bounded refusal or result | unexpected |
| `MCP gym_share_session` (and unambiguous `share_session` alias) | `mcp.gym_share_session` | completion; bounded refusal or result | unexpected |
| `MCP gym_discard_session` (and unambiguous `discard_session` alias) | `mcp.gym_discard_session` | completion; bounded refusal or result | unexpected |
| `MCP gym_propose_routine_removal` (and unambiguous `propose_routine_removal` alias) | `mcp.gym_propose_routine_removal` | completion; bounded refusal or result | unexpected |
| `MCP gym_revoke_share` (and unambiguous `revoke_share` alias) | `mcp.gym_revoke_share` | completion; bounded refusal or result | unexpected |
| `MCP gym_log_sets` (and unambiguous `log_sets` alias) | `mcp.gym_log_sets` | completion; bounded refusal or result | unexpected |
| `MCP gym_import_session` (and unambiguous `import_session` alias) | `mcp.gym_import_session` | completion; bounded refusal or result | unexpected |
| `gym` registry command `gym.start` | `sync.command.gym.start` | completion; command result | unexpected |
| `gym` registry command `gym.importSession` | `sync.command.gym.importSession` | completion; command result | unexpected |
| `gym` registry command `gym.correctSession` | `sync.command.gym.correctSession` | completion; command result | unexpected |
| `gym` registry command `gym.finish` | `sync.command.gym.finish` | completion; command result | unexpected |
| `gym` registry command `gym.applyProposal` | `sync.command.gym.applyProposal` | completion; command result | unexpected |
| `gym` registry command `gym.dismissProposal` | `sync.command.gym.dismissProposal` | completion; command result | unexpected |
| `gym` registry command `gym.applyWorkoutProposal` | `sync.command.gym.applyWorkoutProposal` | completion; command result, `proposal-settled` or `proposal-superseded` | unexpected |
| `gym` registry command `gym.dismissWorkoutProposal` | `sync.command.gym.dismissWorkoutProposal` | completion; command result, `proposal-settled` or `proposal-superseded` | unexpected |
| `gym` registry command `gym.closeStale` | `sync.command.gym.closeStale` | completion; command result | unexpected |
| `journal` registry command `journal.savePage` | `sync.command.journal.savePage` | completion; command result | unexpected |
| `journal` registry command `journal.claimPage` | `sync.command.journal.claimPage` | completion; command result | unexpected |
| `probe` registry command `probe.start` | `sync.command.probe.start` | completion; command result | unexpected |
| `probe` registry command `probe.end` | `sync.command.probe.end` | completion; command result | unexpected |
| `probe` registry command `probe.copy` | `sync.command.probe.copy` | completion; command result | unexpected |
| `probe` registry command `probe.tick` | `sync.command.probe.tick` | completion; command result | unexpected |
| `Admission::admit` / `admitBuilt` (replica and server-origin intents; gym 13 types, journal 2 types, probe 10 types) | `sync.admit` | completion; bounded refusal or result | unexpected |
| `Admission::commitAndPublish` committed change publication | `sync.publish` | completion; bounded refusal or result | unexpected |
| `GymDoor::execute` (engine writes from MCP, Coach, `POST /v1/gym/sessions/import`, Coach conversation deletion and the lazy close of a stale workout; `proposeWorkout`, which only the ability corpus calls, included) | `gym.server_call` | completion; actual call result, expected training refusal, and `proposeWorkout`'s refusal before admitting (`unknown-record`, `no-plan`, `id-reused`, `no-change`, `id-taken`) | unexpected |
| `ServerCall::admit` / `admitBuilt` invalid dedupe id | `sync.server_call.admit` | completion; bounded refusal or result | log only |
| `ServerCall::finish` dedupe metadata write | `sync.server_call.finish` | completion; bounded refusal or result | unexpected |
| `Admission::storedAnswer` / `callAnswer` call digest disagreement | `sync.call.digest` | completion; expected digest conflict | log only |
| `ReplicaPush::storedAnswer` replay intent digest disagreement | `sync.intent.digest` | completion; expected digest conflict | log only |
| `ScopePull::page` each requested scope including reset/re-pull | `sync.scope.pull` | completion; scope result/reset | unexpected |
| `SyncApi::onWorker` async exception boundary | route operation `sync.hello`, `sync.push`, `sync.pull` | completion; bounded refusal or result | unexpected |
| `products/gym/application/AskService.cpp ask admission + generation/thread persistence` (coach) | `ask.run` | completion; bounded stage outcome | unexpected |
| `products/gym/application/AskService.cpp stop` (coach) | `ask.stop` | completion; bounded stage outcome | unexpected |
| `products/gym/application/AskService.cpp AskTools dispatcher + recovery` (coach) | `gym.create_routine` | completion; draft prepared, catalog or slot refusal, `refused` when the asking client does not review drafts | unexpected |
| `products/gym/adapters/http/ThreadsApi.cpp confirmRoutine` | `gym.coach.routine.confirm` | completion; `ok` (saved, or already saved by an earlier or overlapping confirmation), `http_400`, `http_401`, `coach-draft-not-found` (404), `ask-generation-active` or `routine-save-in-progress` (409), `coach-draft-invalid` (422), `gym-engine-busy` or `gym-engine-unavailable` (503) | unexpected |
| `products/gym/application/AskService.cpp AskTools dispatcher + recovery` (coach) | `gym.update_exercise` | completion; bounded validation or unknown exercise refusal | unexpected |
| `products/gym/application/AskService.cpp AskTools dispatcher + recovery` (coach) | `gym.save_note` | completion; bounded stage outcome | unexpected |
| `products/gym/application/AskService.cpp AskTools dispatcher + recovery` (coach) | `gym.propose_routine_change` | completion; bounded stage outcome | unexpected |
| `products/gym/application/AskService.cpp AskTools dispatcher + recovery` (coach) | `gym.propose_routine_removal` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.create_node` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.annotate_node` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.rename_node` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.set_node_color` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.move_node` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.connect` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.disconnect` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.reconnect` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.delete_node` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.tidy` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.add_kind` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.rename_kind` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.describe_kind` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.remove_kind` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.reorder_kinds` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.recolor_kind` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.set_progress` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.import_subgraph` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.prune` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.patch_nodes` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ScopedToolHost.cpp dispatcher` (coach) | `roadmap.change_edges` | completion; bounded stage outcome | unexpected |
| `platform/application/RetentionSweep.h via platform/application/Heartbeat.h` (background) | `background.retention` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/ReminderSweep.cpp via platform/application/Heartbeat.h` (background) | `background.reminder` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/RoomRegistry.cpp via platform/application/Heartbeat.h` (background) | `background.rooms` | completion; bounded stage outcome | unexpected |
| `products/journal/application/NudgeSweep.cpp via platform/application/Heartbeat.h` (background) | `background.journal-nudge` | completion; bounded stage outcome | unexpected |
| `products/journal/application/EchoSweep.cpp via platform/application/Heartbeat.h` (background) | `background.journal-echo` | completion; bounded stage outcome | unexpected |
| `products/journal/application/EchoDerivations.cpp via platform/application/Heartbeat.h` (background) | `background.journal-echo-live` | completion; bounded stage outcome | unexpected |
| `products/roadmap/adapters/ws/Collab.cpp via platform/application/Heartbeat.h` (background) | `background.ws-readers` | completion only for actual writes or failure | unexpected |
| `platform/adapters/ws/SyncSocket.cpp via platform/application/Heartbeat.h` (background) | `background.sync-live` | completion only for actual writes or failure | unexpected |
| `products/journal/application/EchoExplain.cpp via platform/application/Heartbeat.h` (background) | `background.journal-echo-explain` | completion; bounded stage outcome | unexpected |
| `platform/application/RetentionSweep.h` (background) | `platform.retention` | completion; bounded stage outcome | unexpected |
| `platform/application/ClosedAccountSweep.h via platform/application/Heartbeat.h` (background) | `background.closed-accounts` | completion only for an erased account or failure | unexpected |
| `AuthService::eraseFinalCloses` via `ClosedAccountSweep` (background) | `auth.account.erase` | DEBUG completion per erased account, door `background`, nested in `background.closed-accounts`; one INFO `auth: closed account erased` line per account with the door, the erased account's id and the shared `request_id`; a failed account is an ERROR completion and the pass goes on to the next | unexpected |
| `platform/application/MailSweep.h + ReminderSweep.cpp` (background) | `roadmap.reminder.sweep` | completion; bounded stage outcome | unexpected |
| `platform/application/MailSweep.h + ReminderSweep.cpp` (background) | `roadmap.reminder.sweep.slot` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/RoomRegistry.cpp land` (background) | `roadmap.oplog.flush` | completion; bounded stage outcome | unexpected |
| `products/roadmap/application/TendingService.cpp execute` (background) | `roadmap.tend.run` | completion; bounded stage outcome | unexpected |
| `platform/infra/main.cpp startup orphaned tending runs` (background) | `roadmap.tend.reap` | completion only for reaped runs or failure | unexpected |
| `products/roadmap/adapters/llm/AnthropicAgent.cpp` (background) | `roadmap.tend.model` | completion; bounded stage outcome | unexpected |
| `platform/application/MailSweep.h + NudgeSweep.cpp` (background) | `journal.nudge.sweep` | completion; bounded stage outcome | unexpected |
| `platform/application/MailSweep.h + NudgeSweep.cpp` (background) | `journal.nudge.sweep.slot` | completion; bounded stage outcome | unexpected |
| `products/journal/application/EchoSweep.cpp run` (background) | `journal.echo.sweep` | completion; bounded stage outcome | unexpected |
| `products/journal/application/EchoSweep.cpp settlePage` (background) | `journal.echo.derive` | completion; bounded stage outcome | unexpected |
| `products/journal/application/EchoSweep.cpp derivePage` (background) | `journal.echo.derive_page` | completion; bounded stage outcome | unexpected |
| `products/roadmap/adapters/llm/AnthropicComposer.cpp` (rest) | `roadmap.compose.buffered` | completion; bounded stage outcome | unexpected |
| `products/roadmap/adapters/llm/AnthropicComposer.cpp` (rest) | `roadmap.compose.stream` | completion; bounded stage outcome | unexpected |
| `AuthService::revalidate` (REST/MCP/WS reads and writes) | `auth.session.refresh` | DEBUG completion only for actual session UPDATE; ERROR on failure | unexpected |
| Sign-in (link, code, Google, Apple, account link) meeting a close past its grace | `auth.account.erase` | DEBUG completion, door `server-origin`, nested in the sign-in route's INFO completion, before the new account is made; one INFO `auth: closed account erased` line with the door, the erased account's id and the route's `request_id` | unexpected |
| `ForkSignup::plant` | `roadmap.signup.fork` | completion; `ok`, `source-missing-or-id-taken`, `failed` | unexpected |
| `AmplitudeClient::forward` | `amplitude.forward` | completion after all retries; `ok`, `http_NNN`, `rate_limited`, `failed` | unexpected transport/5xx |
| `Collab::onMessage` subgraph/progress | `roadmap.ws.subgraph`, `roadmap.ws.progress` | completion; exact reject/skew outcome | unexpected |
| `Collab::onMessage` rate gate | `roadmap.ws.frame` | completion; `rate_limited` | log only |
| `GET /v1/journal/export`, `GET /v1/gym/history`, session/share/download reads | `auth.session.refresh` or `gym.server_call` | authentication refresh; actual lazy settlement where applicable; no export body | unexpected write failure |
| `PgAiUsageRepository::record` (noexcept ledger persistence, including transcription callback) | `ai.usage.record` | completion; `ok` or `failed`; no spend fields | unexpected compiled storage exception |
| `AiBudgetService` reservation lifecycle | `ai.budget.reserve`, `ai.budget.dispatch`, `ai.budget.uncertain`, `ai.budget.settle`, `ai.budget.release`, `ai.budget.reconcile_overrun` | one completion per transition; bounded outcome and duration; no subject, USD amount or content | unexpected storage failure; unfunded overrun under `ai.budget.settle` |
| `AiBudgetService` funding and device binding | `ai.budget.fund`, `ai.budget.bind_device` | funded/idempotent/conflict outcomes; no payment/account/device identifiers | unexpected storage failure |
| `AiBudgetService::view` | `ai.budget.view` | completion when trusted owner access creates a grant; successful pure reads omit write logs | unexpected read or grant failure |
| Durable alert worker | `ai.budget.alert.claim`, `ai.budget.alert.delivered`, `ai.budget.alert.retry`, `ai.budget.alert_send` | claim/delivery/retry outcome; no recipient, identifiers or amounts in telemetry | unexpected outbox or delivery failure |
| `AiCallBudget` | `ai.call.admit`, `ai.call.account`; `ai_output_admission` diagnostic | admission refusal or settlement/uncertainty; diagnostic carries only input nanos, output-token nanos, minimum/maximum/selected tokens and static code; no prompt, image, account or provider body | unexpected boundary failure, shared request deduplication |
| `POST /v1/ai/installations` | `ai.installation.issue` | bounded issue or rate-limit outcome | unexpected storage/credential failures |
| `GET /v1/ai/installations/current` | `ai.installation.read` | HTTP status; no credential, balance or identifier | unexpected read failures |
| `POST /v1/ai/installations/bind` | `ai.installation.bind`, `ai.budget.bind_device` | bounded success, replay or binding conflict | unexpected binding/accounting failures |
| Anonymous generation network admission | `ai.installation.admit` | bounded success, replay, disabled, rate limit or bound refusal | unexpected counter failures |
| Expired network-key sweep | `ai.installation.prune` | committed deletion only | unexpected retention failures |
| `POST /v1/gym/coach/onboarding` | `gym.coach.onboarding.start` | acceptance, replay or bounded refusal | unexpected request/storage failures |
| Anonymous Coach worker | `gym.coach.onboarding.generate` | `completed`, `message_clipped` (a completed reply over 4,000 bytes, kept clipped) or bounded failure outcome | unexpected generation/storage failures |
| Anonymous Coach model boundary | `gym.coach.onboarding.model` | expected refusal and provider rate limits are log-only outcomes | transport, truncation or invalid result failures |
| Anonymous Coach fallback persistence | `gym.coach.onboarding.persist` | bounded terminal persistence failure | unexpected fallback write failures |
| `GET /v1/gym/coach/onboarding/{requestId}` | `gym.coach.onboarding.read` | HTTP status; no routine or credential data | unexpected result read failures |
| Phone Coach turn (`products/gym/coach/TurnService.cpp run`) | `coach_turn` structured line | one line per turn: turn id, seat kind (`anon`/`bound`), terminal state, truncation, code (`coach-busy` when no vendor slot came free within CALL_RESULT_TIMEOUT), model calls, batches, ability calls by name, the gate's refusals by code, the phone's refusals (`phone_refusals`: calls it answered `ok: false`) by code, each code a lowercase slug or `other`, question and answer byte counts, duration; never the question, history, context, results, pictures, token or credential | `coach_turn.open` (allowance read unavailable at admission), `coach_turn.loop` (a model loop that failed outside an expected refusal, or threw) |
| Phone Coach batch (`products/gym/coach/PhoneToolHost.cpp callTools`) | `coach_batch` structured line | one line per batch sent: turn id, batch number, seat kind, calls sent, server-run calls, calls the gate refused, calls the phone answered `ok: false` (`phone_refused`), outcome (`answered`; `refused` when the phone refused every call it was sent; `timeout`, `stopped`), duration; a batch refused by a Stop that landed first is never sent and writes no line | none: a silent phone ends the turn `interrupted`, an expected outcome |
| Phone Coach vendor round (`platform/adapters/llm/AiCallBudget.cpp finish`) | `ai.call.account` | `settled` (actual usage), `unconsumed` (a vendor error before `message_start`: zero usage, the slot opens), `uncertain` (an ambiguous send: the hold stays) | an accounting transition the ledger refused |
| Phone Coach model round | `ai.call.admit`, `ai.call.account` under operation `turn` | the shared admission and settlement rows; a refused round ends the turn with the refusal's code as an `error` frame | unexpected boundary failures, as for every round |
| Anonymous Coach result expiry | `background.gym-coach-onboarding-retention` | committed expiry writes only | unexpected retention failures |
| `GET /v1/ai/allowance` | `ai.allowance.read` | HTTP status via access log; no balance in telemetry | static failure detail on unavailable accounting |
| Coach JSON/SSE allowance refusal | `ask.run` | bounded `subject_exhausted`, `free_day_exhausted`, `free_month_exhausted`, `concurrency_exhausted`, `funding_required` or `debt_outstanding` | expected refusals create no Issue |

Standalone MCP accepts unprefixed tool aliases; completions use canonical operations
(for example `mcp.roadmap_create_tree`). Process construction/teardown exceptions use `server.lifecycle`,
`mcp.stdio.lifecycle`, `mcp.http.lifecycle` or `process.shutdown` with the same privacy rules.

USD allowance mode adds backend admission, funding, permanent installation binding and owner-email alert
steps. Existing user-visible Coach/tending events continue through `/v1/events`; Coach displays
read the exact USD allowance contract. Dedicated Usage screens remain separate work. Every budget queues 50/80/95% settled-plus-held threshold crossings
atomically to the durable outbox. Alert email contains scope, funding source and numeric totals,
but no account/device identifiers or user content; the configured owner email is never telemetry.
The `ai_usage` Amplitude mirror remains separate from durable admission.
[AI_ALLOWANCES.md](AI_ALLOWANCES.md) lists provider coverage and rollout requirements.

Per-request token estimates can differ from actual usage. Settlement records full actual cost and
absorbs a positive variance without an Issue when every original funding budget can cover it,
including other unresolved holds and bound-device account attribution, with no existing debt.
An unfunded variance retains overrun debt and produces a static `ai.budget.settle` Issue;
settlement replay does not
repeat the report. Neither path logs request content, token-estimator inputs or raw provider data.

## Signed-in Gym routine setup

Coach's `ask.run` observation covers setup admission, model turns and terminal persistence. `gym.ask_setup_details` logs the typed question write with `ok` or `refused`; unexpected storage failures report under that static operation. Its text, choices and IDs never enter logs. Coach's `gym.create_routine` completion covers draft preparation, recovery, replay and the expected catalog, immutable-slot and cap refusals; a draft writes nothing through GymDoor. A generation whose client does not review drafts (`routineReview`) is never offered the tool, and a call to it completes `refused`. Confirmation logs the route's `gym.coach.routine.confirm` line; the save runs on the upload pool under the route's request id, so GymDoor's `gym.server_call` and the engine's `sync.admit` lines carry the same request id, and no `gym.create_routine` line is written. Every confirmation refusal code is on the refusal allowlist and logs without an Issue; an unexpected failure reports once under the request. Stop and later allowance failures retain the existing static operations, pending drafts and factual creation receipts.

Routine setup refuses writes outside its focused tool catalog before any action is persisted. Those attempts retain the tool's static `gym.<tool>` completion with `refused` and create no Issue.

Native setup emits `gym_setup_step` through `/v1/events`, with `screen:coach` and the bounded action labels `shown`, `screenshot`, `describe`, `build_manually`, `clarify`, `drafts_rejected`, `open_routine`, `routines_saved`, `keep_routines`, `photo_selected`, `photo_removed`, `review_routines`, `review_closed`, `save_routines`, `sign_in`, `connect`, or with `screen:receipt` and `action:keep` (the phone's first signed-out receipt). A failed save includes `outcome:failed`. Client validation excludes questions, option values, routine names and allowance amounts. The product-neutral intake stores and forwards the accepted event using its existing batch observation.

Native workout adjustments emit `gym_workout_adjusted` with `screen:workout`, `field:weight|reps` and `outcome:ok|failed`. Movement edits emit `gym_exercise_updated` with `screen:movement`, `action:rename|equipment` and `outcome:ok|refused|failed`. Web, iOS and Android routine confirmation emits `gym_coach_routine_confirm` with `outcome:started|saved|refused|failed`: `refused` when the server answers 4xx, `failed` for a 5xx or no answer. These events contain no exercise IDs, names, entered loads, reps, drafts or user text. Client schemas constrain the labels; the product-neutral intake preserves them and supplies platform attribution.
