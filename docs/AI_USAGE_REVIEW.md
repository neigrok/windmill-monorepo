# AI usage and billing

[USD AI allowances](../backend/AI_ALLOWANCES.md) is the durable accounting contract, including
policy, funding validation, approximate per-request reservations and rollout requirements.
`AI_ALLOWANCES_ENABLED` defaults to false in configuration and is enabled in production. Anonymous
Gym onboarding uses a separate installation credential and one bounded model call. It requires
`AI_INSTALLATIONS_ENABLED`, durable IP limits and the shared free budgets. Installation resets
are not guaranteed to preserve identity. Customer USD screens remain work.

## Metered work

| Feature | Operation / configured model | Enabled allowance treatment |
| --- | --- | --- |
| Roadmap AI assistance | `tend` / `claude-sonnet-5` | Individual and applicable free/funded budgets; no separate customer request quota. |
| Gym Coach | `ask` / `claude-opus-5` | Individual and applicable free/funded budgets; technical question burst protection remains. |
| Anonymous Gym onboarding | `coach.preview` / `claude-sonnet-5` | Lifetime installation and shared free budgets; one bounded call, public exercises only. |
| Journal Echoes | `echo.segment`, `echo.curate` / the AI service's `medium` class | Never the person's allowance: the AI service's background budgets of Windmill's own ([Echoes on the AI service](foundation/echoes-on-ai-service.md)). |
| Journal Talk | `transcribe` / `gpt-4o-transcribe` | Windmill One grants only: holds the model's $0.06 token ceiling before audio leaves and settles at the tokens the vendor billed, or at that ceiling when a transcript comes back without usage. |

Adapters record supported token counts, product, operation, run/iteration, model and outcome. Failed
calls can carry billed usage. Incomplete usage retains a durable hold. Ordinary MCP operations
performed by an external assistant do not incur Windmill's hosted-model cost. Browser search and
the self-hosted Echoes embedder do not incur hosted-model token charges.

Talk also keeps an in-memory audio ration in both modes: a 30 MiB daily refill, at most two takes
per account and eight per process with the vendor. A take the allowance refuses gives its bytes back.

Each Claude round locally estimates tokens for the actual system prompt, messages/history, tools,
results and images, then reserves estimated input cost plus the full output cap sent to the provider; a
Talk take reserves its transcription model's token ceiling instead. This does
not guarantee a hard spending ceiling. Actual usage settles the call: unused reservation is
released and underestimates are charged in full. A variance that fits every original funding
budget, including other unresolved holds and bound-device attribution, with no existing debt,
is absorbed without debt or an Issue. Unfunded variance retains overrun debt; ambiguous usage stays
held. New periods do not fund old calls.

## Allowances and funding

- Anonymous: $0.25 per installation credential for its lifetime; one in-flight call.
- Verified logged-in: $0.50 per UTC calendar month, including current-month anonymous spending
  associated with the account; one in-flight call.
- Windmill One: $7 per funded subscription billing period; two in-flight calls. Owner access
  automatically funds $7 per UTC calendar month when no subscription grant is current.

Anonymous and free accounts share $100 per UTC calendar month and $5 per UTC day. Paid grants
are isolated from both free pools. All hosted AI work, including background processing, debits the
individual budget. Principal debt survives period and tier changes, and so does an uncertain
liability until it lapses, released at zero 10 minutes after its admission.
An installation-to-account binding is permanent and blocks further anonymous use of that credential.

Subscription status alone does not fund usage. Each paid production store period the subscription
feed carries funds one idempotent grant for that period, its reference the period's id
(`docs/foundation/subscriptions.md` §6.3). Grants cannot overlap within one account and funding
source: a period that starts inside a grant the account holds is funded from that grant's end. A
refund closes the period's grant at the refund time and keeps what was spent; its reversal reopens
it. A current subscription grant takes priority over an owner grant; their capacity is never
combined. An expired subscription does not block owner
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
user's individual allowance is spent. Installation reads use `GET /v1/ai/installations/current`;
verified sign-in binds with `POST /v1/ai/installations/bind`. The native client retains its credential
across sign-out. A caller that erases or omits the signal cannot be associated with it by this mechanism.

## Disabled mode

The existing deployment behavior remains available while the feature is off:

| Control | Rule |
| --- | --- |
| Active account AI | Internal $25 Free / $50 One ceiling over a trailing 30 days. |
| Passive Journal AI | Separate $2 trailing-30-day operational ceiling. |
| Roadmap requests | 30 Free / 300 One per UTC calendar month. |
| Coach questions | Three-question capacity, refilled continuously at ten per day; zero-model-turn failures return the question. |
| Process safeguard | $20 over a trailing hour, held in memory. |

These legacy counters do not reserve each later model turn. They must not be described as the
enabled USD policy. Their data is not backfilled into invented durable reservations.

## Billing and product gaps

`GET /v1/subscription` says whether the account holds Windmill One, an owner's included
(`windmillOne`); the funded allowance is read separately from the allowance route. Customer billing management still needs confirmed
renewal dates, scheduled actions and supported management routes. No top-up or allowance overage
purchase is available. The customer usage display is undrawn in its current policy
([consistency ledger](design/consistency.md) 6u).

Paid customer activation still requires supported billing controls.
