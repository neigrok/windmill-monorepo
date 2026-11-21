# AI service

The [service contract](../../docs/foundation/ai-service.md) defines the wire, accounting rules and
limits. This workspace implements that contract independently of the C++ backend. Existing product
callers still use the backend; their migration is outside this service.

## Boundaries

| Crate | Owns | Runtime dependencies within this workspace |
|---|---|---|
| `ai-domain` | Exact money, periods, tier and price policy, accounting decisions | None |
| `ai-storage` | PostgreSQL snapshots, transactions, migrations and recovery | `ai-domain` |
| `ai-providers` | Provider request validation, counting, streaming and sealed continuation data | No storage or server dependency |
| `ai-server` | Pass verification, public and internal listeners, task ownership, results and telemetry | Domain, storage and providers |
| `ai-pass-signer` | Offline signing tool | Never linked into the server |

`check-dependencies.sh` checks normal and build dependencies. Domain tests may use test libraries;
the production domain has no I/O, async runtime, serializer or database dependency. Providers and
storage cannot depend on one another.

The server owns its listener and telemetry modules. A separate implementation keeps AI's detached
provider calls, long drain and content restrictions independent of the subscription service's
request lifetime. It does not introduce a shared runtime crate between the services.

## Accounting

Money is a checked, nonnegative integer number of nano-USD. HTTP amounts are exact decimal strings.
Neither parsing, reservation nor settlement uses floating point. The tier and price files are
startup inputs; a missing rate or unsupported model configuration prevents startup.

PostgreSQL holds only accounting metadata. A call records its provider, model, price version and
rate snapshot, budget pins, usage counts, state and charge. Changing a price file does not reprice
an existing call. The database holds no request or response JSON.

The ledger holds a dedicated PostgreSQL session's advisory lock. Short mutation transactions run
on that same session under a mutex; losing the session prevents another mutation from committing
under an unrelated pooled connection. Provider I/O never holds the writer. Other connections serve
reads. Statement, lock and transaction timeouts bound database work.
Each server database boundary also has a five-second client deadline, covering a connection that
stops replying. Shutdown starts its budget at the signal and never waits for a database-held lock
before closing admission.

Admission loads the budgets and identity facts, applies the pure domain decisions, then writes the
reservation and its pins in one transaction. A separate conditional update changes `reserved` to
`dispatched`. The provider adapter is called only after that update succeeds. A repeated caller ID
attaches to the existing call; it never dispatches another request within call retention.

Settlement changes a call's state and every pinned budget together. Repeating it returns the stored
outcome. An uncertain text call spends its reservation. An operator correction changes the original
pinned budgets and retains the earlier charge. Grant operations are ordered and idempotent; Close
and Reopen do not commute. Subscription and owner references have separate namespaces.

Installation bindings are permanent. Separate monthly aggregates retain the installation's held
and spent amounts independently of call-row retention. A free account counts its bound installations'
current month and every bound call still in flight. Those costs never move into a paid grant.

Live transcription reserves another slice before forwarding audio that would exceed its reserved
billable duration. Billable seconds are the sum of each turn rounded upward, including the current
turn; rounding only the total byte count would underreserve many short turns. Incremental charges
make running sessions visible to the provider fuse. Final settlement applies only the remaining
difference.

## Task and content lifetimes

A service-owned task retains each admitted call after its HTTP reader disconnects. The provider
adapter has no retry or redirect policy. A malformed or oversized provider stream is drained with
content discarded, bounded by the call deadline. Only known unconsumed work releases a reservation.
Live provider writes have a one-second deadline; cancellation drops the unfinished transport write.
Attempted audio remains accounted even when that write times out.

An admission and its in-memory owner registration share a lifecycle lock with orphan recovery.
The sweep cannot mistake a newly committed call for an abandoned one. The same coordination closes
admission when shutdown begins. The startup sweep runs before the listeners open.

Settlement retries retain accounting evidence, not the provider answer. The caller receives a null
charge if settlement cannot finish within its response window; the owner continues trying. A call
without an owner is ended by the sweep. A restarted process cannot replay content: the durable call
remains readable, but its result is gone.

Content types implement neither `Debug` nor `Display`. Provider boundaries turn errors into fixed
codes and never retain vendor error text. The provider receives no principal identifier. Signed
passes are verified before their payload is parsed, and production rejects published test keys
under every key ID.

Results live only in bounded memory. A new reader replaces the previous one. Active results count
toward the same bounds as ended results; eviction never cancels accounting or provider draining.
A principal cannot evict another principal's result.
Uploaded JPEG/PNG pictures live in a separate principal-keyed memory cache: 2 MiB each, 8 MiB per
principal, 256 MiB total including entry metadata, oldest first evicted. They expire 30 minutes after upload or last reference,
with a timer pruning idle entries. An idempotent upload keeps the first bytes and its original expiry.
The text boundary snapshots each unique picture under the cache lock, counts every reference and
inline image against the 8 MiB provider request limit before renewing entries, then encodes each
unique picture outside the lock. The provider checks the exact serialized body limit with a bounded
byte counter before counting and reservation;
a missing reference answers `picture_gone` without a call row, so the caller can repair it under the
same call ID. Uploads consume the read rate and make no provider call. A timer removes expired results even without
new traffic. Audio and transcript buffers are bounded separately from socket buffering.
The producing task owns a result guard. If it exits before a terminal event, the guard clears its
unfinished content and wakes readers immediately, independently of ledger recovery.

## Observability

Picture uploads emit one `picture.upload` line with a bounded outcome and duration, without picture IDs or bytes.
The service emits no product events. Calling surfaces own those events; accounting is read from
the ledger. Logs and Sentry carry fixed operation names, bounded policy labels, technical outcomes,
durations, counts, amounts and the service's numeric call ID. They never carry caller IDs, principal
IDs, passes, keys, prompt text, transcripts, tools, images, audio, provider error text or request URLs.
Write lines identify `product: ai` and their static public, internal or background door. Terminal
call lines use the state actually settled, including a usage calculation that became assumed.

The tracing subscriber allows service targets only. Dependency tracing cannot expose HTTP headers
or WebSocket frames. Panic reports contain location and stack, without the panic payload. Container
core dumps are disabled.

| Signal | Level |
|---|---|
| Admission or settlement storage failure | Error |
| Assumed call or reservation excess | Error |
| Provider key or account refusal | Error |
| Contradictory installation binding or owner funding cap | Error |
| Free-pool threshold, open provider fuse, conflicting Fund or Reopen | Warning |
| Provider busy for three minutes, with no gap longer than a minute | Warning once per continuous streak |
| Ordinary budget, capability, concurrency and request refusals | Structured log only |

Free-pool crossings are recorded transactionally with an outbox. Pre-authentication refusals,
rate refusals and process-cap refusals are aggregated by code. The public listener never mounts an
internal route, and funding and operating use distinct bearer secrets.
Database Issues are limited to one per static operation per minute. Storage refusals still reach
their callers, and settlement keeps retrying after its response deadline.

The [runbook](RUNBOOK.md) covers local operation, investigation, correction and rotation. Live
provider billing checks and delivery of production alert rules are deployment acceptance gates;
simulated-provider tests do not establish them.
