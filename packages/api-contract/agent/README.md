# Coach turn stories

Each `turns/*.json` is one `coach-turn/v1` story. `generate.py` authors the corpus declaratively;
it imports no engine or client, runs no policy, and never records implementation output.
Run `python3 packages/api-contract/agent/check.py` to validate AI events and complete text requests
with the AI wire checker. Tests compare every expected field by deep equality.

`profile` and `input` are the public engine data. `runtime` supplies a zero-based millisecond
clock, deterministic 22-character call IDs, browser-lock availability and `connected`: whether the
device reports a connection when the turn starts. It is the switch the engine asks before round 1
writes its mark or sends anything; it decides no scripted response. The harness uses the actual engine and actual AI
client; only transport, storage, time, IDs, locks and the connection report are fakes.

`host.open` supplies history, ordered context and pictures. A picture has `pictureId`, `mediaType`
and `bytes` (an integer array). `host.checks` maps tool-call IDs to the seat, shape or product rule's
refusal. Missing checks succeed. `host.executions` maps IDs to `{ok:true,content}` or
`{ok:false,code}`. Missing execution results return the call's integer value as text.
`host.recovery`, when non-null, seeds a mark, visible text and record state and selects recovery.
The toy host must guard every mutation inside its commit, with a lease containing the seat
generation; deleting a record prevents every subsequent write. The initial open writes a null-call
mark atomically. Begin writes text and mark together; end writes final values and removes the mark.

`service.passes` is a queue of pass-door responses (a successful entry is `{pass,expiresIn}`;
a refusal is `{code,status}`, and a connection loss is `{transport:"offline"}`). Optional `elapsedMs` advances the harness clock before that response arrives. Its last entry repeats. `service.exchanges` is the service transport
queue for text PUT and result GET. Each has `events`, `refusal` (null or `{code,allowance}`),
`broken` and `repeat`, plus optional `http: {status,contentType,body}` for an untrusted proxy response
or `transport: "offline"` for a request that fails as a connection loss with no answer. An event is `{id,event,data}` with the AI wire event's exact shape.
`repeat` repeats the transport response, never client policy. A stream with no terminal is lost.
`service.pictures` supplies upload status codes, defaulting to 204. The client owns retries.

Controls execute once at a named checkpoint, before that operation commits or event is delivered:
`open:beforeCommit`, `beginRound:beforeCommit`, `text:beforeCommit`, `event:<zero-based exchange>:<event id>`,
`wait:<zero-based wait>`, `execute:<tool id>:beforeCommit`, and `check:<tool id>:<rule>`.
Actions are `stop`, `seat`, `delete`, `stale` and `disconnect`. `seat` begins the awaited seat-change barrier
without waiting inside the callback (which would deadlock pending-open/write); the harness awaits
the barrier before moving the host generation. `delete` removes the record immediately; `stale`
sets only its state to interrupted; `disconnect` turns the device's connection report off. A fake wait records its requested duration, applies its control,
then advances the clock only if not cancelled. No wall-clock sleep occurs.

`expected.requests` lists all service requests as `{method,path,body}`; passes are deliberately
separate scripted credentials and never appear in traces. Body is parsed JSON for text, null for
GET and an integer byte array for a picture. `hostCalls` lists successful guarded writes and gate
checks, with exact payloads. A deleted-record attempted write is absent. A `recover` call is the
host's guarded read. Marks include the initial mark, each round's mark, and null when cleared.
`gateRefusals` contains `{id,code}` in dispatch order. `waitsMs` includes cancelled waits.
`telemetry` contains port calls normalized by kind: turn, ability, or static failure. A turn event
counts admitted executions, gate refusals, UTF-8 answer bytes and elapsed milliseconds. Unknown
tool names normalize to `unoffered`. `end` is the runner result, null for a record deleted under it;
withdrawal still returns a failed end while removing the records. Recovery counts zero new rounds.

Call identity is `(turnId,callId,toolCallId)`. Duplicate IDs in one terminal fail `invalid-answer`
before any dispatch. Local codes are `model-call-limit`, `answer-timeout` and `invalid-answer`.
The safety corpus covers pending open, async deletion, multibyte recovery, seat fencing, replay,
and an active writer finishing over another device's stale interruption. A story whose
turn starts with no connection scripts a pass door that takes a second to answer, so its zero
duration shows the turn was withdrawn before the pass was asked for.

`../catalog/schema-patterns.json` holds whole-value pattern cases shared by the schema checkers.
Each case supplies `schema`, `value` and the exact `fault` (null when it matches). Alternation must
backtrack to match the whole value; a match ending before a final newline is not a whole match.
