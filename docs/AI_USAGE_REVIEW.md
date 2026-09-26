# AI usage and billing

This is the repository's accounting contract. Deployment keys and measured customer usage are
separate. Model names and cost constants are configuration, not verified vendor prices.

## Metered work

| Feature | Operation / configured model | Account treatment |
| --- | --- | --- |
| Roadmap text composition | `compose` / `claude-haiku-4-5-20251001` | Anonymous ledger entry, including signed-in requests; IP/global limits apply. |
| Roadmap AI assistance | `tend` / `claude-sonnet-5` | Active allowance plus a monthly request count; requires a configured adapter and `TENDING_ENABLED`. |
| Gym Coach | `ask` / `claude-opus-5` | Active allowance plus a question refill bucket; no One gate. |
| Journal Echoes segmentation and curation | `echo.segment`, `echo.curate` / `claude-sonnet-5` | Passive operational spend, excluded from the active allowance. |
| Journal Talk | `transcribe` / `gpt-4o-transcribe` | One required; active allowance plus an audio-byte refill bucket. |

Adapters live under each product's `adapters/llm`; [main.cpp](../backend/platform/infra/main.cpp)
composes them with the shared spend sink. The ledger stores user, product, operation, model,
run/iteration, outcome and input/output/cache token counts. Failed calls can carry billed usage.
Interrupted provider streams may contain only partial usage counts.

Journal browser search and the self-hosted Echoes embedder perform local inference without hosted
model token charges. External assistants pay their own model costs; ordinary Windmill MCP calls do
not spend Windmill's hosted-model allowance.

## Limits

| Limit | Repository rule |
| --- | --- |
| Active account AI | Internal cost ceiling of $25 for Free or $50 for One over a trailing 30 days; passive Echo operations excluded. |
| Passive Journal AI | Separate internal $2 ceiling over `echo.segment` and `echo.curate` in a trailing 30 days. |
| Roadmap requests | 30 for Free or 300 for One per UTC calendar month; started runs count even if they fail. |
| Coach questions | Capacity 3, continuously refilled at 10 per day; held in memory. Zero-model-turn failures return the question. |
| Talk audio | 30 MiB bucket refilled per day, at most two concurrent takes per account and eight per process; held in memory. |
| Process safeguard | Internal $20 ceiling over a trailing hour, in memory, across vendor calls. |

Sources: [Entitlements](../backend/platform/application/Entitlements.cpp),
[AI allowance constants](../backend/platform/domain/AiUsage.h),
[roadmap request limits](../backend/products/roadmap/domain/Tending.h),
[Coach admission](../backend/products/gym/application/AskService.cpp),
[Talk admission](../backend/products/journal/adapters/http/VoiceApi.h) and
[process safeguard](../backend/platform/domain/AiFuse.h).

Account allowance checks happen before foreground work. They do not reserve each later model turn.
The process safeguard is checked at the provider boundary. A remaining amount therefore cannot
promise an exact number of future requests. Rolling windows have no single full-reset date.

## Account and billing gaps

- **No shared customer usage response.** `/v1/tending` exposes the roadmap request counter and
  receipts, not account AI spend or Coach/Talk refill state.
- **Checkout is closed.** [paidPlansOpen](../web/src/shell/billing/checkout.js) returns false.
  [BillingApi](../backend/platform/adapters/paddle/BillingApi.cpp) also refuses checkout without
  its configured client and price.
- **Effective access and billing status differ.** `hasWindmillOne` includes an owner-email grant;
  `/v1/subscription` reflects Paddle only. The web
  [EntitlementsProvider](../web/src/shell/billing/EntitlementsProvider.jsx) reads only that response's
  `active` field, so an owner grant can be admitted by the server but hidden in the client.
- **Subscription management is incomplete.** The response has status, identifiers and an optional
  scheduled-change time, but no action kind, billing period, charge amount, payment method,
  invoices or management URL. Cancel/resume/portal routes are absent.
- **Transcription has no supported price entry.** `gpt-4o-transcribe` is absent from
  [AiUsage.cpp](../backend/platform/domain/AiUsage.cpp). Unknown models retain null actual cost and
  use the most expensive known token-rate combination for enforcement.

A shared credit display needs an effective-entitlement response, a customer-safe usage contract,
a transcription cost model, and approved credit conversion and rounding. Product budgets,
top-ups and allocation controls are not implemented. The account design is in
[subscription usage](design/subscription-usage-proposal.md).
