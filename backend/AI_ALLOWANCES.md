# USD AI allowances

`AI_ALLOWANCES_ENABLED=false` is the default. The enabled backend has durable USD admission,
funding, device binding and operational alerts. Customer rollout remains blocked by conservative
provider reservations, missing device attestation and missing audio accounting. Internal money is
integer nano-USD; HTTP amounts are exact decimal USD strings.

## Policy

| Tier | Individual allowance | Period | Shared spending controls | Concurrent calls |
| --- | --- | --- | --- | --- |
| Anonymous | $0.05 per verified device | Lifetime | Free pool: $100 per UTC calendar month and $5 per UTC day | 1 |
| Verified logged-in | $0.25 per account, including associated anonymous usage | UTC calendar month | The same free monthly and daily pools | 1 |
| Windmill One | $7 per funded account period | Paid subscription billing period; owner grants use UTC calendar months | The funded grant itself | 2 |

Every hosted AI call debits the individual allowance, including background Journal processing.
Account balances are shared across devices and products. Paid calls draw only from a funded grant;
they cannot drain either free pool. There is no further generic service-wide monthly cap. Aggregate
admitted exposure is bounded by the free pool plus the sum of funded grants. The process-hour fuse
and product burst limits are additional safeguards.

A verified device can be permanently bound to one account through an internal service operation.
The device cannot receive further anonymous admission after binding. Its anonymous settled cost
from the current month contributes to that account's free allowance; unresolved holds and debt
remain attributable across boundaries. Binding does not erase device lifetime usage, mint another
allowance or move costs into a paid grant. An attempted rebind to another account is refused.

## Configuration and funding

| Setting | Default |
| --- | --- |
| `AI_ALLOWANCES_ENABLED` | `false` |
| `AI_ANONYMOUS_LIFETIME_USD` | `0.05` |
| `AI_LOGGED_IN_MONTHLY_USD` | `0.25` |
| `AI_ONE_PERIOD_USD` | `7` |
| `AI_FREE_MONTHLY_USD` | `100` |
| `AI_FREE_DAILY_USD` | `5` |

Amounts are parsed at startup without floating-point conversion. Negative, malformed or
out-of-range amounts are invalid. A zero free budget closes that budget. Funded grant amounts must
be positive. Enabled mode requires `RESEND_API_KEY` and `AI_ALLOWANCE_ALERT_EMAIL`; the latter must
name one address in `WINDMILL_OWNER_EMAILS`.

Subscription funding is accepted only through a verified, successfully completed payment event
for the configured `PADDLE_PRICE_ID`. The supported event describes one positive, fully paid,
non-prorated monthly One line, with a captured payment and an explicit billing period. Customer,
subscription, price and account bindings must agree. A subscription status or entitlement alone
does not fund an allowance. Missing account mirrors receive a retryable refusal.

Each grant carries its source, account, funded period, amount and funding reference. Duplicate
funding is idempotent; grants cannot overlap within the same account and funding source. An owner
accessing the allowance receives a $7 calendar-month grant when no subscription grant is current.
An active subscription grant takes precedence over an owner grant; their remaining amounts are
never combined. An expired subscription period does not prevent the owner's calendar fallback.
Unused subscription capacity survives a calendar-month boundary and expires at its funded period
end. Expiry never releases unresolved calls or forgives their debt. Checkout remains closed even
when the funding price is configured.

## Admission and accounting

`AiBudgetService` owns boundary observations; `PgAiBudgetRepository` serializes reservation,
concurrency, funding, binding and threshold writes. A free reservation requires sufficient
individual, free-month and free-day capacity. A paid reservation requires a live grant with enough
capacity. In-flight reservations, dispatched calls and uncertain calls occupy the principal's
concurrency slots across tier changes and device binding.

Every vendor round has a server-minted reservation id. Only the first successful durable dispatch
claim authorizes sending it. Replaying admission returns its original subject, period and grant;
replaying dispatch cannot authorize another send. All provider spending, including background
calls, uses this admission path.

Complete supported usage settles once. An ambiguous send, partial stream, missing usage or
accounting failure retains its reservation. A restart never releases such a call automatically.
Only an undispatched reservation may be released. Known actual cost above its reservation is
recorded in full and creates persistent debt. An internal reconciliation operation clears that
overrun liability while retaining actual spend. Historical principal debt and in-flight calls
continue to affect admission after a new funded period begins.

Budget occupancy includes settled cost plus held reservations. Crossings of 50%, 80% and 95% are
written to a durable outbox in the same transaction as their budget change. Each scope, budget
period and threshold has one alert identity. Worker claims are leased and acknowledged by token;
failed delivery is retried. Emails go to the configured owner and contain bounded scope, funding
source, threshold and USD totals, without account/device identifiers or user content. Delivery is
at least once; the provider receives a stable idempotency key.

## Provider coverage and rollout limits

Enabled mode covers each Claude round in gym Coach, roadmap tending and Journal segmentation and
curation. Expected background budget refusals leave work due and report a bounded deferred outcome,
without a Sentry Issue. Roadmap's customer request-count quota is disabled in this mode; its read
contract names USD and links the shared allowance endpoint.

Anonymous roadmap composition returns `compose-unavailable` before dispatch because no verified
device identity is available. The internal device binding API does not expose an attestation or
grant endpoint. Journal voice returns `unsupported_ai_pricing`: compressed upload size is not a
verified audio duration/token bound, and audio/text prices need separate accounting.

The supported Claude model allowlist matches `AiUsage.cpp`. Unknown models, unsupported pricing
options, server tools and one-hour cache writes refuse admission. Reservation currently charges a
full one-million-token input bound at the five-minute cache-write rate, plus the request's
`max_tokens` output cap. This covers image and tool overhead without estimating tokens from image
bytes. A 16,000-output-token call reserves $6.65 for Opus 5 or $2.66 for Sonnet 5.

**Those reservations cannot fit either free individual allowance.** The enabled implementation is
therefore not ready for free customer rollout. A tighter proven provider input bound, including
images and tool schemas, is required; a token-count estimate alone is not treated as a hard bound.
A positive remaining balance does not promise that a particular request can fit.

## Read and refusal contracts

`GET /v1/ai/allowance` requires a live authenticated account and applies strict handling to every
received credential line. It returns 401 for invalid credentials, 503 `ai_allowance_disabled` when
the feature is off, and 503 `ai_accounting_unavailable` for an accounting read failure. Responses
are `Cache-Control: no-store`. Device reads remain closed pending attestation.

The response carries tier, period, configured state, bounded code, limit, used, reserved, remaining,
`resetsAtMs`, `budgetResetsAtMs` and availability status. Period is `lifetime`, `calendar_month_utc`
or `billing_period`; a lifetime allowance has a null individual reset. `budgetResetsAtMs` identifies
the exhausted free day/month or individual period, so a daily free-pool pause is not presented as
an individual monthly reset. It does not guarantee that unresolved holds will be released then.
Neither endpoint nor telemetry exposes aggregate budget amounts.

Coach JSON and SSE preserve expected allowance refusal codes and metadata. A request too large
for positive remaining capacity is distinguished from a fully used allowance. Stored generations
carry `allowanceRefusal` as a historical refusal snapshot; an accepted retry clears it, while a
refused retry updates it. The same failed request id may retry after capacity recovers.

Coach SSE uses the same asynchronous polling flow for both transports. Persistent HTTP/1.1
connections receive incremental snapshots. HTTP/1.0 or a `Connection: close` request waits for
one buffered SSE frame: an error with its status and metadata, or a terminal generation snapshot.
Reconnecting to a running request also waits for a terminal result; it does not return a running
snapshot and close. Both paths invoke the same admission and generation service; an expected
admission refusal sends no provider call.

The `ai_usage` table and existing Amplitude mirror remain reporting surfaces, not the enabled
admission authority. Disabled mode retains the legacy trailing account/passive windows and product
request quotas. Enabling the durable ledger does not invent reservations for earlier usage rows.

## Structure observations and remaining work

- Keep the unverified device edge closed. Attestation must establish a durable lifetime identity,
  preserve it across supported reinstalls and securely bind it to the verified account.
- Replace the provider full-context bound before free rollout; do not weaken the ledger to hide
  requests that cannot fit. Audio needs its own verified bound and complete pricing.
- The account, Coach and tending clients need exact USD, held amounts, distinct allowance periods
  and bounded refusal recovery. Figma still contains question and credit figures.
- Subscription and owner grants share one ledger. Nonoverlap is enforced within each source, and
  a current subscription grant takes priority over the owner grant. No subscription-status funding
  fallback should be introduced.
- Refunds, chargebacks and payment adjustments do not revoke or revise a funded grant in this
  implementation. Define and implement those outcomes before enabling paid customer funding.
- The permanent device relation lets account reads include associated anonymous cost without
  copying spend into a second ledger or creating transfer/refund arithmetic.
- Keep connection-specific SSE delivery at the HTTP edge. Buffered and incremental responses
  share the same admission policy, refusal payload and durable generation state.
