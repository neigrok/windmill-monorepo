# Windmill pricing — USD AI allowance

The design contract covers one shared account and one Windmill One plan across roadmap, journal
and gym. The products remain useful without paid AI assistance. This is the approved allowance
policy; the USD backend is off by default and customer rollout remains blocked. The current
implementation and blockers are in [AI usage review](../../../AI_USAGE_REVIEW.md).

## What spends the allowance

**Every hosted AI call spends the individual's USD allowance**, including roadmap assistance,
Coach questions, supported transcription and automatic Journal processing. Manual writing,
editing, reading, on-device search and workout logging do not themselves incur AI cost. If an
entry triggers hosted background processing, that processing uses allowance even though saving
and reading the entry remain available.

**Existing Echoes remain complete and readable.** Reading them incurs no new AI cost. Creating
or repairing Echoes consumes allowance and waits when the applicable capacity is unavailable.
Do not crop existing passages, lock them behind a subscription or describe new processing as
exempt from the individual's balance.

Anonymous calls require a verified device identity. The enabled backend refuses public text
import before dispatch while that identity is unavailable; it must not silently bypass allowance
admission. Audio also remains closed in enabled mode until its accounting bound is supported.

## The unit: USD

Show **USD**, with exact amounts from the server and enough precision to make small usage visible.
Raw tokens and credits are not the customer unit. A fixed dollar balance does not promise a
number of messages, requests, words or minutes.

Each request reserves estimated input cost plus its full output cap sent to the provider. This is a pending
amount, not a final price or guaranteed spending ceiling. Actual usage settles the amount;
unused capacity returns, while an overrun remains fully accounted for.

| Tier | Individual allowance | Period |
| --- | --- | --- |
| Anonymous | $0.05 per verified device | Lifetime; no reset |
| Verified logged-in | $0.25 per account, including associated anonymous usage from the current month | UTC calendar month |
| Windmill One | $7 per funded account period | Subscription billing period; owner grants use UTC calendar months |

The two free tiers share $100 per UTC calendar month and $5 per UTC day. Paid calls use only their
funded grant. An active subscription grant takes priority over an owner grant; balances never
combine. Unused subscription availability crosses calendar boundaries until its billing period
ends. Reserved or uncertain calls retain their liability. A verified device permanently binds to
one account on sign-in and cannot receive further anonymous admission.

Free principals can have one in-flight AI call; paid principals can have two. These are separate
from allowance amounts and product burst limits. The backend's disabled mode retains its legacy
rolling guardrail; customer USD screens must not relabel that data as the new allowance.

## Availability and management

**Nothing is on sale.** `paidPlansOpen()` is false and the backend checkout endpoint refuses even
when a funding price is configured. No current screen offers checkout, token packs, top-ups or a
plan purchase. The settings entry is **AI usage** while purchasing is closed; **Plan & usage** is
the proposed paid-management destination.

Effective access and billing status are separate: an owner grant can provide One without a
Paddle subscription. Subscription status alone does not fund an allowance; a verified successful
payment funds its supported billing period. Failed reads are unavailable data, never Free or zero
use. Renewal amounts, payment details, invoices and self-service cancellation need their own
customer contracts before controls can ship. The documented support route for cancellation is
email to `hello@windmill.works`.

A design fixture is not a live offer. If sales open, show the price and tax basis, seller of
record, cancellation path and applicable refund terms where payment is requested.

## The page

Lead with the individual's allowance and the work it covers. Keep one shared meter and a compact
activity list grouped into the user-facing products. Include hosted background processing in its
USD use. Show used, held and remaining amounts without exposing shared pool totals.

A receipt shows the work, its outcome and its USD use. A request refused before dispatch incurs
no AI cost; a failed or stopped request may have performed model work. An uncertain call keeps
its reservation until reconciled. Missing usage is a calm unavailable state with Retry, never a
zero meter.

When capacity is unavailable, pause new hosted AI work without withdrawing existing work or
manual editing. Distinguish a spent individual allowance, a request too large for the remaining
balance, a shared free pool pause and an in-flight call limit. Use the refused budget's supported
reset metadata: a daily free-pool pause concerns the next UTC day, not the account's next month.
Anonymous lifetime allowance has no reset. Never invent a countdown or push an unavailable
upgrade; a reset timestamp does not promise that uncertain holds disappear then.

Desktop keeps allowance and activity in one readable column with secondary account details.
Phone stacks them, uses list receipts, and keeps controls above the safe area. Example data is
explicitly marked. Terracotta belongs to action; gold is a quiet low-allowance cue; brick stays
reserved for deletion. No urgency, tier ladder, or manufactured savings.

## Related design contracts

- [Plan and usage proposal](../../subscription-usage-proposal.md): account boards and API gaps.
- [Roadmap AI assistance](../../roadmap/guidelines/ai-assistance.md): request, result and failure principles.
- [Journal](../../journal/journal.md): complete Echoes and background processing.
