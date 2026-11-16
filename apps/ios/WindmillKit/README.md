# Windmill platform libraries

`WindmillPlatform` contains the AI service client and native Coach adapters. It depends on `Agent`
and the sync API/runtime and imports no product. The package uses MainActor isolation and treats
warnings as errors; transport DTOs and the URLSession delegate explicitly cross that boundary.
The shipped app retains its existing Coach wiring.

`ServiceAiClient` holds passes in memory, counts expiry on its local monotonic clock, refreshes
with sixty seconds left and fences delayed results against a seat generation. `AiURLSessionTransport`
pins one HTTPS origin, has no cookie, credential or response cache and refuses redirects. An explicit
loopback-only HTTP option serves local verification. Session and installation credentials go only
to the pass door. Text, result, allowance and picture requests carry only the pass.

Each round retains one serialized body and call ID. Lost streams retry PUT before their first event
and GET afterward, with monotonic event cursors and incremental UTF-8 parsing. Recovery uses GET
only. Refusal retries stop at thirty seconds. Each round has one twenty-minute deadline spanning
pass acquisition, requests, streamed reads and recovery waits; expiry cancels its suspended task.
After a lost answer, only rate-limited, busy and accounting-unavailable refusals retry.
Every event, terminal, allowance and refusal is validated before delivery, including exact fields,
nonnegative decimal money, allowance arithmetic and the started event's requested call ID.
Admission certainty never moves backward. A pass-expired or picture-gone repair runs once under
the same ID. A seat change cancels local transport, clears cached allowance and cannot authorize
late replies to publish under another seat.

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
