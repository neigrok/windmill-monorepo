# 03 · Fund free demonstrations reliably

Kind: build · Stage: 0 · Window: Nov 2026 to Jan 15, 2027 · Cash: the AI reserve ($200 to $300 in Stage 0, $300 to $1,000 in Stage 1) · CEO hours / agent days: 2h / 3d

## Idea
Replace the fixed free pool ($100 a month and $5 a day shared by every free user, set by
`AI_FREE_MONTHLY_USD` and `AI_FREE_DAILY_USD`) with stage-based capacity that grows with forecast
installs. The deliverables are a reserve formula, a weekly reforecast during launch, and separate
cost tracking for anonymous, verified, welcome and passive Echo usage.

## Pros
- Protects the Coach demonstration during Q5, when the free pool would otherwise go dark mid-month.
- Makes the subsidy a planned number instead of a surprise refusal.
- Separate cohort tracking stops welcome spend being counted twice in contribution.
- Lets the $1 welcome grant be sized to what is funded.

## Cons
- More subsidy, and more exposure to abuse of anonymous installations.
- A forecast built on cohort means can still be wrong in launch week.
- Passive Echo cost grows with signed-in writers whether or not they ever pay.
- The daily ceiling must track peak days, not an average, or launch days fail first.

## Estimates
| Item | Estimate |
|---|---|
| Formula | reserve = 1.5 × forecast total cost of verified, anonymous and incremental welcome usage, on arithmetic means, each cohort estimated separately |
| Daily ceiling | sized to forecast peak-day demand, not the monthly budget divided by 30 |
| Cadence | reforecast weekly from Dec 20, 2026 through Jan 15, 2027 |
| Welcome grant | 1,000 fully redeemed $1 grants cost $1,000; the eligible cohort must fit funded capacity before any offer is made |
| Effort | 2 CEO hours approving reserves; 3 agent days for configuration, the ledger split and the alert |

The fixed pool saturates at 400 verified accounts each using their full $0.25. A launch bringing
2,000 installs would exhaust it in the first half of the month.

## Success metric
Fewer than 1% of otherwise-eligible AI requests refused for global-budget exhaustion on every day
through Jan 15, 2027.

## Failure metric
More than 1% refused on any single day. Acquisition pauses the same day until capacity is corrected
and the reforecast is approved.

## Justification
The Coach demonstration is the paid wedge's whole argument, and a refusal in the first session is the
same as no product. Free use cannot drain paid grants, but it can drain itself. Means are used rather
than medians because a population split between $2.99 and $6.99 spenders averages $4.95 while its
median hides half the cost (agreed in negotiation round two). This report also settles whether the
advertised Tend counts (30 requests free, 300 on One) can be fulfilled inside the USD allowance; a
count we cannot honour is a number we do not have. The alternative, keeping the fixed pool and
hoping, trades the launch window for $100 a month.

## Dependencies
- Report 02's costed sample for the per-task means.
- Install forecasts from reports 08, 09, 11 and 12 as each starts.
- Alert email to `AI_ALLOWANCE_ALERT_EMAIL` wired to the Monday review.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
