# 02 · Task costs, billing and attribution

Kind: build · Stage: 0 · Window: Nov 2 to Nov 16, 2026 · Cash: $0 to $50 · CEO hours / agent days: 3h / 4d

## Idea
Make every later decision measurable before any traffic arrives. Three deliverables: a costed sample
of at least 100 Coach tasks and 100 Tend requests, a reconciled set of 20 billing scenarios, and the
attribution join plus Gym and Journal activation views added beside `backend/db/funnel.sql`.

## Pros
- Grounds the welcome allowance, the free pool and the annual rule in Windmill's own numbers.
- Catches a charged-but-unentitled purchase before a stranger hits it.
- Gives the Monday review its six numbers from day one.
- Separates the onboarding model from the bound-seat model, so the pilot's costs are not misread.

## Cons
- Early workloads come from us and cohort users, so the cost distribution may not be representative.
- Creates no demand on its own.
- Beacon-sourced funnel numbers undercount; server-truth tables stay the denominator.
- Attribution must survive voluntary account creation without fingerprinting, which limits what links can carry.

## Estimates
| Item | Estimate |
|---|---|
| Cash | $0 to $50 of AI spend for the costed sample (assumption) |
| Effort | 3 CEO hours running scenarios; 4 agent days for the ledger, views and scenario harness |
| Outcome | cost per task as mean and P90 for Coach (Sonnet 5 on anonymous seats, Opus 5 on bound seats, retries included) and for Tend; 20 scenarios reconciled across payment, entitlement, AI expense and renewal |

The 20 scenarios: purchase on web and on each store, restore, cross-platform entitlement,
cancellation, refund, renewal, allowance grant, allowance exhaustion, and the charged-but-unentitled
case, which must count zero.

## Success metric
By Nov 16, 2026: at least 99% of AI traffic carries a settled cost, and all 20 billing scenarios
reconcile.

## Failure metric
More than 1% of AI traffic without a cost, or any charged-but-unentitled purchase, after seven days
of pilot use. Paid acquisition (reports 09 and 14) is blocked until this passes.

## Justification
One is $12, Apple's small-business fee leaves $10.20, and full use of the $7 allowance leaves $3.20
before any other cost. With margins that thin, revenue-based return on ad spend is misleading and
only contribution can gate spending (agreed C90 rule in strategy.md). Nobody has measured a Coach
task's cost yet, and heavy AI users cost 50 to 100 times a light user (vendor analysis, 2026), so
arithmetic means and P90 are both needed. The existing funnel views cover Roadmap only; Gym
activation (two sessions of five sets within seven days) and Journal activation need their own views.
The alternative, instrumenting after launch, would spend the Q5 window learning nothing.

## Dependencies
- The event intake at `POST /v1/events` with allowlisted labels; no content ever leaves the device.
- A configured Paddle price id and `AI_ALLOWANCES_ENABLED` on in the pilot environment.
- Report 04's web pilot to exercise the purchase scenarios on real money.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
