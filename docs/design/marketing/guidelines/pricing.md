# Windmill pricing — active AI assistance

The commercial design contract covers one shared account and one Windmill One plan across
roadmap, journal and gym. The products remain useful without paid AI assistance.

## What spends the allowance

**Only AI work the user actively asks for spends their AI credits.** Roadmap assistance,
Coach questions and Talk transcription are active requests. Ordinary writing, editing, reading,
search and workout logging do not spend credits.

**Automatic Echoes are included.** Creating and reading passive connections between journal
entries does not spend the user's AI allowance. Echoes has no allowance-saving disable control,
paid preview, or subscription lock. Operational limits on background processing belong to the
service and must not be presented as a user credit balance.

Public text-to-tree import is currently recorded without an account. Its account attribution
must be designed before it can debit a signed-in user's credits; do not promise that it already
does. The implementation inventory is [AI usage review](../../../AI_USAGE_REVIEW.md).

## The unit: AI credits

Show **AI credits**, not raw tokens or provider costs. One credit represents a fixed amount of
cost-weighted active AI work, with the same value on every plan. Larger allowances contain more
credits; they never change a credit's value. Work can use fractions of a credit. A credit does
not mean one message, one request, one word, or one minute.

The design proposal uses 200 base credits and 400 One credits only as sample data. Neither those
quantities nor a commercial conversion rate is approved. Do not publish them as plan benefits.
Do not define a credit as a percentage of whichever plan the viewer holds.

The implemented account guardrail uses a trailing 30-day window. A credits design matching that
window explains that capacity returns as older active usage leaves it. There is no single
monthly reset date. Subscription billing dates are separate. The legacy roadmap request counter
is an implementation constraint under redesign, not a product plan or a credit conversion.

## Availability and management

**Nothing is on sale.** `paidPlansOpen()` is false; the checkout endpoint also refuses when
Paddle is not configured. No current screen offers checkout, token packs, top-ups or a plan
purchase. The settings entry is **AI usage** while purchasing is closed; **Plan & usage** is the
proposed paid-management destination.

Effective access and billing status are separate: an owner grant can provide One without a
Paddle subscription. Failed reads are unavailable data, never Free or zero use. Subscription
renewal amounts, payment details, invoices and self-service cancellation require their own
backend contracts before controls can ship. The documented support route for cancellation is
email to `hello@windmill.works`.

No price, credit quantity or renewal date in a design fixture is a live offer. Final commercial
terms require an explicit product decision. If sales open, show the price and tax basis, seller
of record, cancellation path and applicable refund terms where payment is requested.

## The page

Lead with the user's allowance and the work it covers. Keep one shared meter and a compact
activity list of active requests, grouped into the user-facing products. Explain passive Echoes
with a quiet **Included · No credits used** line, outside the charged activity breakdown.

A receipt shows the request, its outcome and its credit use. A request refused before it starts
uses no credits; a failed request may have performed model work, so do not promise every failure
is free. Missing usage is a calm unavailable state with Retry. Never substitute a zero meter.

When allowance is exhausted, pause active AI requests without withdrawing existing work or
manual editing. Use a factual message and the known restoration information; never invent a
countdown or push an unavailable upgrade. A fixed balance cannot promise an exact number of
future requests because their work varies.

Desktop keeps allowance and activity in one readable column with secondary account details.
Phone stacks them, uses list receipts, and keeps controls above the safe area. Example data is
explicitly marked. Terracotta belongs to action; gold is a quiet low-allowance cue; brick stays
reserved for deletion. No urgency, tier ladder, or manufactured savings.

## Related design contracts

- [Plan and usage proposal](../../subscription-usage-proposal.md): boards, credit fixtures and API gaps.
- [Roadmap AI assistance](../../roadmap/guidelines/ai-assistance.md): request, result and failure principles.
- [Journal](../../journal/journal.md): included passive Echoes.
