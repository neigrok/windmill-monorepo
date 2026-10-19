# Hosted AI execution service

Status: proposal for review and discussion; no Rust implementation is specified as shipped.
The agreed deployment direction is an independently deployed Rust service at `services/llm/`
in this monorepo. Implementation follows review, discussion and revision of this specification.
The reviewed baseline is `e8d712e61611c463d050701fae42bb27cad12133`.
[AI allowances](../../backend/AI_ALLOWANCES.md) defines the implemented accounting policy;
[this proposal](#migration-and-rollback) defines a possible extraction, not a customer rollout.

## Existing policy and gates

Amounts are integer nano-USD internally and exact decimal USD strings at HTTP boundaries.
The table and accounting rules below describe enabled durable mode: USD allowances include every
hosted call, including passive Journal segmentation and curation for Echoes. Default-disabled mode
retains legacy trailing account/passive windows and product quotas. Production flag state has not
been checked; this source review does not establish deployed behavior.

| Principal | Individual limit | Period | Additional budget | Concurrency |
| --- | --- | --- | --- | --- |
| Verified anonymous device | $0.05 | Lifetime | $100 UTC month and $5 UTC day free pools | 1 |
| Verified account | $0.25 | UTC calendar month | Same free pools | 1 |
| Windmill One | $7 | Funded period | Its pinned funded grant | 2 |

Account allowance includes attributable anonymous usage from permanently bound devices.
Paid calls do not consume free pools. Subscription grants require verified completed funding;
entitlement or subscription status alone does not fund execution. Owner grants use calendar months.
A current subscription grant takes precedence over an owner grant; capacities are not combined.
Unresolved holds and debt survive period changes, expiry, device binding and tier changes.

`AI_ALLOWANCES_ENABLED` defaults to `false`. In enabled mode, anonymous composition remains closed
pending verified device attestation. Voice remains closed in enabled mode with `unsupported_ai_pricing`; compressed
upload size does not establish an audio cost bound. Refunds, chargebacks and adjustments do not
currently revise grants and block paid customer funding rollout. Checkout remains closed.

Preserve Coach's adaptive per-round output cap: the locked admission transaction selects the
largest affordable cap from 1,024 to `COACH_MAX_OUTPUT_TOKENS`, default 2,000. Valid configuration is
1,024–8,000. Other products retain their configured maximum. The extraction must preserve the
existing model choice, request shape validation, price allowlist and refusal semantics.
Reservations are estimates, not hard ceilings; actual usage can exceed them. The baseline has no
additional generic service-wide monthly cap. Process-hour and product burst safeguards exist.
Any new aggregate operator ceiling or foreground priority is a separate policy decision.

## Source review findings

- [Global transaction lock](../../backend/platform/adapters/postgres/PgAiBudgetRepository.cpp#L25)
  serializes accounting through one advisory lock. This is a correctness anchor, not evidence that
  independently replicated balances would be safe. Preserve serialization first; measure before
  replacing it with ordered scope locks.
- [Reservation transaction](../../backend/platform/adapters/postgres/PgAiBudgetRepository.cpp#L259)
  checks replay, computes admission, writes the reservation, updates every applicable budget and
  queues alerts together. Splitting these steps across HTTP services would weaken admission.
- [Budget service boundary](../../backend/platform/application/AiBudgetService.cpp#L72) accepts
  trusted raw reservation and settlement amounts. That is an in-process trust boundary. An HTTP
  execution API must calculate money from validated requests and verified provider usage itself.
- [Reservation schema](../../backend/db/schema.sql#L428) persists periods, grant, costs and adaptive
  output offers, but lacks immutable provider/model/pricing-version and usage evidence fields.
  Extraction needs these fields to explain settlement after a deployment or price change.
- [Call admission](../../backend/platform/adapters/llm/AiCallBudget.cpp#L198) mints a fresh UUID for
  each `begin`. An HTTP retry needs a caller-persisted identity before the first network send;
  otherwise a lost response can become another billable call.
- [Rollout limits](../../backend/AI_ALLOWANCES.md#provider-coverage-and-rollout-limits) and
  [remaining work](../../backend/AI_ALLOWANCES.md#structure-observations-and-remaining-work) retain
  the attestation, audio and refund gates. Service extraction does not satisfy those gates.

## Ownership and deployment boundary

The service owns admission, reservations, dispatch claims, provider credentials and execution,
validated usage, settlement, debt, concurrency, funding projection, device-binding projection,
threshold alert outbox and reconciliation. One authority owns every budget affected by a call.
It is product-neutral and cannot query product tables or invoke product tools.

The C++ backend owns user authentication, account lifecycle, verified device establishment,
entitlement and payment verification, product data, prompts, conversations, tool definitions,
tool authorization/execution and product-visible retries. Products use a platform execution port.
No product imports another product; the Rust service does not import product workflows.

Coach and tending retain their orchestration loops. Each provider round is a distinct execution
under one product operation ID. Tool calls return to the product for authorization and execution;
the next round supplies resulting context through the same admission path. Durable tool receipts
remain product-owned. A service restart cannot safely repeat a product tool action.

Deploy a distinct process, image, health checks, database role and provider-secret configuration.
Initially use the existing Postgres ledger, with service ownership enforced by database fencing.
A separate database is not required for independent deployment and adds migration risk.
Once authority transfers, C++ cannot directly mutate accounting tables or call hosted providers.
Implement durable mode only in Rust initially. Production transfer remains gated on an explicit
durable-mode enablement decision; routing must not silently apply USD limits to legacy users.
Keep legacy execution outside the transferred scope until that decision; it is never an outage fallback.

## Trust, funding and atomicity

Only authenticated internal workloads may call the service over authenticated encrypted transport.
Use workload identities with separate execution, funding and reconciliation permissions; never
accept browser bearer tokens as service authority. Network location alone is not authentication.
The product backend verifies a live principal and sends its opaque identity, operation class and
required principal revision. The service validates these against its authoritative projection.
Callers cannot choose free/paid funding, assert a larger allowance or exempt background processing.
Bind each execution to its authenticated workload and principal. Enforce that scope on POST replays,
status reads and cancellation; opaque execution IDs are not authorization. Reconciliation requires
a separate privileged identity and explicitly authorized principal scope.

Account eligibility, permanent device bindings and verified funding changes arrive through a
transactional outbox written with the source mutation. Events have stable IDs, aggregate revisions,
source references and explicit effective periods. Apply each event idempotently in one transaction
with its projection update. Missing predecessors or a request requiring a newer revision produce
`principal_state_unavailable`; they never fall back to stale free or paid state.

A read of the monolith's latest entitlement followed by an independent service reservation is not
atomic. For restrictive changes, first fence admission for that principal in the ledger, then
complete the source change and projection update, then acknowledge the resulting revision.
A durable source intent/outbox and resumable handshake make crashes leave admission closed.
The same fence serializes device binding with admission across the device and account scopes.
A client cannot regain eligibility by replaying an old signed assertion after a fence.

Funding is applied only from verified payment events or the existing owner policy. Duplicate events
cannot mint grants twice. Preserve source-specific nonoverlap, subscription precedence and original
periods. A grant insertion and its principal revision advance commit together. Funding projection
lag refuses affected execution; it does not borrow against an expected payment.
Refund/revocation semantics require a separate agreed policy before opening paid customer funding.
They must serialize with reservations and cannot erase already dispatched costs or outstanding debt.

## Proposed internal HTTP contract

Version routes under `/internal/v1`; bound body sizes, nesting, deadlines and allowed operation types.
All responses use `Cache-Control: no-store`. Money fields are decimal strings, never JSON floats.
Transport credentials and principal assertions are excluded from logs, traces and error bodies.

| Route | Purpose |
| --- | --- |
| `POST /executions` | Validate, price, reserve and claim one provider round; stream transient output |
| `GET /executions/{id}` | Read durable status and accounting metadata, without generated content |
| `POST /executions/{id}/cancel` | Idempotently request cancellation; return accounting status |
| `GET /principals/{id}/allowance` | Internal read used by the existing public allowance adapter |
| `POST /principal-events` | Apply authorized revisioned eligibility, binding and funding events |
| `POST /executions/{id}/reconcile` | Restricted evidence-backed settlement or debt reconciliation |

An execution request includes `executionId`, `operationId`, `roundIndex`, `principalId`,
`requiredPrincipalRevision`, allowlisted `product` and `operation`, deadline, model/profile and
bounded provider request content. IDs are minted and durably associated with the product operation
before sending. Retransmission uses the same execution ID; a new round uses a new ID.
The service derives cost and selected output cap. The caller cannot submit authoritative USD totals.

The first accepted request pins immutable execution metadata. A duplicate with conflicting
principal, operation, round, model or explicit bounds returns HTTP 409 `execution_conflict`.
A duplicate never supplies replacement content to an existing execution and never dispatches it
again. Without persisted content or content fingerprints, the service cannot prove byte equality;
its guarantee is one accepted execution per ID, not payload-equivalence verification. Callers must
never reuse an ID with changed content, including after losing the response.
An undispatched operation that lost its in-memory payload is explicitly released before the
product starts a new execution ID. Released and settled IDs remain tombstones, not reusable slots.

Before stream headers, invalid/authentication/conflict requests use 400/401/403/409; expected
allowance refusals preserve the public adapter's existing codes and metadata. Accounting or
projection unavailability returns 503 with a bounded code. After headers, failures are terminal
stream events carrying the same code and execution ID; HTTP 200 alone never means success.
An admission refusal creates no provider dispatch; the product may retry its operation later.
If no reservation was committed, the same execution ID may be admitted when capacity recovers.

Stream events carry execution ID, transient sequence, output deltas and a terminal execution
outcome with accounting status. Output completion and settlement completion are distinct: a
successful generation with failed settlement remains held and reports accounting uncertainty.
A disconnected caller polls status. There is no persisted output replay or `Last-Event-ID` recovery.
The product persists user-visible generations using its existing privacy and retention rules.
Do not claim an exactly-once user-visible response; only dispatch authorization and ledger writes
are durable. Provider-side exactly-once execution depends on documented provider guarantees.

## Durable execution and accounting

Preserve the existing reservation states; add attempt and cancellation metadata, not a second
competing balance state machine. A dispatch claim is committed before any provider request bytes.

| State | Meaning and allowed resolution |
| --- | --- |
| `reserved` | Held, no dispatch claim; claim once or release without usage |
| `dispatched` | Durable claim consumed; provider may have received request; settle or mark uncertain |
| `uncertain` | Outcome/usage unavailable; retain hold and concurrency; reconcile with evidence |
| `settled` | Complete supported usage recorded once; unused hold released; debt recorded if needed |
| `released` | Undispatched hold released; terminal identity retained |

Cancellation is a separate durable request flag, not proof of zero cost. Before dispatch it can
release; after dispatch it asks the provider to stop and still requires usage settlement.
A crash after the dispatch claim but before confirmed network send is ambiguous. Neither process
restart nor elapsed time releases it. Do not automatically retry ambiguous sends or partial streams.
Unknown provider acceptance is not a zero-cost failure. SDK retries must follow this same policy.

An execution permits one dispatch claim initially. Any future automatic provider retries require
explicit attempt records, independently bounded reservations and documented idempotency evidence.
Provider IDs assist reconciliation when available; they may be absent after a crash. If the provider
cannot recover usage, retain uncertainty until an authorized explicit resolution policy is agreed.
Persist normalized usage evidence as soon as it is available, with an idempotent evidence identity,
then retry settlement from that evidence. A reconciliation worker claims unresolved records and
retries evidence-backed settlement or supported provider lookup without redispatch. If storage is
unavailable, bounded in-memory retries may still lose evidence on crash; retain the hold and report
uncertainty rather than claiming recovery is guaranteed. A separate durable evidence inbox is an
implementation option only if its failure and retention semantics are explicitly defined.
No worker can reconstruct a lost prompt, resume model output or rerun tools from accounting metadata.

Settlement pins the original subject, periods, grant and price version. Record complete actual cost
once. Covered variance consumes available original capacity with other holds retained. If any
applicable scope cannot cover it, retain full actual spend and record the entire actual-minus-hold
variance as debt. New periods and grants do not absorb old liability. Debt reconciliation preserves
spend and records authority/evidence; it must not silently refund the original execution.

## Prices, evidence and atomic budgets

Use immutable price revisions containing provider, exact model, supported usage categories,
cache rules, currency, effective interval and source reference. Store the selected revision,
estimator revision, estimated categories, original offer and selected cap with the execution.
Persist allowlisted provider evidence: request ID, returned model, normalized usage categories,
completion classification and timestamps. Do not store raw provider responses as evidence.
New prices never rewrite historical settlement. Missing or unsupported usage stays uncertain.

Keep the current bounded estimator behavior and adaptive Coach calculation inside admission.
Validate the actual request and dispatch the same validated request with its selected cap.
This remains approximate accounting; a hard vendor-spend ceiling requires stronger provider bounds
than the existing estimator supplies. Additional operator controls must state this limitation.

One transaction must check ownership, eligibility revision, funding, debt, concurrency and every
applicable individual/global balance; create the hold; and enqueue threshold crossings.
Settlement likewise updates all original scopes and alerts atomically. Preserve durable 50/80/95%
alerts and their delivery idempotency. Reporting `ai_usage` and Amplitude are not admission sources.
Do not split global free pools into independently admitted cohort or service-local balances.

## Migration and rollback

1. Freeze policy fixtures and add backward-compatible metadata and database ownership fencing.
   Shadow pricing and decisions only; shadow mode cannot dispatch, reserve, settle or send alerts.
2. Establish caller-persisted round IDs and service authentication. Exercise the HTTP adapter while
   the C++ ledger remains authoritative. Do not operate two admission authorities during this step.
3. Pause admission, inventory unresolved calls and funding/outbox positions, and drain active sends
   where possible. Transfer the entire ledger writer ownership in one fenced transaction.
4. Start Rust admission with the new ownership epoch after the explicit durable-mode enablement
   decision. Every hosted execution path, including background work, routes through that authority
   before reopening. Default-disabled legacy traffic is not silently migrated to durable policy.
5. Observe accounting parity, fault recovery and alert delivery; remove obsolete credentials and
   writers only after the rollback compatibility window is explicitly closed.

Store an ownership epoch and require every accounting mutation, event application, dispatch claim,
reconciliation and alert claim to validate it in the same transaction. Database permissions and
fenced functions must enforce this; a caller-supplied epoch or application flag alone is insufficient.
An epoch cannot revoke an already authorized external send. During handover, terminate or drain old
executors and preserve every consumed dispatch claim as possibly spent; never redispatch those IDs.
Imported reservations may lack provider, price-version and usage evidence. Mark their provenance
as legacy/unknown; never invent evidence or reprice them with current rates. Preserve their original
holds, periods, offers and debt. Late legacy usage enters a restricted, idempotent reconciliation
path through the sole fenced writer. A temporary compatibility permission accepts original legacy
settlement amounts only for imported reservation IDs, preserving liabilities and recording available
evidence/provenance; it cannot create new reservations. Missing usage stays uncertain, and no legacy
process retains direct settlement access or reprices old calls with the Rust catalog.
All global pools stay under the same writer. Product-by-product transport rollout is acceptable only
while both paths reach that single authority, not separate accounting writers.

Rollback pauses admission, fences Rust, increments the epoch and hands the same current ledger to
an explicitly compatible C++ release. Preserve new holds, attempts, debt, revisions and evidence.
Never restore a stale balance snapshot or downgrade to legacy unmetered execution on failure.
If C++ cannot interpret newly written states, drain/reconcile them or deploy a compatibility release
before rollback. Uncertain executions remain held through either direction of transfer.

## Privacy, observability and acceptance

Keep prompts, messages, tools/results, generated content and audio in bounded process memory only.
Disable body capture, content-bearing exception messages, proxy buffering to disk and core dumps.
Accounting identifiers belong in access-controlled durable records, not analytics dimensions.
Retain metadata under an explicit operational retention policy; no customer-content fingerprint is
required for idempotency. Restrict reconciliation access and audit its bounded reason and actor.

Every mutation emits one structured operation/product/door/outcome/duration record. Unexpected
transport, storage, parsing and settlement failures report to Sentry under static operation names;
expected budget refusals do not create Issues. Metrics include held/uncertain age, settlement lag,
projection lag, debt, denied admissions and writer-fence failures using bounded labels.
Products own user-visible flow events through `POST /v1/events`; the service ships no Amplitude key.
Document ownership of each failure/event in the backend and service observability docs before shipping.

Acceptance requires policy golden fixtures plus Postgres concurrency and fault tests: simultaneous
rounds across products/devices, free-pool contention, binding, grant precedence, period rollover,
covered variance, debt, duplicate funding, missing revisions and restrictive-change fences.
Inject crashes before/after reserve commit, dispatch claim, provider acceptance, final usage,
settlement commit and outbox acknowledgement. Include partial streams, missing usage, cancellation,
lost HTTP responses, conflicting retries, price changes and stale workers across both cutovers.
Verify no duplicate dispatch authorization, no released ambiguous hold, no double grant/settlement,
no leaked content and no unobserved unexpected failure. Rehearse rollback with unresolved calls.
Run local end-to-end Coach, tending and Echoes with logs, Sentry and events inspected; demonstrate
attestation/audio/refund gates remain closed. No implementation or runtime tests accompany this spec.

## Discussion and structure observations

Decide before implementation: authentication mechanism; restrictive-change handshake ownership;
metadata retention; evidence sufficient for irrecoverable uncertainty; cancellation on disconnect;
separate operator ceilings and priority policy; and the rollback compatibility window.
Do not bundle audio pricing, anonymous rollout, refunds or customer UI redesign into extraction.

Use a small proposed Rust layout: `main.rs` for composition, `domain.rs` for money/policy/state,
`execution.rs` for the ordered execution pipeline, `postgres.rs` for transactional persistence,
`http.rs` for the internal boundary, and `provider/` for provider-specific request/pricing/usage logic.
Keep port definitions with their data; inject clocks, repositories and provider execution. Add files
when distinct consumers or responsibilities justify them. Mirror this layout in tests; avoid a
generic agent framework or dependency/version commitments before implementation review.

The existing global lock gives a clear initial correctness boundary. Preserve it during extraction
and measure contention before optimizing. Durable transport IDs and immutable evidence are the
highest-value structural additions. Review this proposal, revise its contracts, implement one
bounded phase, then simplify/refactor, adversarially review and verify before any deployment.
