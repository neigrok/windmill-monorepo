# 04 · Gym demonstration and real checkout

Kind: build · Stage: 0 · Window: Nov 23 to Dec 7, 2026 · Cash: $0 to $100 · CEO hours / agent days: 3h / 4d

## Idea
Give marketing a purchasable product and one concrete job to show. Two deliverables: Windmill One
on sale through a controlled web pilot by Nov 23, 2026, with native purchases working at the store
releases; and a Gym landing whose live hero vignette plays the real job, a program screenshot
becoming a proposed routine the lifter applies, with every manual alternative preserved.

## Pros
- Visitors see saved work, not a feature list.
- Checkout on real money is what reports 02 and 08 need to measure.
- Web checkout through Paddle keeps more of the $12 than a store purchase.
- One job per landing keeps the other products discoverable without asking a visitor to understand all three.

## Cons
- A setup-only demonstration can attract one-time buyers who leave after the routine exists.
- Native purchase, restore and cross-platform entitlement each have their own failure modes.
- The landing hero is new visual work and waits on an approved Figma design.
- Twenty observed users is direction, not proof.

## Estimates
| Item | Estimate |
|---|---|
| Cash | $0 to $100 of AI spend across the observed sessions (assumption) |
| Effort | 3 CEO hours observing users; 4 agent days for checkout, entitlement and the vignette |
| Checkout | `paidPlansOpen()` in `web/src/shell/billing/checkout.js` returns true for the pilot, and the server has a configured Paddle price id |
| Outcome | 20 observed people, each handed a real program and asked to set it up without help |

## Success metric
At least 80% of 20 observed users complete their first valid Coach task unaided by Dec 7, 2026.

## Failure metric
Fewer than 60% complete it unaided. The demonstration is fixed before any creator traffic is sent
(report 09 stays in preflight).

## Justification
The negotiation chose Gym Coach as the first paid-demand test because a lifter with a program has a
job worth paying for and a reason to return; comparable coach apps charge $12.99 to $15.99 a month
while log-only apps charge $2.99 to $4.99 (App Store pricing, 2026). Demand cannot be read without a
checkout, and the brand's landing rule requires a live vignette rather than a screenshot. Productivity
and fitness apps see more than 60% of conversions in week one and about half on day zero (RevenueCat,
2026), so the first session must carry the whole argument. The alternative, marketing a product that
cannot be bought, was rejected in round one.

## Dependencies
- Report 02's billing scenarios reconciled before the pilot opens to anyone outside the team.
- The landing vignette and any checkout surface approved in Figma before an agent implements them.
- Apple Small Business Program enrollment confirmed by the CEO.
- Report 01's store listings for native purchases.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
