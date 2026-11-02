# Telemetry saves off the caller and dormant accounts yield capacity

**Status:** Reviewed, with one fix pass applied. `:platform` and `:gym` unit tests are green (EventQueueTest 20/20, AndroidTelemetryTest 7/7, GymEngineSessionTests 18/18). Not yet run on the local stack: delivery of events and Sentry reports from a device.

**Context:** telemetry has a shared 500-event capacity across account shelves. Callers need nonblocking enqueue operations, and a dormant account must not prevent the current account or signed-out shelf from recording events. Retirement can move events while delivery is in flight.

**Current implementation**

- `platform/telemetry/EventQueue.kt` owns restoration, ordered commands, immutable snapshots and persistence in one worker. A burst saves once; delivery waits for acknowledgement by event id before selecting another batch. Event timestamps and safe properties are captured at enqueue time; credentials are never serialized.
- Pure store transitions evict the oldest dormant shelf head first, breaking equal timestamps by shelf order. Drainable shelves alone can fill capacity and report `telemetry_overflow`, once until a batch lands.
- `AndroidTelemetry.kt` opens preferences lazily and gives queue jobs an injected IO dispatcher while retaining the application job and checked `commit()` writes.
- Storage exceptions report and retain a live queue, including cancellation exceptions from an active worker's collaborators. Actual coroutine cancellation stops work without a failure report; fire-and-forget callers do not receive collaborator exceptions.
- Queue and Android boundary regression tests cover deferred storage, command ordering over restored data, coalescing, capacity, retirement during delivery and cancellation. The gym sign-out transport test injects its scheduler so its batch assertion remains deterministic.
- The gym event-schema rejection test captures its disk baseline after asynchronous queue restoration, then verifies rejected events leave that state unchanged.
- `docs/ANDROID_OBSERVABILITY.md` records background persistence and the capacity policy. No operations, events, product copy or visuals are added.

**Done when**

- The orchestrator passes platform telemetry and gym sign-out tests and reviews the diff.
- Runtime verification confirms first-party event delivery and static, scrubbed failure reports with background persistence.

**Observations**

- Store transitions take generated session keys as input, keeping persistence and randomness outside the pure policy.
- The command channel is unbounded; disk stalls can accumulate commands. Enqueue durability begins after the worker saves, with no synchronous flush contract.
- Credential reads remain on the identity caller; a missing credential still allows an account shelf to send without a bearer. These behaviors are outside this package.
- iOS retains the shared-capacity starvation issue in `apps/ios/App/Sources/EventQueue.swift`; follow-up tree node: `ios-telemetry-dormant-capacity`.

**Depends on:** none. Tree: `android-110-telemetry-queue`.
