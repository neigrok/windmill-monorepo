# Device Coach runner

`TurnRunner` runs one sequential turn from a plain-data profile. It knows no product, catalog,
transport or store. `turn.js` contains the runner, profile checks, access mapping and the pure
30-minute server-clock stale predicate. `runtime.js` supplies browser Web Locks, cryptographic
128-bit base64url call IDs and cancellable waits. Nothing connects these libraries to a screen.

The constructor takes `host`, `ai`, `telemetry` and `runtime`. `run(input, profile)` returns the end;
`run(input, profile, {recover:true})` takes the lock without waiting and reads the marked call only.
The runner marks a turn's first text call `firstRound`; the AI client sends nothing for it while the
device reports no connection, and that turn is withdrawn.
`stop()` interrupts retry waits but lets a live provider stream finish. The composition root must
await `seatWillChange()` before credentials, active replica or host generation change. The barrier
waits for pending host mutations, writes interrupted, and drops the in-memory pass immediately.
If the active record has disappeared, the barrier resolves without writing or reporting a failure.
An unexpected barrier write failure reports `agent-host` before rejecting. The turn reports that
failure once even if its provider finishes later and the original run encounters it again.

The host implements `open(input)`, `recover(turnId,seat)`, `beginRound(lease,text,mark)`,
`text(lease,text)`, `check(lease,rule,call)`, `execute(lease,identity,call)`, `end(lease,end)` and
`withdraw(lease)`. `open` atomically creates the messages and null-call mark, returning an opaque
lease plus history, context and pictures. Every mutation must check that lease, seat generation and
record existence inside its own commit. An absent record throws `HostUnavailable`; it must never be
upserted. Begin writes visible text and mark atomically; end writes visible end and clears the mark
atomically. `execute` receives the complete `(turnId,callId,toolCallId)` identity. `check` returns a
refusal code or null. Optional `refused({id,code})` is a local host observation for conformance traces,
not telemetry. A host may throttle visible text but must keep writes frequent enough to avoid stale
age. The engine retains the working conversation only in memory.

The telemetry port receives `turn` (state, seat kind, bounded code, rounds, admitted ability calls,
gate refusals, UTF-8 answer bytes and duration), `ability` (offered name or `unoffered`, outcome and
bounded refusal code), and static `failure` operations. Product adapters choose event names and
send them through the first-party events intake. No seat key, ID, prompt, carry or result reaches
telemetry. Observer errors do not interrupt writes.

`BrowserSyncEngine.freshness(scope)` and transaction `readMetadata(...).freshness` expose the live
scope and corrected server time. `isStaleTurn` only decides age; a product host rechecks the current
row and freshness inside the state-only interrupt commit. Writer final states must rank above
interrupted, which ranks above running. The catalog and schema subset belong to domain-kit.

Shared stories in `packages/api-contract/agent/turns` execute the actual runner and AI client against
guarded toy storage and scripted transport. `web/test/platform/agent/service-probe.mjs` is an opt-in
local-service driver using `WM_COACH_PROBE_CONFIG`, `WM_COACH_PROBE_OUT` and optional
`WM_COACH_PROBE_STATE`. Its state file contains only visible text/state, marks and toy writes.
