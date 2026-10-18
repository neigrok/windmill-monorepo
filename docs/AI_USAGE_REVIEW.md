# AI usage and billing

[USD AI allowances](../backend/AI_ALLOWANCES.md) is the durable accounting contract, including
policy, funding validation, approximate per-request reservations and rollout requirements.
`AI_ALLOWANCES_ENABLED` defaults to false. Anonymous access still needs attestation and suitable
model/output settings; an Opus 5 output cap of 8,000 tokens alone reserves $0.20, exceeding its
$0.05 lifetime allowance. Audio accounting and customer USD screens also remain rollout work.

## Metered work

| Feature | Operation / configured model | Enabled allowance treatment |
| --- | --- | --- |
| Roadmap text composition | `compose` / `claude-haiku-4-5-20251001` | Refused until a verified anonymous device identity exists. |
| Roadmap AI assistance | `tend` / `claude-sonnet-5` | Individual and applicable free/funded budgets; no separate customer request quota. |
| Gym Coach | `ask` / `claude-opus-5` | Individual and applicable free/funded budgets; technical question burst protection remains. |
| Journal Echoes | `echo.segment`, `echo.curate` / `claude-sonnet-5` | Debits the same individual allowance, including automatic background work. |
| Journal Talk | `transcribe` / `gpt-4o-transcribe` | Refused pending verified audio bounds and audio/text pricing. |

Adapters record supported token counts, product, operation, run/iteration, model and outcome. Failed
calls can carry billed usage. Incomplete usage retains a durable hold. Ordinary MCP operations
performed by an external assistant do not incur Windmill's hosted-model cost. Browser search and
the self-hosted Echoes embedder do not incur hosted-model token charges.

Each vendor round locally estimates tokens for the actual system prompt, messages/history, tools,
results and images, then reserves estimated input cost plus the configured output cap. This does
not guarantee a hard spending ceiling. Actual usage settles the call: unused reservation is
released and underestimates are charged in full. A variance that fits every original funding
budget, including other unresolved holds and bound-device attribution, with no existing debt,
is absorbed without debt or an Issue. Unfunded variance retains overrun debt; ambiguous usage stays
held. New periods do not fund old calls.

## Allowances and funding

- Anonymous: $0.05 per verified device for its lifetime; one in-flight call.
- Verified logged-in: $0.25 per UTC calendar month, including current-month anonymous spending
  associated with the account; one in-flight call.
- Windmill One: $7 per funded subscription billing period; two in-flight calls. Owner access
  automatically funds $7 per UTC calendar month when no subscription grant is current.

Anonymous and free accounts share $100 per UTC calendar month and $5 per UTC day. Paid grants
are isolated from both free pools. All hosted AI work, including background processing, debits the
individual budget. Uncertain liabilities and principal debt survive period and tier changes.
A device-to-account binding is permanent and blocks further anonymous use of that device.

Subscription status alone does not fund usage. A verified, completed positive payment for the
configured monthly One price creates an idempotent grant for its explicit period. Grants cannot
overlap within one account and funding source. A current subscription grant takes priority over an
owner grant; their capacity is never combined. An expired subscription does not block owner
calendar funding. Unused funded capacity can cross a calendar boundary but expires at
the funded period end. Checkout remains closed.

Crossings of 50%, 80% and 95% occupancy in each budget create durable owner-email alerts. They
contain budget scope, funding source and numeric usage only, without user content or identifiers.
The owner recipient and email transport must be configured when enabling allowances.

## Read contract and client gaps

`GET /v1/ai/allowance` exposes USD limit, used, reserved and remaining; tier; lifetime/calendar/
billing period; nullable individual reset; and the constrained budget's reset timestamp. It does
not expose other users or aggregate pool values. Coach JSON/SSE preserve allowance refusals and
retain a historical refusal snapshot in a stored generation. An accepted retry clears that snapshot.

The account and product clients still need this USD contract and the distinction between remaining
capacity and a request that cannot fit. The drawings need lifetime anonymous, monthly free and
funded paid states. A daily free-pool pause must name the daily reset rather than imply that the
user's individual allowance is spent. Verified device endpoints and automatic binding at sign-in
remain closed until attestation is implemented.

## Disabled mode

The existing deployment behavior remains available while the feature is off:

| Control | Rule |
| --- | --- |
| Active account AI | Internal $25 Free / $50 One ceiling over a trailing 30 days. |
| Passive Journal AI | Separate $2 trailing-30-day operational ceiling. |
| Roadmap requests | 30 Free / 300 One per UTC calendar month. |
| Coach questions | Three-question capacity, refilled continuously at ten per day; zero-model-turn failures return the question. |
| Talk audio | 30 MiB daily refill, at most two takes per account and eight per process. |
| Process safeguard | $20 over a trailing hour, held in memory. |

These legacy counters do not reserve each later model turn. They must not be described as the
enabled USD policy. Their data is not backfilled into invented durable reservations.

## Billing and product gaps

The web subscription mirror does not fully represent owner access; effective entitlement and
funded allowance must be loaded independently. Customer billing management still needs confirmed
renewal dates, scheduled actions and supported management routes. No top-up or allowance overage
purchase is available. The [account design](design/subscription-usage-proposal.md) describes the
required customer display without opening checkout.

Funded grants do not yet react to refunds, chargebacks or payment adjustments. Paid customer
activation requires that lifecycle policy and implementation as well as supported billing controls.
