# 10 · The weekly recap email

Kind: build, then experiment · Stage: 0 to 1 · Window: build by Dec 15, 2026; test Jan 16 to Mar 15, 2027 · Cash: $0 to $50 a month · CEO hours / agent days: 1h / 2d

## Idea

An optional weekly email that states what a person did in the week, as counts, and links back into
the app: sets logged, pages written, steps completed. It carries no journal text and no workout or
movement names. It is built by Dec 15, 2026 from the email kit in the Marketing Figma file, then
tested from Jan 16, 2027 among consenting accounts against a randomised holdout that receives
nothing.

## Pros

- Honesty-compatible: factual counts, no urgency, one unsubscribe link that works.
- Low production effort once built; agents run it.
- Email is the lifecycle channel we own; iOS push opt-in in Health & Fitness is about 34%.
- A holdout makes the read causal, which no benchmark in this area is.

## Cons

- Inbox fatigue and unsubscribes if the recap says nothing new.
- Consenting accounts are a biased sample of the already engaged.
- Delivery, bounce handling and template upkeep are ongoing costs.
- A retention lift may not reach paid retention.

## Estimates

| Item | Number | Basis |
|---|---|---|
| Cash | $0 to $50 a month | delivery at launch volumes |
| Effort | 1 CEO hour, 2 agent days | design approval and build |
| Readable sample | at least 400 randomised users | assumption for a 5-point lift |
| Comparable | 74% of Lifesum recap recipients returned to the app | Braze 2023 account, no control group; supports testing only |

## Success metric

At least a 5 percentage-point improvement in next-week return across at least 400 randomised users,
with no worse paid retention, by Mar 15, 2027.

## Failure metric

Nonpositive lift, or more than 1% unsubscribe per send. On failure the recap stays optional and
off by default, and no further lifecycle email is built until a different hypothesis exists.
Smaller samples than 400 are inconclusive and decide nothing.

## Justification

Retention is where AI subscriptions break: monthly AI apps keep 6.1% of subscribers after twelve
months against 9.5% for non-AI apps (RevenueCat 2026). A weekly recap is the retention lever with
the best available evidence and the lowest cost. Lifesum's Sunday recap is the comparable, but its
74% return figure comes from a vendor account without a control, so it justifies a controlled test
and nothing more. Push was rejected as the primary channel because opt-in is about a third on iOS
in this category (OneSignal 2024); the app asks for push only after a first win.

## Dependencies

- Email design approved in Figma before an agent implements it.
- Report 02's activation and retention views, so the holdout read is server truth.
- Consent captured in account settings; the recap is off until a person turns it on.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
