# 14 · Price an Apple Ads tap before buying one

**Deferred paid-search option.** Consider only after an iOS public listing leads to a verified install,
the owner opens and funds a paid pilot, paid conversions can be reconciled, and a slot and capped learning
budget are approved. Check a matching product page and independently test attribution. Current spend is $0.
[Store readiness](01-store-readiness.md) · [Payment prerequisites](04-gym-demo-and-checkout.md)

**Calculate the ceiling.** For the same source, region and mature cohort, define install-to-payer as net new
acquired payers divided by attributed first-time installs. Define tap-to-install as attributed first-time
installs divided by taps. Use contribution after provider costs, fees, refunds and other variable costs.
Deduct the per-payer share of non-media acquisition costs from the fully loaded CAC ceiling before
allocating a media bid.

```text
allowable media CAC per payer = allowable fully loaded CAC − non-media acquisition cost per payer
allowable CPI = allowable media CAC × install-to-payer
allowable CPT = allowable media CAC × install-to-payer × tap-to-install
```

For illustration, $20 available for media per payer × 5% install-to-payer × 40% tap-to-install gives **$0.40
per tap**. If a rate is unknown, use a clearly labelled sensitivity range and keep spend at zero until the
owner explicitly funds learning that rate. A nonpositive media allowance rules out bidding.

**Run only after the gates pass.** Start with a single nonbrand intent such as “workout log” using exact
match and a Gym page. Apple exact match can include close variants, so review actual search terms. Apple's
max CPT caps the price of a tap. Predeclare a total budget, acquisition window and maturation date. Record
taps, first-time installs, repeat workouts, net payers, cost and unknown attribution.
[Apple match types](https://ads.apple.com/app-store/help/keywords/0059-understand-keyword-match-types) ·
[Apple max CPT bidding](https://ads.apple.com/app-store/help/bids-and-budget/0062-set-and-adjust-bids)

Stop at the cap or if the observed bid and conversion rates cannot meet the ceiling. Zero mature payers
yields no finite observed CAC. With sparse purchases, document the range of plausible outcomes. Increase
spend only after successive mature cohorts meet the fully loaded CAC versus realized C90 rule.
[Investment gates](../strategy.md)
