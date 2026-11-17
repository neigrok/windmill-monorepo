# Agent turns

`:agent` is a plain JVM library with only `:sync-core` and coroutines as dependencies. The released
Gym protocol uses `TurnDriver`, `TurnHost` and `TurnWire`. The device-hosted Coach engine lives in
`works.windmill.agent.coach`; it is a library and has no product cutover or screen integration.

`Profile` validates plain JSON before admission. `TurnRunner` runs one sequential turn through
`ToolHost`, `AiClient` and `Telemetry`. Its working messages, carry, full tool results and prompts
stay in memory. A host atomically creates its visible records and a null-call `Mark`, then returns
an opaque lease. Every text, round, execution, final end and withdrawal checks that lease and
record existence inside its own commit. Deleting a record never permits an upsert. Final writer
states outrank a stale observer's `interrupted` state.

Call `seatWillChange()` and await it before changing host generations or credentials. It waits for
pending host commits, ends the old turn interrupted, drops the pass and frees the active slot.
The old network operation may drain afterward; its callbacks and cleanup cannot affect the next
turn. Stop wakes retry waits and cancels pending retry credentials, picture repair and HTTP headers.
During a model stream it awaits the terminal; a completed answer
wins, while terminal tool calls are discarded. Every admitted execution is sequential and counts
against volume, including executor refusals; only success consumes a once-group slot.

`Mark` records the UTF-8 prefix length before a round. Recovery only reads the marked call. It
replaces that round's partial text from the saved byte prefix, finishes a final response, and ends
interrupted for tools, lost results or an unmarked round. It never resumes ability execution.
`isStaleTurn` requires running state, live sync and a usable corrected server time at least thirty
minutes after the record's server update. A host rechecks both record and runtime freshness inside
its state-only stale write.

The platform implementation is under `platform/ai`: `CoachAiClient` owns pass caching, picture
repair and retry policy; `AiHttp` owns HTTPS, credential separation and bounded strict SSE decoding.
It sends session/installation credentials only to the pass door and never accepts redirects or
cookies. Local HTTP is an explicit constructor opt-in for literal `127.0.0.1` or `::1`. Requests
are serialized once per call, event cursors suppress replay, and admission only increases.
Before round 1 writes its mark, `TurnRunner` asks `AiClient.connected()` once whether the device
reports a connection. With none it withdraws the turn, so its draft returns at once with no mark,
pass fetch, picture upload or request; later rounds and recovery never ask. `CoachAiClient` answers
from the `connection` it was constructed with. No application constructs this client yet, and until
one passes `connection` (its connectivity callback's report), every turn counts as connected.
Before a text dispatch, an offline pass or picture preparation failure also withdraws the turn. A
text dispatch that fails is uncertain whatever the device reports and retains its records. Lost calls keep their original twenty-minute deadline through temporary
pass refresh failures and proxy responses. A resent PUT still gives paused, concurrency and
provider-unavailable refusals thirty seconds from the first PUT.
`CoachRuntime` supplies cryptographic 128-bit identifiers and process-local turn leases. Its
injected background lease is acquired and released with the turn. `AndroidCoachBackgroundLease`
provides a bounded partial wake lock for a future integrating application that declares
`android.permission.WAKE_LOCK`; the current Gym app continues using its existing expedited job.

The engine's telemetry port emits one bounded turn outcome and one bounded outcome per attempted
ability. It reports unexpected host faults as `agent-host`; the platform adapter reports wire,
transport and protocol defects as `ai-call`, and unexpected pass-door faults as `ai-pass`, through
the existing Android Sentry boundary. Lost connections and expected refusals do not become Issues.
A product adapter supplies its registered first-party event names. No IDs, seats' keys, content,
credentials, raw errors or amounts enter these outcomes. Telemetry observers cannot fail a turn.
Recovery `call_unknown` is an interrupted turn without an Issue; the same refusal during a live
turn is a call defect. Non-service HTTP error bodies and expected temporary pass refusals are quiet.
See [Android observability](../../../docs/ANDROID_OBSERVABILITY.md).

From `apps/android`, `:platform:testDebugUnitTest --tests '*Coach*Tests'` runs every shared story in
`packages/api-contract/agent/turns` against the actual runner and client with a deterministic
transport and guarded host. It also consumes the AI fixtures, checks credential isolation, strict
SSE, delayed record deletion and seat changes. `:agent:test` checks the pure policies and released
runner; `:sync-engine:testDebugUnitTest` checks the runtime's live freshness along with sync.
Platform client changes also run the [app's source checks](../README.md#local-verification).

The opt-in process probe is `works.windmill.platform.ai.CoachServiceProbe`. Build
`:platform:coachProbeClasspath`, then launch Java with the contents of
`platform/build/coach-probe/classpath.txt` as `-cp` and that main class. Set
`WM_COACH_PROBE_CONFIG`, `WM_COACH_PROBE_OUT` and optionally `WM_COACH_PROBE_STATE` to private local
paths. The probe uses the real client and runtime. Its atomic state contains only visible text,
state, mark, executed identities and toy values. A scenario beginning with `recover` reads the
saved call without a PUT or another execution; `stop` stops on first text. Ordinary tests never
invoke this main class or a paid provider.
