# Windmill platform libraries

`WindmillPlatform` contains the AI service client and native Coach adapters. It depends on `Agent`
and the sync API/runtime and imports no product. The package uses MainActor isolation and treats
warnings as errors; transport DTOs and the URLSession delegate explicitly cross that boundary.
The App's Roadmap Coach composes these over the room's runner (`App/Sources/Roadmap/Coach/`), behind its switch; the App's gym Coach keeps its own wiring.

`ServiceAiClient` holds passes in memory, counts expiry on its local monotonic clock, refreshes
with sixty seconds left and fences delayed results against a seat generation. `AiURLSessionTransport`
pins one HTTPS origin, has no cookie, credential or response cache and refuses redirects. An explicit
loopback-only HTTP option serves local verification. Session and installation credentials go only
to the pass door. Text, result, allowance and picture requests carry only the pass.

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
predate dispatch. Live `call_unknown` remains a defect.
Admission certainty never moves backward. A pass-expired or picture-gone repair runs once under
the same ID. A seat change cancels local transport, clears cached allowance and cannot authorize
late replies to publish under another seat.

`ServiceAiClient.connected` answers whether the device reports a connection, from the `connection`
it was constructed with; the App's Roadmap Coach passes its sync engine's report. A client given no
`connection` counts every turn as connected. The engine asks once, before a turn's first round, and withdraws a turn begun with no
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
unexpected transport errors under static `ai-call` or `ai-pass`; expected refusals remain outcomes.
Product integration supplies the Sentry and first-party event sinks described in
[iOS observability](../../../docs/IOS_OBSERVABILITY.md). No SDK key, request, pass, call ID, raw error
or user content enters either port.

Run `swift test --package-path apps/ios/WindmillKit --explicit-target-dependency-import-check error`. Tests replay every shared story, parse the AI
wire fixtures across byte boundaries, exercise URLSession credential isolation, race pass and
allowance replies against seat changes, and verify real sync commit guards. No provider runs.
`CoachLocalProbeTests/run` is opt-in: `WM_COACH_PROBE_CONFIG` supplies a protected synthetic config,
`WM_COACH_PROBE_OUT` names the JSON result and optional `WM_COACH_PROBE_STATE` holds only the visible
record, mark and toy execution identities. A new process reads that state and recovers by GET.
The probe stores no pass, prompt, working conversation, carry or full tool result.
