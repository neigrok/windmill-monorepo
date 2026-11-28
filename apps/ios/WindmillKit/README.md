# Windmill platform libraries

`WindmillPlatform` contains the AI service client and native Coach adapters. It depends on `Agent`
and the sync API/runtime and imports no product. The package uses MainActor isolation and treats
warnings as errors; transport DTOs and the URLSession delegate explicitly cross that boundary.
The shipped app retains its existing Coach wiring.

`ServiceAiClient` holds passes in memory, counts expiry on its local monotonic clock, refreshes
with sixty seconds left and fences delayed results against a seat generation. `AiURLSessionTransport`
pins one HTTPS origin, has no cookie, credential or response cache and refuses redirects. An explicit
loopback-only HTTP option serves local verification. Session and installation credentials go only
to the pass door. Text, result, allowance, picture and live requests carry only the pass.

A pass is fetched for an `AiUse`: a name, a version and the label its calls carry. A Coach
`Profile` gives one as `profile.use`; a product without a profile names its own, as Journal Talk's
spec names `journal.talk`. `allowance(for:seat:)` reads the allowance under a use's pass, and
`liveResult(callId:use:seat:)` reads a live session's last message, answering it or that the session
is still open, gone or unknown.

`openLive(callId:use:seat:livenessMs:)` upgrades `/v1/calls/{callId}/transcription` to `wm-live.v1`
on the pinned origin, with the pass as `Authorization`. URLSession gives a refused upgrade's status
and never its body, so a 401 renews the pass and tries once more; a second 401, a 400, a redirect and
a handshake that answers no subprotocol or another one are reported defects, and any other status is
lost with that status. The opening answers `started` with an `AiLiveConnection`, a refusal, a first
`failed`, or `lost` with its `AiLiveLoss`. The wait for `started` is the caller's to bound: nothing
checks it, and cancelling the opening closes the socket. The connection sends audio frames, `commit`
and `end`, holds no audio, and from `started` on keeps one read of its socket outstanding, so each
message is taken as it arrives. `next()` answers the next `text` or `turn`, then the session's
`ended` or `failed`, or `lost`, and that last answer on every later call; callers waiting together
share the stream, each message going to the one that asked first. A terminal's shape is validated
field by field and its code need only have the service's form: a code the client does not know is
reported once and the message still arrives with its words, here and from `liveResult`. A loss names
its cause: the socket closed, the network or the transport failed, a wire defect, a ping unanswered
for `livenessMs`, an audio frame waiting that long to be sent, or a cancelled read or `close()`. A
terminal already taken from the socket is never replaced by a loss. The connection pings every
`livenessMs` from `started` until `end`. A wire defect and a close with an abnormal code are
reported; a socket the network drops, with a connection error and no close frame, is a quiet loss, as
it is offline. Audio the door would refuse is thrown back to the caller, unsent and unreported. The
client holds its connections weakly, and one nobody holds closes its socket. A finished connection
lets go of its socket and the socket of its task, so nothing left behind reaches the pass; a seat
change closes every connection of the old seat and fences its reads, finished ones too. The live
types and `AiFailure` describe, debug-describe and mirror themselves by case and counts, without
words, audio or money.

Each round retains one serialized body and call ID. Lost streams retry PUT before their first event
and GET afterward, with monotonic event cursors and incremental UTF-8 parsing. Recovery uses GET
only. PUT transient refusal retries stop thirty seconds after the first PUT. After a lost answer,
rate-limited, busy and accounting-unavailable refusals use the twenty-minute deadline; the other
transient PUT refusals keep their original thirty-second window. The twenty-minute deadline begins
at the first PUT or recovery start and spans pass refresh, requests, streamed reads and retry waits.
Preparation loss after an active thirty-second refusal deadline returns that refusal; it cannot
reopen recovery.
Pass preparation has its own bounded watchdog; expiry cancels suspended work.
Every event, terminal, allowance and refusal is validated before delivery, including exact fields,
nonnegative decimal money and the started event's requested call ID. Allowance validation checks
wire types and enums; the service owns arithmetic, tier and capability policy. Money is validated as
a decimal string without integer conversion. Non-service HTTP errors are ambiguous transport loss;
they retry quietly after dispatch. A recovery `call_unknown` ends quietly because its mark may
predate dispatch; a text call's own `call_unknown` remains a defect. `liveResult` answers `.unknown`
quietly, and a caller that heard `started` for that session reports it.
Admission certainty never moves backward. A pass-expired or picture-gone repair runs once under
the same ID. A seat change cancels local transport, clears cached allowance and cannot authorize
late replies to publish under another seat.

`ServiceAiClient.connected` answers whether the device reports a connection, from the `connection`
it was constructed with. No application constructs this client yet, and until one passes
`connection` (its path monitor's report, `SyncEngine.PathConnectivity.isOnline`), every turn counts
as connected. The engine asks once, before a turn's first round, and withdraws a turn begun with no
connection, so the client is never called for it. The client itself never asks.

After that, offline policy follows dispatch evidence. A pass or picture failure before text dispatch
restores the draft promptly. A text attempt that fails is uncertain whatever the device reports and
retries under the same call ID. Temporary pass refresh transport loss, rate limits and
unavailability keep the original recovery deadline. No saved working conversation is needed.

`CoachRuntime` supplies cryptographic IDs and holds `CoachWorkLease` for the turn. On iOS,
`CoachBackgroundLease` returns UIKit background time once on completion or expiration.
`CoachCommitGuard` checks seat generation, actual replica and record existence inside a sync commit.
Its stale interruption rechecks the record and `ScopeReader.freshness()` in that transaction and
writes only the state. `freshness` is unavailable before a clock sample/live scope attachment,
after a clock jump, or during disconnect, background, auth pause or seat transition.

The engine's telemetry port reports ability outcomes and turn state, seat kind, bounded code,
round/execution/refusal counts, answer bytes and duration. `Telemetry.hostFailure()` reports unexpected
host and runtime failures under static operation `agent-host`; expected record/seat refusals stay quiet. `AiDiagnostics` reports wire defects and
unexpected transport errors under static `ai-pass` for the pass door, `ai-live` for the live door and
`ai-call` for the others; expected refusals remain outcomes.
Product integration supplies the Sentry and first-party event sinks described in
[iOS observability](../../../docs/IOS_OBSERVABILITY.md). No SDK key, request, pass, call ID, raw error
or user content enters either port.

Run `swift test --package-path apps/ios/WindmillKit --explicit-target-dependency-import-check error`. Tests replay every shared story, parse the AI
wire fixtures across byte boundaries, play the live door from them through a played socket and a
loopback WebSocket, exercise URLSession credential isolation, race pass and
allowance replies against seat changes, and verify real sync commit guards. No provider runs.
`CoachLocalProbeTests/run` is opt-in: `WM_COACH_PROBE_CONFIG` supplies a protected synthetic config,
`WM_COACH_PROBE_OUT` names the JSON result and optional `WM_COACH_PROBE_STATE` holds only the visible
record, mark and toy execution identities. A new process reads that state and recovers by GET.
The probe stores no pass, prompt, working conversation, carry or full tool result.
