# USD AI allowances

`AI_ALLOWANCES_ENABLED=false` is the default. The enabled backend has durable USD admission,
funding, installation binding and operational alerts. Anonymous Gym onboarding uses a separate
server-issued installation credential, network limits and the shared free budgets. Journal voice
still needs audio accounting. Internal money is integer nano-USD; HTTP
amounts are exact decimal USD strings.

## Policy

| Tier | Individual allowance | Period | Shared spending controls | Concurrent calls |
| --- | --- | --- | --- | --- |
| Anonymous | $0.05 per authenticated installation | Lifetime | Free pool: $100 per UTC calendar month and $5 per UTC day | 1 |
| Verified logged-in | $0.25 per account, including associated anonymous usage | UTC calendar month | The same free monthly and daily pools | 1 |
| Windmill One | $7 per funded account period | Paid subscription billing period; owner grants use UTC calendar months | The funded grant itself | 2 |

Every hosted AI call debits the individual allowance, including background Journal processing.
Account balances are shared across devices and products. Paid calls draw only from a funded grant;
they cannot drain either free pool. There is no further generic service-wide monthly cap. Admission
checks estimated reservations against the free pools or funded grant; estimates are not hard
spending ceilings, and actual cost can exceed them. The process-hour fuse and product burst limits
are additional safeguards.

An authenticated installation can be permanently bound to one verified account through
`POST /v1/ai/installations/bind`. The installation cannot receive further anonymous admission after binding. Its anonymous settled cost
from the current month contributes to that account's free allowance; unresolved holds and debt
remain attributable across boundaries. Binding does not erase device lifetime usage, mint another
allowance or move costs into a paid grant. An attempted rebind to another account is refused.

## Configuration and funding

| Setting | Default |
| --- | --- |
| `AI_ALLOWANCES_ENABLED` | `false` |
| `AI_INSTALLATIONS_ENABLED` | `false`; controls anonymous issuance and generation, not existing identity or binding |
| `AI_INSTALLATION_IP_HMAC_KEY` | required private key of at least 32 bytes when installations are enabled |
| `AI_INSTALLATION_PROXY_MODE` | `direct` locally; fixed `cloudflare` in production Compose |
| `AI_INSTALLATION_ISSUES_PER_DAY` | `10` per network per UTC day |
| `AI_INSTALLATION_GENERATIONS_PER_HOUR` | `30` per network per UTC hour |
| `AI_ANONYMOUS_LIFETIME_USD` | `0.05` |
| `AI_LOGGED_IN_MONTHLY_USD` | `0.25` |
| `AI_ONE_PERIOD_USD` | `7` |
| `AI_FREE_MONTHLY_USD` | `100` |
| `AI_FREE_DAILY_USD` | `5` |
| `COACH_MAX_OUTPUT_TOKENS` | `2000` |

Amounts are parsed at startup without floating-point conversion. Negative, malformed or
out-of-range amounts are invalid. A zero free budget closes that budget. Funded grant amounts must
be positive. Enabled mode requires `RESEND_API_KEY` and `AI_ALLOWANCE_ALERT_EMAIL`; the latter must
name one address in `WINDMILL_OWNER_EMAILS`.

Coach sends at most `COACH_MAX_OUTPUT_TOKENS` per model round, default 2,000. In enabled mode,
the locked budget transaction chooses the largest affordable output cap between 1,024 and that
configured maximum, reserving the full selected output cost plus the conservative input estimate.
The 1,024-token floor is Coach policy, not a provider API minimum. Insufficient capacity for that
floor refuses dispatch. Configuration accepts only decimal integers from 1,024 through 8,000;
invalid values refuse startup. The model remains Opus 5. A provider response
that reaches the output cap is a failed generation with its incurred usage reconciled and any
durable routine receipts retained.
Routine setup offers only its eight relevant history, notes, catalog, routine and clarification
tools. This reduces repeated input while preserving the conservative request estimate; ordinary
Coach conversations retain the full tool catalog.

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

Every vendor round estimates input tokens from its actual request and reserves the estimated input
cost plus the full output cap sent to the provider. Coach alone opts into an adaptive cap: its
provider-neutral input cost, output-token price, minimum and maximum travel into the same locked
admission transaction. The domain selects capacity from all applicable balances after checking
funding, debt, device binding and concurrency; no refusal/retry or balance preflight authorizes a
call. Other products retain their configured maximum. Every round has a server-minted reservation id.
Only the first successful durable dispatch claim authorizes sending it. Replaying admission
returns its original subject, period, grant and selected cap. The original cost offer is persisted;
a different offer conflicts even when it could produce the same amount. Replaying dispatch cannot
authorize another send.
All provider spending, including background calls, uses this admission path.

Complete supported usage settles once at actual cost. A lower actual cost releases the unused
reservation. For a higher actual cost, the settlement transaction checks whether the extra cost
fits every original funding budget, with other unresolved holds retained and no existing debt.
Free calls check their original individual, monthly and daily budgets; a bound anonymous call also
checks the account's attributed usage. Paid calls check their pinned grant. A covered underestimate
records full actual spend and releases the hold without debt or a Sentry Issue.

If any applicable budget cannot cover the variance, full actual spend is still recorded and the
entire actual-minus-reservation amount becomes persistent overrun debt, with a static settlement
failure report. It is not automatically forgiven. An explicit internal reconciliation operation
can clear that liability while retaining actual spend. Periods and grants remain pinned: a new
month or grant does not fund an old call. Historical debt and in-flight calls continue to affect
admission after a new funded period begins. Replaying settlement changes and reports nothing.

An ambiguous send, partial stream, missing usage or accounting failure retains its reservation.
A restart never releases such a call automatically. Only an undispatched reservation may be
released without known usage.

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

Anonymous Gym Coach previews use the authenticated installation path described below, and so does
a phone Coach turn opened under an installation credential: every round of a turn (operation
`turn`) reserves against the installation's lifetime allowance, or against the account's when a
session opened it. Anonymous roadmap composition remains `compose-unavailable`; it is not wired to
this credential.
Journal voice returns `unsupported_ai_pricing`: compressed upload size is not a
verified audio duration/token bound, and audio/text prices need separate accounting.

The supported Claude model allowlist matches `AiUsage.cpp`. Unknown models, unsupported pricing
options, server tools and one-hour cache writes refuse admission. Each vendor round locally
estimates the tokens in its actual system prompt, messages, history, tools, results and images.
The estimate is:

`ceil(counted UTF-8 text and JSON structure bytes / 3) + 32 + 8 × message count + tool overhead + image tokens`

Tool overhead is 350 tokens when custom tools are present. The counter includes every request
field: system and message text, history, tool definitions/input schemas/results, model,
`max_tokens`, thinking settings and `output_config`, including its format schema. JSON structure
is approximated rather than measured as exact serialized wire bytes. Only image `source.data`
base64 is excluded from the byte count. Each supported JPEG/PNG base64 image adds a fixed visual
estimate: 1,568 tokens for Opus 4.6, Sonnet 4.6 and Haiku 4.5, and 4,784 for other supported models.
There is no image-dimension parser. These are local heuristics, not an official or exact token count.

A supported five-minute ephemeral cache marker prices all estimated input at the cache-write
rate; without one, the ordinary input rate applies. The input estimate retains the complete
original request, including its maximum-token digit width, when Coach reduces `max_tokens`.
The selected output cap is reserved in full and copied into the dispatched body. Manual thinking
budgets do not support this adaptation. Malformed request/message/tool/image/cache shapes and estimates above
one million input tokens refuse admission. The counter also bounds text/structure bytes, traversal
depth and node count. Image URLs, file references, documents and malformed base64 are unsupported.
There is no universal full-context reservation.

This is approximate admission, not a hard spending ceiling. Actual usage replaces the estimate at
settlement. Available original funding absorbs a covered underestimate; an unfunded overrun
creates debt that blocks further admission until reconciled. Missing or ambiguous usage retains
the hold. A positive remaining balance still does not promise that a particular request can fit.
For example, an Opus 5 request with an 8,000-token output cap reserves $0.20 for output alone,
exceeding the $0.05 anonymous lifetime allowance.
Anonymous previews use Sonnet 5 with a bounded input, one provider request and an affordable
output cap. Signed-in Coach uses Opus 5. Audio requires its own supported accounting.

## Installation credentials and network admission

`platform/ai_installations/` owns credential issuance, strict HTTP resolution and durable network
admission. `POST /v1/ai/installations` accepts an empty JSON object with no account or installation
credential and returns 201 with `credential`, `bound:false` and the existing USD `allowance` object.
The secret has 256 bits of cryptographic randomness; only its SHA-256 digest is stored. The client
keeps it in its separate secure credential store. A client UUID never establishes the principal.

`X-Windmill-Installation` carries exactly one opaque credential. Duplicate, malformed or unknown
values return 401 `invalid_installation`; issuance never replaces an existing invalid credential.
A valid credential already present at issuance returns 409 `installation_already_present`.
Every account credential line is resolved strictly before an installation request is served:
invalid, conflicting or duplicate account credentials return 401 `unauthenticated`, never anonymous
access. `GET /v1/ai/installations/current` returns `bound` and the lifetime USD allowance.

`POST /v1/ai/installations/bind` requires a verified live account credential and the installation
credential. It returns `bound:true` and the account USD allowance. Same-account retries are
idempotent. Another account returns 409 `installation_bound`; this does not invalidate ordinary
account login or change the binding. The supported native sign-in flow binds before it enables
account Coach. A missing installation signal cannot be reconstructed on arbitrary account calls.
All installation responses are `Cache-Control: no-store` and expose no account identifier.

Production trusts exactly one valid `CF-Connecting-IP` only behind the existing Cloudflare-only
Caddy gate. The backend port is not published outside the private Compose network. HTTPS
installation mode refuses direct-proxy configuration. Local direct mode reads the socket peer and
refuses forwarded identity headers. Empty, duplicate, malformed or ambiguous identity never gets
an unlimited bucket. IPv4 and IPv4-mapped IPv6 share the same key; native IPv6 aggregates by /64.
Network identifiers are HMAC-SHA256 digests keyed with `AI_INSTALLATION_IP_HMAC_KEY` and separated
by operation and UTC window. Raw addresses, prefixes, digests and credentials never enter telemetry.

Installation HTTP work runs in a bounded worker queue, away from socket event loops.
Issuance and generation counters are atomic durable writes. Generation admission has one
installation/request replay key and is called only after the product's durable generation claim;
HTTP replay cannot consume a second rate slot or dispatch again. The expiry sweep removes network
counters and their replay keys hourly, and new admission also collects expired rows. Digest keys
expire at their UTC day/hour boundary and survive at most one additional scheduled hour while the
service runs. Product generation tombstones independently prevent redispatch after network-key
expiry. The installation credential digest, its budget ledger and permanent binding remain for
lifetime accounting. Account erasure does not remove that binding or reopen anonymous admission;
it leaves an opaque account ID in the accounting relation, without email or other profile content.

`AI_INSTALLATIONS_ENABLED` requires enabled USD allowances and the private network key. When false,
new installation issuance and anonymous generation return 503 `anonymous_ai_unavailable`.
Existing credential authentication, allowance reads, account binding and saved result recovery remain
available while USD allowances are enabled, without requiring the network key. This keeps signed-in
Coach available after anonymous access is disabled. Network limits return 429
`installation_rate_limited`. Unexpected storage failures return bounded accounting failures and
report static Sentry operations. Network limits complement the individual $0.05 and shared $5/day
and $100/month budgets; a reset installation is not guaranteed to be recognizable.

## Read and refusal contracts

`GET /v1/ai/allowance` requires a live authenticated account and applies strict handling to every
received credential line. It returns 401 for invalid credentials, 503 `ai_allowance_disabled` when
the feature is off, and 503 `ai_accounting_unavailable` for an accounting read failure. Responses
are `Cache-Control: no-store`. Anonymous installation reads use their separate credential endpoint.

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

- Installation identity and account binding remain available independently of anonymous admission.
  An absent network key selects identity-only service construction; an enabled admission mode
  requires a valid key. Operational shutdown can stop new spending without blocking account recovery.
- The server-issued installation credential is an abuse signal, not physical-device attestation.
  Losing or deliberately discarding it cannot be detected reliably; network and global budgets
  bound that exposure. Do not claim reset-proof identity.
- Keep per-round token estimation separate from exact USD settlement. Check estimates against
  actual usage; let original funding absorb covered variance while retaining unfunded overrun
  debt and ambiguous holds. Do not promise a hard cost ceiling. Choose model/output settings that
  can fit the intended tier. Audio needs supported accounting.
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
