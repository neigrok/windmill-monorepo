# Evidence for marketing decisions

Evidence reviewed November 12, 2026. Use Windmill's cohorts to decide where to spend. The comparisons below explain why an experiment is worth running and which assumptions would change the decision.

## What Windmill can demonstrate

| Claim | Evidence | Marketing use |
|---|---|---|
| The public site exposes 11 canonical sitemap URLs. The November 12 live check found HTTP 200 and the expected canonical on all 11. | [Production sitemap](https://windmill.works/sitemap.xml) · [Build source](../../web/scripts/build-landing-shells.mjs) | Establish an engine-by-engine coverage baseline. A sitemap entry alone establishes discovery eligibility. |
| The signed-out public gallery links a playable “Learn to sail” example. Ship v1 is a Windmill-authored starter with prerequisites. | [Gallery](https://windmill.works/gallery) · [Ship v1 source](../../web/src/products/roadmap/quests/roster/shipV1.js) | Demonstrate the first meaningful step with an original asset. A published tree and an unlisted share have different visibility. |
| A connected external assistant can use granted Roadmap and Gym tools. New routines and proposed edits to an existing routine behave differently. | [Connect](https://windmill.works/connect.html) · [Product strategy](../PRODUCT_LOG.md) | Show one product and the minimum grant the example uses. Ordinary external MCP operations use the assistant's model budget. |
| Native apps own Gym workout entry. The signed-in browser provides planning, history, a mirror and Coach. iOS carries Gym and Journal, Android carries Gym. | [Web Gym](../../web/src/products/gym/README.md) · [iOS distribution](../../apps/ios/App/README.md) · [Android distribution](../../apps/android/README.md) | Recruit lifters who can use TestFlight or a signed Android APK, and verify the actual build. A public store listing requires its own live evidence. |
| Checkout is closed. The enabled production policy meters hosted AI in USD. Tend has no separate request quota, automatic Echoes draw on the same individual allowance, and Talk transcription is refused pending audio accounting. | [Checkout switch](../../web/src/shell/billing/checkout.js) · [Enabled policy](../AI_USAGE_REVIEW.md) | Talk, available paid subscriptions and fixed task-count promises stay out of launch creative. |
| Existing aggregate SQL measures account-backed Roadmap activation, forks and returns. | [Funnel definitions](../../backend/db/FUNNEL.md) | Keep native pilot observations, unauthenticated visits, external-agent use and global account totals distinguishable. |

## What a customer might already use

| Customer's alternative | What the publisher actually offers | What to learn in a Windmill interview |
|---|---|---|
| A to-do list, or roadmap.sh for a developer learning path | roadmap.sh offers community roadmaps and guides by role or skill and supports AI creation. [Product](https://roadmap.sh/) | Does editing prerequisites and returning to the next open step help someone ship their own project? Ask them to show how they chose yesterday's task. |
| A spreadsheet, Hevy, or Fitbod | Hevy offers routine building, logging and social progress. Fitbod describes workouts personalised to goals, fitness level and equipment. [Hevy](https://www.hevyapp.com/) · [Fitbod](https://fitbod.me/) | Which record does a lifter open at the next session? If they already have a program, ask when they last had to change it and what work that took. |
| A notes app or Day One | Day One supports daily journaling and resurfacing past entries. [Product](https://dayoneapp.com/) | Can a writer find something they wanted to remember? Ask about the retrieval experience without collecting the entry. |

These are examples of alternatives a person can name. Verify features, platforms, prices and plan terms again before publishing a comparison. Competitors' reported traffic and installs do not provide Windmill's reachable audience.

## What the numbers support

| Input | Evidence level | Decision it informs |
|---|---|---|
| Median day-35 download-to-paid was 2.1% for freemium apps and 2.9% for Health & Fitness apps in RevenueCat's 2026 dataset. These are distinct groupings. | Vendor's primary aggregate, among apps in its dataset. [2026 report](https://www.revenuecat.com/state-of-subscription-apps-2026/) | Paid acquisition can become expensive quickly. These are context for a future open checkout, never forecasts for beta testers or web visitors. |
| Sensor Tower reports US Health & Fitness downloads typically more than 20% above their annual average between Christmas and mid-January. | Vendor's US category estimate, June 2025. [Seasonality research](https://sensortower.com/blog/state-of-mobile-tiktok-edition-momentum-beyond-q5) | Label a holiday cohort and repeat outside that period before using its response to forecast an ordinary month. |
| Apple's Small Business Program offers a 15% commission to eligible enrolled developers. | Platform terms. Windmill's enrollment is unverified. [Apple](https://developer.apple.com/app-store/small-business-program/) | Verify actual fees by channel before setting any bid. |
| A verified free account has a $0.50 monthly individual limit. Anonymous installation access has $0.25 lifetime, with shared free ceilings of $5/day and $100/month. A funded One period has $7 available. | Implemented policy, with reservations and settlement. [Accounting contract](../../backend/AI_ALLOWANCES.md) | Full monthly free usage by 200 verified accounts equals the $100 pool before other free use. This is capacity arithmetic, not a user or demand forecast. |
| 20 Roadmap starters, 10 enrolled native lifters, eight founder hours/week, $0 incremental first-month cash. | Proposed operating assumptions. [Plan and gates](strategy.md) | Log actual intake, time, variable AI cost and the reason a person stopped. Revisit after the second cohort. |

## Economics of a later paid test

**Fully loaded CAC** is acquisition cash plus valued founder time and content production, divided by unique non-refunded acquired payers. Use $100/hour as a disclosed planning assumption and show the cash-only number beside it. If there are no buyers, report the cost and zero buyers. CAC is undefined.

**Realised C90 per payer** is revenue collected across a mature 90-day cohort, net of refunds, taxes, actual store or payment fees, hosted AI for paying users, the allocated free usage from the same acquisition cohort, and variable support and storage, divided by the same non-refunded payer count. Count shared costs once. Note whether a cost is observed or allocated. A sign-up using two products is still one payer.

At a hypothetical $12/month and a hypothetical 15% fee, $10.20 remains before taxes and refunds. Full use of a $7 funded allowance leaves $3.20 before other costs. At a hypothetical $15 allowable CAC and 2% install-to-paid, the media ceiling is at most $0.30 per install before non-media acquisition cost. At 40% tap-to-install, the corresponding ceiling is $0.12 per tap. Substitute observed channel-specific rates and the remaining media budget before using a bid. [Apple Ads brief](reports/14-apple-ads-test.md)

The next decisions depend on founder hours per returning user, retention on an independently recruited cohort, task cost including failed hosted calls, checkout conversion at a real offer, renewal, and the share of returning people traceable to a search or assistant referral. Record the source, denominator, time window and collection method for each. Search volume, an AI answer mentioning the brand and a directory acceptance cannot fill these cells.
